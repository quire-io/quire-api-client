/**
 * Live API tests for the task approval workflow (TA1-TA6).
 *
 * Apr 27 2026 contract: state and category live in query parameters, not
 * the body. `?return=compact` returns `{oid, id}` (was `{oid}` only).
 *
 * Shape summary:
 *   - POST /task/approve/{oid}?state=…[&category=…] — state is required;
 *     category defaults to "" (implicit default category).
 *   - Default response: the Approval object — { category, state, requester,
 *     approver?, toggledAt }. requester / approver are bare OID strings,
 *     not nested objects. May 1 2026 added requesterRef / approverRef
 *     { oid, id } companions.
 *   - ?return=compact response: { oid, id } only (the task identifiers).
 *   - DELETE /task/revoke-approval/{oid} always returns 204 + empty body.
 *     Rolls approved/rejected → awaiting, clears awaiting → no-approval,
 *     idempotent no-op on a task with no approval.
 *   - After full revoke, GET /task/{oid} omits the `approval` key entirely.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type {
  QuireApproval,
  QuireTask,
  QuireUser,
} from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/approve + /revoke-approval", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let taskOid = "";
  let taskId = 0;
  let me: QuireUser;

  beforeAll(async () => {
    me = await client.getMe();
    const created = await client.createTask(PROJECT_OID, {
      name: `${runTag}-approval-task`,
    });
    taskOid = created.oid;
    taskId = created.id;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("TA1 approveTask({state:'request'}) creates an awaiting approval", async () => {
    const approval = (await client.approveTask(taskOid, {
      state: "request",
    })) as QuireApproval & {
      requesterRef?: { oid: string; id: string };
      approverRef?: { oid: string; id: string };
      requester?: string;
      approver?: string;
    };
    expect(approval.state).toBe("awaiting");
    expect(approval.category).toBe(""); // implicit default
    expect(approval.requester).toBe(me.oid);
    expect(approval.approver).toBeUndefined();
    expect(approval.toggledAt).toBeTruthy();
    expect(approval.requesterRef).toEqual({ oid: me.oid, id: me.id });
    expect(approval.approverRef).toBeUndefined();
  });

  it("TA2 approveTask({state:'approve'}) transitions awaiting → approved", async () => {
    const approval = (await client.approveTask(taskOid, {
      state: "approve",
    })) as QuireApproval & {
      requesterRef?: { oid: string; id: string };
      approverRef?: { oid: string; id: string };
      requester?: string;
      approver?: string;
    };
    expect(approval.state).toBe("approved");
    expect(approval.requester).toBe(me.oid);
    expect(approval.approver).toBe(me.oid);
    expect(approval.requesterRef).toEqual({ oid: me.oid, id: me.id });
    expect(approval.approverRef).toEqual({ oid: me.oid, id: me.id });
  });

  it("TA3 revokeTaskApproval rolls approved back to awaiting; identity fields preserved", async () => {
    await client.revokeTaskApproval(taskOid);

    const got = (await client.getTask(taskOid)) as QuireTask & {
      approval?: QuireApproval & {
        requesterRef?: { oid: string; id: string };
        approverRef?: { oid: string; id: string };
        requester?: string;
        approver?: string;
      };
    };
    expect(got.approval?.state).toBe("awaiting");
    expect(got.approval?.requester).toBe(me.oid);
    // approver is audit-trail (who last approved) — preserved on rollback.
    expect(got.approval?.approver).toBe(me.oid);
    expect(got.approval?.requesterRef).toEqual({ oid: me.oid, id: me.id });
    expect(got.approval?.approverRef).toEqual({ oid: me.oid, id: me.id });
  });

  it("TA4 revokeTaskApproval clears from awaiting (approval key absent on GET)", async () => {
    await client.revokeTaskApproval(taskOid);

    const got = (await client.getTask(taskOid)) as QuireTask & {
      approval?: QuireApproval;
    };
    // Cleared — `approval` key is absent, not null.
    expect(got.approval).toBeUndefined();
  });

  it("TA5 revokeTaskApproval is idempotent on a task with no active approval", async () => {
    // No throw expected — second revoke on a clean task returns 204.
    await client.revokeTaskApproval(taskOid);
  });

  // Compact return form isn't exposed on `approveTask` — drop to rawApi to
  // verify the {oid, id} response shape.
  it("TA6 POST /task/approve?return=compact returns {oid, id}", async () => {
    const res = await rawApi<{ oid: string; id: number }>(
      "POST",
      `/task/approve/${taskOid}?state=request&return=compact`,
    );
    expect(res.status).toBe(200);
    expect(res.data.oid).toBe(taskOid);
    expect(res.data.id).toBe(taskId);
    expect((res.data as Record<string, unknown>).state).toBeUndefined();
    expect((res.data as Record<string, unknown>).category).toBeUndefined();

    // Tear back down so afterAll's DELETE doesn't trip on a half-state.
    await client.revokeTaskApproval(taskOid);
  });
});

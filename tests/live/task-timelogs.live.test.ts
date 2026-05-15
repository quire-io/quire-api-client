/**
 * Live API tests for task timelogs (TL1-TL5).
 *
 * All three endpoints share an identity triple (user, start, end). Sub-
 * second precision is truncated to whole seconds server-side; the response
 * always echoes `.000Z`-form timestamps. All three return HTTP 200 with the
 * task's full timelogs array (empty when no logs remain).
 *
 * Shape:
 *   - Element: { start, end, user: { oid, ... }, note?, billable? }
 *   - billable defaults to true on add; the response only emits the key
 *     when value is true (false is implicit absence).
 *   - user defaults to the caller; explicit user accepts OID / id / email.
 *
 * Covers the happy-path round-trip (TL1-TL4) plus the 409 duplicate guard
 * (TL2). Negative cases (end<start, missing param, 404 on missing log) are
 * out-of-scope.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireUser } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — task timelogs", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let me: QuireUser;
  let taskOid = "";

  // Fixed timestamps so identity-triple operations don't need to compute
  // them inline.
  const start1 = "2026-04-26T09:00:00.000Z";
  const end1 = "2026-04-26T10:30:00.000Z";
  const start1New = "2026-04-26T10:00:00.000Z";
  const end1New = "2026-04-26T11:30:00.000Z";

  beforeAll(async () => {
    me = await client.getMe();
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tl-task`,
    });
    taskOid = t.oid;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("TL1 addTaskTimelog defaults user to caller and returns the array", async () => {
    const logs = await client.addTaskTimelog(taskOid, {
      start: start1,
      end: end1,
      note: "first log",
    });
    expect(Array.isArray(logs)).toBe(true);
    const ours = logs.find((l) => l.start === start1 && l.end === end1);
    expect(ours).toBeDefined();
    expect(ours!.user.oid).toBe(me.oid);
    expect(ours!.note).toBe("first log");
    expect(ours!.billable).toBe(true);
  });

  // Duplicate guard returns 409. QuireClient throws on 4xx, which hides the
  // status, so drop to rawApi.
  it("TL2 POST /task/add-timelog with the same (user,start,end) → 409", async () => {
    const res = await rawApi<{ code: string; message: string }>(
      "POST",
      `/task/add-timelog/${taskOid}`,
      { start: start1, end: end1, note: "duplicate attempt" },
    );
    expect(res.status).toBe(409);
  });

  it("TL3 updateTaskTimelog updates the note while preserving user", async () => {
    const logs = await client.updateTaskTimelog(
      taskOid,
      { start: start1, end: end1 },
      { note: "first log (updated)" },
    );
    const ours = logs.find((l) => l.start === start1 && l.end === end1);
    expect(ours).toBeDefined();
    expect(ours!.note).toBe("first log (updated)");
    expect(ours!.user.oid).toBe(me.oid);
  });

  it("TL4 updateTaskTimelog can replace the times in place", async () => {
    const logs = await client.updateTaskTimelog(
      taskOid,
      { start: start1, end: end1 },
      { start: start1New, end: end1New },
    );
    const oldGone = !logs.some((l) => l.start === start1 && l.end === end1);
    const newPresent = logs.some(
      (l) => l.start === start1New && l.end === end1New,
    );
    expect(oldGone).toBe(true);
    expect(newPresent).toBe(true);
  });

  it("TL5 removeTaskTimelog removes and returns the remaining array", async () => {
    const logs = await client.removeTaskTimelog(taskOid, {
      start: start1New,
      end: end1New,
    });
    expect(Array.isArray(logs)).toBe(true);
    expect(
      logs.some((l) => l.start === start1New && l.end === end1New),
    ).toBe(false);
  });
});

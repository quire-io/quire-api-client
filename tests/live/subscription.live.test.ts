/**
 * Live API tests for subscription / plan gating (SUB1-SUB7).
 *
 * Characterizes what Quire actually returns for the `subscription` field
 * and how paid-only endpoints fail on free-plan callers. Several cases use
 * rawApi rather than the QuireClient wrapper so we can keep the failing
 * status code (the wrapper throws on 4xx, masking the discriminator).
 *
 * Pins the wrapped-quota 429+469 shape (SUB7) so a Quire-side change to
 * the error wrapping fails loudly here instead of silently regressing
 * formatQuireError's mapping.
 *
 * Requires QUIRE_TEST_FREE_ORG_ID and QUIRE_TEST_PAID_ORG_ID env vars.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { QuireProject } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — subscription / plan gating", () => {
  const client = liveClient();
  const FREE_ORG_ID = readEnv("QUIRE_TEST_FREE_ORG_ID");
  const PAID_ORG_ID = readEnv("QUIRE_TEST_PAID_ORG_ID");

  let freeOid = "";
  let paidOid = "";

  beforeAll(async () => {
    freeOid = (await client.getOrganizationById(FREE_ORG_ID)).oid;
    paidOid = (await client.getOrganizationById(PAID_ORG_ID)).oid;
  });

  // SUB1/SUB2 — characterize `subscription` shape across plans. Log the
  // raw object so we can tighten the type and drive error enrichment in
  // formatQuireError.
  it("SUB1 free org exposes a subscription with a plan string", async () => {
    const org = await client.getOrganization(freeOid);
    console.log("[free org] subscription:", org.subscription);
    expect(org.subscription).toBeDefined();
    expect(typeof org.subscription?.plan).toBe("string");
  });

  it("SUB2 paid org exposes a subscription with a plan string", async () => {
    const org = await client.getOrganization(paidOid);
    console.log("[paid org] subscription:", org.subscription);
    expect(org.subscription).toBeDefined();
    expect(typeof org.subscription?.plan).toBe("string");
  });

  // SUB3 — free-plan callers get rejected from /task/search-organization.
  // QuireClient throws on 4xx and erases the status, so use rawApi. Log
  // the raw shape so formatQuireError can distinguish plan-gated from
  // scope/auth failures.
  it("SUB3 free org /task/search-organization is rejected", async () => {
    const res = await rawApi<unknown>(
      "GET",
      `/task/search-organization/${freeOid}?text=mcp-plan-probe`,
    );
    console.log("[free org search-organization]", {
      status: res.status,
      body: typeof res.data === "string" ? res.data.slice(0, 300) : res.data,
    });
    expect(res.status).not.toBe(200);
  });

  it("SUB4 paid org /task/search-organization returns 200", async () => {
    const hits = await client.searchTasksInOrganization(paidOid, {
      text: "mcp-plan-probe-unlikely",
    });
    expect(Array.isArray(hits)).toBe(true);
  });

  // /task/search-folder/ resource-checks BEFORE plan-gating: a bogus folder
  // OID returns 404, not 403. formatQuireError keeps this path OFF the
  // paid-only list so a 404 isn't misflagged. If this ever flips to 403,
  // revisit that decision.
  it("SUB5 /task/search-folder bogus oid returns 404 (resource-first)", async () => {
    const res = await rawApi<unknown>(
      "GET",
      `/task/search-folder/oid_mcp_plan_probe_nonexistent?text=x`,
    );
    expect(res.status).toBe(404);
  });

  // `limit=no` on /task/search requires the paid qoApiSearchLimit quota.
  // Free-plan rejection has two known shapes (server-side gating drift):
  //   - 402 + JSON {code:469,message:...}
  //   - 403 + bare HTML (older deployments)
  // formatQuireError handles both. This test pins the contract envelope.
  it("SUB6 free project /task/search?limit=no is plan-gated", async () => {
    const projects = (await rawApi<QuireProject[]>(
      "GET",
      `/project/list/${freeOid}`,
    )).data;
    if (!projects?.length) {
      console.log(
        "[SUB6] skipping — free org has no projects to probe against",
      );
      return;
    }
    const projectOid = projects[0]!.oid;

    const res = await rawApi<unknown>(
      "GET",
      `/task/search/${projectOid}?text=x&limit=no`,
    );
    expect([402, 403]).toContain(res.status);
  });

  // SUB7 — Pins the wrapped-quota shape returned by POST /insight on a
  // free-plan project:
  //   HTTP 429 + JSON { code: 469, message: "Unable to perform … quota …" }
  //
  // Originally reported as OAuth/scope failure by an AI assistant — the
  // real cause was plan gating, but Quire wraps `ecQuotaExceeded` (internal
  // code 469) inside HTTP 429 (not HTTP 469 as you'd guess from the code).
  // formatQuireError detects this shape; this test guards against a Quire-
  // side change to the wrapping silently regressing the LLM-facing error
  // text.
  //
  // helpers.ts's rawApi peeks at the JSON body on 429 and short-circuits
  // the retry loop when `code === 469`, so this resolves immediately on
  // the wrapped-quota response.
  it("SUB7 free project POST /insight is wrapped quota (429 + body code 469)", async () => {
    const projects = (await rawApi<QuireProject[]>(
      "GET",
      `/project/list/${freeOid}`,
    )).data;
    if (!projects?.length) {
      console.log(
        "[SUB7] skipping — free org has no projects to probe against",
      );
      return;
    }
    const projectOid = projects[0]!.oid;

    const res = await rawApi<{
      code?: number;
      message?: string;
      oid?: string;
    }>("POST", `/insight/${projectOid}`, { name: "mcp-plan-probe-insight" });
    console.log("[SUB7 free POST /insight]", {
      status: res.status,
      body: res.data,
    });
    if (res.status === 200 && res.data?.oid) {
      // Best-effort cleanup if create somehow slipped through.
      await client.deleteInsight(res.data.oid).catch(() => {});
    }
    expect(res.status).toBe(429);
    expect(res.data?.code).toBe(469);
    expect(res.data?.message).toMatch(/quota|insight/i);
  });
});

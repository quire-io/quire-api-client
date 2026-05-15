/**
 * Live API tests for error-response shapes (E1-E5, RL1).
 *
 * These are explicit non-2xx assertions, so most go through `rawApi` /
 * `rawApiAs` — QuireClient throws on 4xx, which hides the status code.
 *
 * RL1 is a rate-limit probe that bursts /api/user/me in parallel batches
 * until the first 429, then snapshots the response headers. The
 * `retry-after` assertion is intentionally a reverse-pin: it's expected
 * to fail until Quire ships an upstream fix to include Retry-After per
 * RFC 9110 §15.5.5. When the fix lands the test flips green automatically.
 */

import { describe, it, expect } from "vitest";
import { hasTokens, rawApi, rawApiAs, readEnv } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — error responses", () => {
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  it("E1 GET /task/{bogus} → 404", async () => {
    const { status } = await rawApi("GET", "/task/oid_does_not_exist");
    expect(status).toBe(404);
  });

  it("E2 PUT /project/{bogus} → 404", async () => {
    const { status } = await rawApi(
      "PUT",
      "/project/oid_does_not_exist",
      { addFollowers: [] },
    );
    expect(status).toBe(404);
  });

  // Quire's DELETE is idempotent — deleting something that doesn't exist
  // returns 204, not 404. Callers cannot distinguish "deleted now" from
  // "never existed" on this endpoint.
  it("E3 DELETE /tag/{bogus} → 204 (idempotent)", async () => {
    const { status } = await rawApi("DELETE", "/tag/oid_does_not_exist");
    expect([200, 204]).toContain(status);
  });

  it("E4 GET /user/id/me with a bogus bearer → 401", async () => {
    const { status } = await rawApiAs(
      "GET",
      "/user/id/me",
      undefined,
      "totally-fake-token",
    );
    expect(status).toBe(401);
  });

  // Probe: does Quire distinguish a plausibly-shaped (but unknown / revoked)
  // bearer from a garbage string? If both return the same 401 with the
  // same body shape, a 401-recovery handler has to treat every 401 as
  // "token no longer valid" and force re-auth.
  it("E4b plausible-shaped unknown token → same 401 as a bogus string", async () => {
    const bogus = await rawApiAs<string>(
      "GET",
      "/user/id/me",
      undefined,
      "totally-fake-token",
    );
    const plausible = await rawApiAs<string>(
      "GET",
      "/user/id/me",
      undefined,
      "qa_revoked_0000000000000000",
    );
    expect(bogus.status).toBe(401);
    expect(plausible.status).toBe(401);
    expect(typeof plausible.data).toBe(typeof bogus.data);
  });

  // Quire returns 403, not 401, when no Authorization header is present.
  // (Upstream MCP server translates this into a WWW-Authenticate challenge.)
  it("E5 GET without Authorization header → 403 (not 401)", async () => {
    const a = await rawApiAs("GET", "/user/id/me", undefined, undefined);
    const b = await rawApiAs("GET", `/project/${PROJECT_OID}`, undefined, undefined);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });

  // Rate-limit response-shape probe. Bursts GET /api/user/me in PARALLEL
  // batches until the first 429 to snapshot the headers Quire emits.
  // Concurrency-sensitive (not sustained-rate-sensitive) — 50 in flight
  // reliably trips the limiter under any plan tier.
  //
  // Uses raw fetch directly so the helper's 429-retry-with-backoff doesn't
  // drain the headers we want to inspect.
  it("RL1 GET /user/me burst → capture 429 response headers", async () => {
    const base = (readEnv("QUIRE_API_SERVER") || "").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${readEnv("QUIRE_TEST_ACCESS_TOKEN")}`,
    };
    const BATCH_SIZE = 50;
    const MAX_BATCHES = 4;

    let triggered: { status: number; headers: Record<string, string> } | null =
      null;
    let totalRequests = 0;
    for (let b = 0; b < MAX_BATCHES && triggered === null; b++) {
      const responses = await Promise.all(
        Array.from({ length: BATCH_SIZE }, () =>
          fetch(`${base}/api/user/me`, { headers }),
        ),
      );
      totalRequests += BATCH_SIZE;
      const first429 = responses.find((r) => r.status === 429);
      if (first429) {
        const all: Record<string, string> = {};
        first429.headers.forEach((v, k) => {
          all[k.toLowerCase()] = v;
        });
        triggered = { status: 429, headers: all };
      }
    }

    expect(
      triggered,
      `no 429 hit within ${totalRequests} parallel requests; rate limit not triggered — bucket may have reset or quota tier raised, retry the test`,
    ).not.toBeNull();

    console.warn(
      `[RL1] 429 response headers (after ${totalRequests} parallel requests):\n${JSON.stringify(triggered!.headers, null, 2)}`,
    );

    // Reverse-pin: expected to fail until Quire ships the upstream fix to
    // include Retry-After on 429 per RFC 9110 §15.5.5. When that lands,
    // this flips green and serves as a regression guard.
    expect(
      triggered!.headers["retry-after"],
      "RFC 9110 §15.5.5: 429 responses SHOULD include a Retry-After header. Filed upstream against zkoss/boeneo.",
    ).toBeDefined();
  });
});

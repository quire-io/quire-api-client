/**
 * Live API tests for /partner (PT1, PT2).
 *
 * Read-only — the partner write endpoints aren't exposed by the public
 * Quire API. Requires at least one partner configured on the test project
 * via the Quire web UI.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { QuirePartner } from "../../src/index.js";
import { hasTokens, liveClient, readEnv } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /partner", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let partners: QuirePartner[] = [];
  let first: QuirePartner | undefined;

  beforeAll(async () => {
    partners = await client.listPartners(PROJECT_OID);
    first = partners[0];
  });

  it("PT1 listPartners returns at least one partner on the test project", () => {
    expect(partners.length).toBeGreaterThanOrEqual(1);
    for (const p of partners) {
      expect(p.oid).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.project?.oid).toBe(PROJECT_OID);
    }
  });

  it("PT2 getPartner returns the same partner as listed", async () => {
    if (!first) throw new Error("PT1 must have populated at least one partner");
    const got = await client.getPartner(first.oid);
    expect(got.oid).toBe(first.oid);
    expect(got.name).toBe(first.name);
    expect(got.project?.oid).toBe(PROJECT_OID);
  });
});

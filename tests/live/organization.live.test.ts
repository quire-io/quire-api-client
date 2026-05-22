/**
 * Live API tests for /organization (O1-O6).
 *
 * There is no /organization create endpoint — every mutation lands on the
 * shared test org. O4 (followers) is safely reversible. O5 (name +
 * description) is only run against a separate throwaway org configured via
 * QUIRE_TEST_FREE_ORG_ID, since changing the test org's displayed name
 * affects every workspace member. O6 (rate limit) is read-only and free.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { QuireOrganization } from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  readEnv,
  readEnvOptional,
  retryOn429,
  runTag,
} from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /organization", () => {
  const client = liveClient();
  const ORG_OID = readEnv("QUIRE_TEST_ORG_OID");

  let orgs: QuireOrganization[] = [];
  let testOrg: QuireOrganization | undefined;

  beforeAll(async () => {
    orgs = await client.listOrganizations();
    testOrg = orgs.find((o) => o.oid === ORG_OID);
    if (!testOrg) {
      throw new Error(
        `Test org ${ORG_OID} not in listOrganizations() — check QUIRE_TEST_ORG_OID.`,
      );
    }
  });

  it("O1 listOrganizations returns at least one org", () => {
    expect(orgs.length).toBeGreaterThanOrEqual(1);
    expect(orgs.every((o) => typeof o.oid === "string" && o.oid.length > 0)).toBe(true);
  });

  it("O2 getOrganizationById matches the oid from listOrganizations", async () => {
    if (!testOrg?.id) {
      throw new Error("Test org has no human-readable id");
    }
    const got = await client.getOrganizationById(testOrg.id);
    expect(got.oid).toBe(testOrg.oid);
  });

  it("O3 getOrganization (oid form) matches the oid from listOrganizations", async () => {
    const got = await client.getOrganization(ORG_OID);
    expect(got.oid).toBe(ORG_OID);
  });

  it("O4 updateOrganization adds then removes a follower", async () => {
    const me = await client.getMe();
    const baseline = await client.getOrganization(ORG_OID);
    const wasFollower = (baseline.followers ?? []).some(
      (f) => f.oid === me.oid,
    );

    const added = await client.updateOrganization(ORG_OID, {
      addFollowers: [me.oid],
    });
    expect((added.followers ?? []).some((f) => f.oid === me.oid)).toBe(true);

    const removed = await client.updateOrganization(ORG_OID, {
      removeFollowers: [me.oid],
    });
    expect((removed.followers ?? []).some((f) => f.oid === me.oid)).toBe(false);

    // Restore pre-test membership if the user was already a follower.
    if (wasFollower) {
      await client.updateOrganization(ORG_OID, { addFollowers: [me.oid] });
    }
  });

  // Separate throwaway org so the main test org's displayed name isn't
  // touched. Skips cleanly when QUIRE_TEST_FREE_ORG_ID isn't set.
  const FREE_ORG_ID = readEnvOptional("QUIRE_TEST_FREE_ORG_ID");
  it.skipIf(!FREE_ORG_ID)(
    "O5 updateOrganization edits name + description on the free test org",
    async () => {
      // Wrap with retryOn429 — SUB7 in subscription.live.test.ts intentionally
      // burns the free org's minute bucket; if vitest schedules that file
      // immediately before this one, these calls hit a real 429 with a
      // ~13s retry-after.
      const baseline = await retryOn429(() =>
        client.getOrganizationById(FREE_ORG_ID!),
      );
      const newName = `${baseline.name} [${runTag}]`;
      const newDescription = `Touched by ${runTag}`;
      try {
        const put = await retryOn429(() =>
          client.updateOrganization(baseline.oid, {
            name: newName,
            description: newDescription,
          }),
        );
        expect(put.nameText ?? put.name).toBe(newName);
        expect(put.descriptionText ?? put.description).toBe(newDescription);
        // editedAt landed on the response in the same Apr 22 2026 release.
        expect(typeof put.editedAt).toBe("string");
      } finally {
        await retryOn429(() =>
          client.updateOrganization(baseline.oid, {
            name: baseline.name,
            description: baseline.description ?? "",
          }),
        );
      }
    },
  );

  // /rate-limit/{oid} is free (skipAppAccessLimit on the server) — running
  // this doesn't bump the shared org's counter. Path was renamed from
  // /rate_limit (deprecated, still accepted) on May 22 2026; the client
  // now hits the hyphenated form.
  it("O6 getRateLimit returns hour + minute usage buckets", async () => {
    const data = await client.getRateLimit(ORG_OID);
    expect(data.organization).toBe(ORG_OID);
    expect(typeof data.plan).toBe("string");

    for (const bucket of [data.hour, data.minute]) {
      expect(typeof bucket.limit).toBe("number");
      expect(typeof bucket.used).toBe("number");
      expect(typeof bucket.remaining).toBe("number");
      expect(typeof bucket.reset).toBe("number");
      expect(bucket.used).toBeGreaterThanOrEqual(0);
      if (bucket.limit >= 0) {
        expect(bucket.remaining).toBe(Math.max(bucket.limit - bucket.used, 0));
      }
    }
  });
});

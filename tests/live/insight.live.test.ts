/**
 * Live API tests for /insight (I1-I8) and custom-field definitions on
 * insights (IF1-IF5).
 *
 * Insights are per-owner (project, organization, folder or smart folder);
 * QuireClient's `createInsight` takes an `ownerType` parameter to switch
 * URL roots. I1-I6 exercise the project-owned path since the test project
 * OID is always present; I7 the organization-owned one.
 *
 * Insight custom fields accept only `formula` and `lookup` types — project-
 * only types (`number`, `text`, `money`, `date`) return 400. IF1-IF5
 * exercise the same five operations as the project-field surface
 * (add / update / rename / move / remove); IF2 specifically locks in the
 * "omitted keys preserve existing values" semantic that the Apr 22 2026
 * changelog called out.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireFieldDefinition, QuireInsight } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /insight", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const insightName = `${runTag}-insight`;
  let insightOid: string | undefined;

  afterAll(async () => {
    if (insightOid) await client.deleteInsight(insightOid).catch(() => {});
  });

  it("I1 createInsight under a project", async () => {
    const i = await client.createInsight("project", PROJECT_OID, {
      name: insightName,
      description: "I1 body",
    });
    expect(i.oid).toBeTruthy();
    expect(i.nameText ?? i.name).toBe(insightName);
    expect(i.owner?.oid).toBe(PROJECT_OID);
    insightOid = i.oid;
  });

  it("I2 listInsights contains the new insight", async () => {
    const list = await client.listInsights(PROJECT_OID);
    expect(list.some((i) => i.oid === insightOid)).toBe(true);
    // The owner type spelled out reaches the same list.
    const typed = await client.listInsights("project", PROJECT_OID);
    expect(typed.map((i) => i.oid)).toEqual(list.map((i) => i.oid));
  });

  it("I3 getInsight returns matching oid", async () => {
    const i = await client.getInsight(insightOid!);
    expect(i.oid).toBe(insightOid);
    expect(i.nameText ?? i.name).toBe(insightName);
  });

  it("I4 updateInsight updates name + toggles archived", async () => {
    const renamed = `${insightName}-renamed`;
    const archived = await client.updateInsight(insightOid!, {
      name: renamed,
      archived: true,
    });
    expect(archived.nameText ?? archived.name).toBe(renamed);
    expect(archived.archivedAt).toBeTruthy();

    const unarchived = await client.updateInsight(insightOid!, {
      archived: false,
    });
    expect(unarchived.archivedAt).toBeFalsy();
  });

  it("I5 deleteInsight removes it; subsequent getInsight 404s", async () => {
    await client.deleteInsight(insightOid!);
    let caught: unknown;
    try {
      await client.getInsight(insightOid!);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("I6 undoRemoveInsight restores the deleted insight and is idempotent", async () => {
    const restored = await client.undoRemoveInsight(insightOid!);
    expect(restored.oid).toBe(insightOid);

    const fresh = await client.getInsight(insightOid!);
    expect(fresh.oid).toBe(insightOid);

    const again = await client.undoRemoveInsight(insightOid!);
    expect(again.oid).toBe(insightOid);
    // afterAll cleans up.
  });

  // An owner type left out of the URL means `project`; the server does not
  // route an organization OID there by entity type, so an org's insights
  // are reachable only with the owner type spelled out.
  it("I7 an organization's insights need the owner type", async () => {
    const ORG_OID = readEnv("QUIRE_TEST_ORG_OID");
    const created = await client.createInsight("organization", ORG_OID, {
      name: `${insightName}-org`,
    });
    try {
      expect(created.owner?.oid).toBe(ORG_OID);
      const list = await client.listInsights("organization", ORG_OID);
      expect(list.some((i) => i.oid === created.oid)).toBe(true);

      const bare = await rawApi("GET", `/insight/list/${ORG_OID}`);
      expect(bare.status).toBe(404);
    } finally {
      await client.deleteInsight(created.oid).catch(() => {});
    }
  });

  // Needs a partner on the test project (see partner.live.test.ts).
  it("I8 createInsight shares it with a partner", async () => {
    const [partner] = await client.listPartners(PROJECT_OID);
    if (!partner) return;
    const created = await client.createInsight("project", PROJECT_OID, {
      name: `${insightName}-partner`,
      partner: partner.oid,
    });
    try {
      expect((created.partner as { oid?: string } | undefined)?.oid).toBe(
        partner.oid,
      );
      // Shared with an external team, so always hidden from guests.
      expect(created.private).toBeUndefined();
    } finally {
      await client.deleteInsight(created.oid).catch(() => {});
    }
  });
});

describe.skipIf(!hasTokens)("Live API — /insight/*-field", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const insightName = `${runTag}-insight-field-host`;
  const fieldA = `${runTag}-ifa`;
  const fieldARenamed = `${fieldA}-renamed`;
  const fieldB = `${runTag}-ifb`;
  let insightOid: string | undefined;

  type InsightWithFields = QuireInsight & {
    fields?: Record<string, QuireFieldDefinition>;
  };

  beforeAll(async () => {
    const created = await client.createInsight("project", PROJECT_OID, {
      name: insightName,
    });
    insightOid = created.oid;
  });

  afterAll(async () => {
    if (insightOid) {
      // Sweep any field variants left over if an assertion threw mid-flow.
      for (const name of [fieldA, fieldARenamed, fieldB]) {
        await client.removeInsightField(insightOid, name).catch(() => {});
      }
      await client.deleteInsight(insightOid).catch(() => {});
    }
  });

  it("IF1 addInsightField adds a formula field", async () => {
    expect(insightOid).toBeTruthy();
    const res = await client.addInsightField(insightOid!, {
      name: fieldA,
      type: "formula",
      formula: "1 + 1",
      resultType: "number",
    });
    expect(res.name).toBe(fieldA);
    expect(res.type).toBe("formula");
    expect(res.formula).toBe("1 + 1");
    expect(res.resultType).toBe("number");

    const got = (await client.getInsight(insightOid!)) as InsightWithFields;
    const field = got.fields?.[fieldA];
    expect(field).toBeDefined();
    expect(field!.type).toBe("formula");
    expect(field!.formula).toBe("1 + 1");
  });

  // Apr 22 2026 changelog: omitted keys preserve existing values.
  it("IF2 updateInsightField updates formula and preserves resultType", async () => {
    await client.updateInsightField(insightOid!, fieldA, { formula: "2 * 3" });

    const got = (await client.getInsight(insightOid!)) as InsightWithFields;
    const field = got.fields?.[fieldA];
    expect(field).toBeDefined();
    expect(field!.type).toBe("formula");
    expect(field!.formula).toBe("2 * 3");
    expect(field!.resultType).toBe("number");
  });

  it("IF3 renameInsightField renames the field", async () => {
    const res = await client.renameInsightField(
      insightOid!,
      fieldA,
      fieldARenamed,
    );
    expect(res.name).toBe(fieldARenamed);

    const got = (await client.getInsight(insightOid!)) as InsightWithFields;
    expect(got.fields?.[fieldARenamed]).toBeDefined();
    expect(got.fields?.[fieldA]).toBeUndefined();
  });

  it("IF4 moveInsightField reorders the field via ?before= and without it", async () => {
    await client.addInsightField(insightOid!, {
      name: fieldB,
      type: "lookup",
      lookupType: "user",
    });

    await client.moveInsightField(insightOid!, fieldB, fieldARenamed);
    // Without `before` → move to the end. Just checks the call doesn't 400.
    await client.moveInsightField(insightOid!, fieldB);
  });

  it("IF5 removeInsightField removes both fields", async () => {
    for (const name of [fieldARenamed, fieldB]) {
      await client.removeInsightField(insightOid!, name);
    }

    const got = (await client.getInsight(insightOid!)) as InsightWithFields;
    expect(got.fields?.[fieldARenamed]).toBeUndefined();
    expect(got.fields?.[fieldB]).toBeUndefined();
  });
});

// GET /insight/run/{insightOid} (May 27 2026) returns a JSON 2D array:
// row 0 is column headers, subsequent rows are one aggregated row per
// group. Project-scoped insights only; org-scoped insights 400. Status is
// applied at the SQL load layer so narrower queries cost less.
// GET /insight/run/{insightOid} (May 27 2026, #24834) returns a JSON 2D
// array: row 0 is column headers, subsequent rows are one aggregated
// row per group. Project-scoped insights only; org-scoped 400. Status
// is applied at the SQL load layer so narrower queries cost less. The
// by-OID dispatch bug in getWorkScope was tracked as #24880.
describe.skipIf(!hasTokens)("Live API — /insight/run", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const insightName = `${runTag}-insight-run`;
  let insightOid: string | undefined;

  beforeAll(async () => {
    const created = await client.createInsight("project", PROJECT_OID, {
      name: insightName,
    });
    insightOid = created.oid;
  });

  afterAll(async () => {
    if (insightOid) await client.deleteInsight(insightOid).catch(() => {});
  });

  it("IR1 runInsight returns a JSON 2D array with a header row", async () => {
    const res = await client.runInsight(insightOid!);
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res[0])).toBe(true);
    expect(res[0]!.length).toBeGreaterThan(0);
  });

  it("IR2 runInsight honors group-by=section and status=all", async () => {
    const res = await client.runInsight(insightOid!, {
      groupBy: "section",
      status: "all",
    });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  it("IR3 runInsight rejects unknown group-by with 400", async () => {
    let caught: unknown;
    try {
      await client.runInsight(insightOid!, {
        groupBy: "bogus" as "member",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/400/);
  });
});

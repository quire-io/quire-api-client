/**
 * Live API tests for /project (P1-P13), custom-field definitions
 * (PF1-PF5), and approval categories (PAC1-PAC5).
 *
 * Visibility-sensitive operations (name/description edits, public toggle)
 * run on a separate throwaway project configured via
 * QUIRE_TEST_FREE_PROJECT_ID — touching the displayed name of the shared
 * paid test project is too risky to automate. They skip cleanly when the
 * env var isn't set.
 *
 * The custom-field block exercises the full add / update / rename / move /
 * remove lifecycle. PF2 specifically pins the "omitted keys preserve
 * existing values" guarantee from the Apr 22 2026 changelog.
 *
 * The approval-category block (PAC1-PAC5) locks in the tri-state encoding
 * for `claimers` / `approvers`: null = "anyone" (key omitted on the
 * response), [] = "admins only" (key echoed as []), [oids] = explicit
 * roster.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type {
  QuireApprovalCategory,
  QuireFieldDefinition,
  QuireProject,
} from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /project", () => {
  const client = liveClient();
  const TEST_PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");

  let project: QuireProject | undefined;
  let orgOid = "";

  beforeAll(async () => {
    const list = await client.listProjects();
    const found = list.find((p) => p.id === TEST_PROJECT_ID);
    if (!found) {
      throw new Error(
        `${TEST_PROJECT_ID} not in listProjects() — does the authorized user have access?`,
      );
    }
    project = found;
    orgOid = found.organization?.oid ?? readEnv("QUIRE_TEST_ORG_OID");
  });

  it("P1 listProjects contains the test project", () => {
    expect(project?.id).toBe(TEST_PROJECT_ID);
    expect(project?.oid).toBeTruthy();
  });

  it("P2 listProjectsByOrg contains the test project", async () => {
    const list = await client.listProjectsByOrg(orgOid);
    expect(list.some((p) => p.oid === project!.oid)).toBe(true);
  });

  it("P3 getProject returns matching id", async () => {
    const p = await client.getProject(project!.oid);
    expect(p.id).toBe(TEST_PROJECT_ID);
    expect(p.oid).toBe(project!.oid);
  });

  it("P4 getProjectById matches P3 oid", async () => {
    const p = await client.getProjectById(TEST_PROJECT_ID);
    expect(p.oid).toBe(project!.oid);
  });

  it("P5 listProjectMembers includes the current user", async () => {
    const me = await client.getMe();
    const members = await client.listProjectMembers(project!.oid);
    expect(members.some((u) => u.oid === me.oid)).toBe(true);
  });

  it("P6 updateProject adds then removes a follower", async () => {
    const me = await client.getMe();
    const baseline = await client.getProject(project!.oid);
    const wasFollower = (baseline.followers ?? []).some(
      (f) => f.oid === me.oid,
    );

    const added = await client.updateProject(project!.oid, {
      addFollowers: [me.oid],
    });
    expect((added.followers ?? []).some((f) => f.oid === me.oid)).toBe(true);

    const removed = await client.updateProject(project!.oid, {
      removeFollowers: [me.oid],
    });
    expect((removed.followers ?? []).some((f) => f.oid === me.oid)).toBe(false);

    if (wasFollower) {
      await client.updateProject(project!.oid, { addFollowers: [me.oid] });
    }
  });

  const FREE_PROJECT_ID = readEnvOptional("QUIRE_TEST_FREE_PROJECT_ID");
  it.skipIf(!FREE_PROJECT_ID)(
    "P7 updateProject edits name + description on the free test project",
    async () => {
      const baseline = await client.getProjectById(FREE_PROJECT_ID!);
      const newName = `${baseline.name} [${runTag}]`;
      const newDescription = `Touched by ${runTag}`;
      try {
        const put = await client.updateProject(baseline.oid, {
          name: newName,
          description: newDescription,
        });
        expect(put.nameText ?? put.name).toBe(newName);
        expect(put.descriptionText ?? put.description).toBe(newDescription);
      } finally {
        await client.updateProject(baseline.oid, {
          name: baseline.name,
          description: baseline.description ?? "",
        });
      }
    },
  );

  it("P10 updateProject edits start + due, then restores baseline", async () => {
    const baseline = await client.getProject(project!.oid);
    try {
      const set = await client.updateProject(project!.oid, {
        start: "2026-04-01",
        due: "2026-04-30",
      });
      expect(set.start).toBeTruthy();
      expect(set.due).toBeTruthy();
    } finally {
      await client.updateProject(project!.oid, {
        start: baseline.start ?? null,
        due: baseline.due ?? null,
      });
    }
  });

  it("P11 updateProject toggles archived on and off", async () => {
    const baseline = await client.getProject(project!.oid);
    const wasArchived = !!baseline.archivedAt;
    try {
      const flipped = await client.updateProject(project!.oid, {
        archived: !wasArchived,
      });
      expect(!!flipped.archivedAt).toBe(!wasArchived);
    } finally {
      // Always restore — an archived test project disappears from default
      // project lists.
      await client.updateProject(project!.oid, { archived: wasArchived });
    }
  });

  // Toggle on the throwaway fixture only — flipping a real project's
  // visibility to the public internet, even briefly, is too risky.
  it.skipIf(!FREE_PROJECT_ID)(
    "P13 updateProject toggles public on and off on the free test project",
    async () => {
      const baseline = await client.getProjectById(FREE_PROJECT_ID!);
      const wasPublic = !!baseline.publicAt;
      try {
        const flipped = await client.updateProject(baseline.oid, {
          public: !wasPublic,
        });
        expect(!!flipped.publicAt).toBe(!wasPublic);
      } finally {
        await client.updateProject(baseline.oid, { public: wasPublic });
      }
    },
  );

  it("P12 getProject exposes the `fields` custom-field map", async () => {
    const p = (await client.getProject(project!.oid)) as QuireProject & {
      fields?: Record<string, unknown>;
    };
    // Present on every project since Apr 22 2026, empty object when none.
    expect(typeof p.fields).toBe("object");
    expect(p.fields).not.toBeNull();
  });

  // Paid-plan only — free-plan calls 403 with `ecQuotaExceeded`.
  it("P8 exportProjectCsv returns non-empty CSV", async () => {
    const csv = await client.exportProjectCsv(project!.oid);
    expect(typeof csv).toBe("string");
    expect(csv.length).toBeGreaterThan(0);
    expect(csv).toContain(",");
  });

  it("P8b exportProjectCsvById returns non-empty CSV", async () => {
    const csv = await client.exportProjectCsvById(TEST_PROJECT_ID);
    expect(typeof csv).toBe("string");
    expect(csv.length).toBeGreaterThan(0);
    expect(csv).toContain(",");
  });

  it("P9 exportProjectJson returns a JSON string", async () => {
    const json = await client.exportProjectJson(project!.oid);
    expect(typeof json).toBe("string");
    expect(json.length).toBeGreaterThan(0);
    // Parses as an object (or array); not validating shape here.
    const parsed = JSON.parse(json);
    expect(parsed && typeof parsed === "object").toBe(true);
  });

  it("P9b exportProjectJsonById returns a JSON string", async () => {
    const json = await client.exportProjectJsonById(TEST_PROJECT_ID);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed && typeof parsed === "object").toBe(true);
  });
});

describe.skipIf(!hasTokens)("Live API — /project/*-field (custom-field definitions)", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const fieldA = `${runTag}-fa`;
  const fieldARenamed = `${fieldA}-renamed`;
  const fieldB = `${runTag}-fb`;

  type ProjectWithFields = QuireProject & {
    fields?: Record<string, QuireFieldDefinition>;
  };

  afterAll(async () => {
    for (const name of [fieldA, fieldARenamed, fieldB]) {
      await client.removeProjectField(PROJECT_OID, name).catch(() => {});
    }
  });

  it("PF1 addProjectField adds a number field with nDecimal", async () => {
    const res = await client.addProjectField(PROJECT_OID, {
      name: fieldA,
      type: "number",
      nDecimal: 2,
    });
    expect(res.name).toBe(fieldA);
    expect(String(res.type).toLowerCase()).toBe("number");
    expect(res.nDecimal).toBe(2);

    const proj = (await client.getProject(PROJECT_OID)) as ProjectWithFields;
    const field = proj.fields?.[fieldA];
    expect(field).toBeDefined();
    expect(field!.nDecimal).toBe(2);
  });

  // Apr 22 2026 changelog: omitted keys preserve existing values.
  it("PF2 updateProjectField flips `hidden` and preserves other flags", async () => {
    await client.updateProjectField(PROJECT_OID, fieldA, { hidden: true });

    const proj = (await client.getProject(PROJECT_OID)) as ProjectWithFields;
    const field = proj.fields?.[fieldA];
    expect(field).toBeDefined();
    expect(field!.hidden).toBe(true);
    expect(String(field!.type).toLowerCase()).toBe("number");
    expect(field!.nDecimal).toBe(2);
  });

  it("PF3 renameProjectField renames the field", async () => {
    const res = await client.renameProjectField(
      PROJECT_OID,
      fieldA,
      fieldARenamed,
    );
    expect(res.name).toBe(fieldARenamed);

    const proj = (await client.getProject(PROJECT_OID)) as ProjectWithFields;
    expect(proj.fields?.[fieldARenamed]).toBeDefined();
    expect(proj.fields?.[fieldA]).toBeUndefined();
  });

  it("PF4 moveProjectField reorders via ?before= and without it", async () => {
    await client.addProjectField(PROJECT_OID, {
      name: fieldB,
      type: "number",
    });
    await client.moveProjectField(PROJECT_OID, fieldB, fieldARenamed);
    await client.moveProjectField(PROJECT_OID, fieldB);
  });

  it("PF5 removeProjectField removes both fields", async () => {
    for (const name of [fieldARenamed, fieldB]) {
      await client.removeProjectField(PROJECT_OID, name);
    }

    const proj = (await client.getProject(PROJECT_OID)) as ProjectWithFields;
    expect(proj.fields?.[fieldARenamed]).toBeUndefined();
    expect(proj.fields?.[fieldB]).toBeUndefined();
  });
});

describe.skipIf(!hasTokens)("Live API — /project/*-appv-cat (approval categories)", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const catId = `${runTag}-cat`;
  const catName = `${runTag}-appvcat`;
  const catNameRenamed = `${catName}-renamed`;

  type CategoryWithRefs = QuireApprovalCategory & {
    claimerRefs?: { oid: string; id: string }[];
    approverRefs?: { oid: string; id: string }[];
    createdBy?: string;
    createdAt?: string;
  };

  afterAll(async () => {
    await client
      .removeProjectApprovalCategory(PROJECT_OID, catId)
      .catch(() => {});
  });

  it("PAC1 addProjectApprovalCategory adds a category with null rosters", async () => {
    const res = (await client.addProjectApprovalCategory(PROJECT_OID, {
      id: catId,
      name: catName,
      claimers: null,
      approvers: null,
    })) as CategoryWithRefs;
    expect(res.id).toBe(catId);
    expect(res.name).toBe(catName);
    // null roster → "anyone" → server omits the key entirely.
    expect(res.claimers).toBeUndefined();
    expect(res.approvers).toBeUndefined();
    expect(res.createdBy).toBeTruthy();
    expect(res.createdAt).toBeTruthy();

    // Use rawApi to read the project's approvalCategories — the wrapped
    // QuireProject type doesn't expose that field in its declaration.
    const proj = await rawApi<{
      approvalCategories?: QuireApprovalCategory[];
    }>("GET", `/project/${PROJECT_OID}`);
    expect(proj.status).toBe(200);
    expect(Array.isArray(proj.data.approvalCategories)).toBe(true);
    const found = proj.data.approvalCategories!.find((c) => c.id === catId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(catName);
  });

  it("PAC2 updateProjectApprovalCategory renames; rosters from PAC1 survive", async () => {
    const res = (await client.updateProjectApprovalCategory(
      PROJECT_OID,
      catId,
      { name: catNameRenamed },
    )) as CategoryWithRefs;
    expect(res.name).toBe(catNameRenamed);
    expect(res.claimers).toBeUndefined();
    expect(res.approvers).toBeUndefined();
  });

  it("PAC3 updateProjectApprovalCategory({claimers:[]}) echoes [] for admins-only", async () => {
    const res = (await client.updateProjectApprovalCategory(
      PROJECT_OID,
      catId,
      { claimers: [] },
    )) as CategoryWithRefs;
    expect(res.claimers).toEqual([]);
    expect(res.claimerRefs).toEqual([]);
    expect(res.approvers).toBeUndefined();
    expect(res.approverRefs).toBeUndefined();
    expect(res.name).toBe(catNameRenamed);
  });

  it("PAC4 updateProjectApprovalCategory({approvers:[me]}) echoes the explicit roster", async () => {
    const me = await client.getMe();
    const res = (await client.updateProjectApprovalCategory(
      PROJECT_OID,
      catId,
      { approvers: [me.oid] },
    )) as CategoryWithRefs;
    expect(res.approvers).toEqual([me.oid]);
    expect(res.approverRefs).toEqual([{ oid: me.oid, id: me.id }]);
    expect(res.claimers).toEqual([]);
    expect(res.claimerRefs).toEqual([]);
  });

  it("PAC5 removeProjectApprovalCategory removes it (no body)", async () => {
    await client.removeProjectApprovalCategory(PROJECT_OID, catId);

    const proj = await rawApi<{
      approvalCategories?: QuireApprovalCategory[];
    }>("GET", `/project/${PROJECT_OID}`);
    const stillThere = proj.data.approvalCategories?.some(
      (c) => c.id === catId,
    );
    expect(stillThere).toBeFalsy();
  });
});

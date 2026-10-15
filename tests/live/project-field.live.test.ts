/**
 * Live API tests for who can view and edit a project's custom field
 * (PF1-PF7), added in the Oct 15 2026 server release: `viewMembers`,
 * `editMembers` and `locked` on add-field / update-field, and their effect
 * on the field's values.
 *
 *   - `viewMembers` / `editMembers` are sent as user refs and returned as
 *     user objects; absent means no restriction, `[]` the admins only. An
 *     admin not named sees the definition but not the values.
 *   - `locked` stops editing in Quire only; the API can still write.
 *   - Like the other field flags, `private` / `locked` come back only when
 *     true. `private` is a choice only without `viewMembers`.
 *
 * PF6-PF7 need a second member of the test project and skip without
 * QUIRE_TEST_COLLEAGUE_EMAIL. Each field is created with the `runTag`
 * prefix and removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireFieldAccess, QuireUser } from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — project custom field access", () => {
  if (!hasTokens) return;

  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const COLLEAGUE = readEnvOptional("QUIRE_TEST_COLLEAGUE_EMAIL");

  let me: QuireUser;
  let taskOid: string | undefined;
  const fields: string[] = [];

  const addField = async (suffix: string, access: QuireFieldAccess) => {
    const name = `${runTag}-${suffix}`;
    const f = await client.addProjectField(PROJECT_OID, { name, type: "text", ...access });
    fields.push(name);
    return { name, f };
  };
  const ids = (users: { id: string }[] | undefined) => users?.map((u) => u.id);
  const writeValue = (name: string, value: string) =>
    rawApi<{ message?: string }>("PUT", `/task/${taskOid}`, { [name]: value });
  const readValue = async (name: string) => (await client.getTask(taskOid!))[name];

  beforeAll(async () => {
    me = await client.getMe();
    const t = await client.createTask(PROJECT_OID, { name: `${runTag}-field-access` });
    taskOid = t.oid;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
    for (const name of fields) {
      await client.removeProjectField(PROJECT_OID, name).catch(() => {});
    }
  });

  it("PF1 addProjectField returns viewMembers / editMembers as user objects, and locked", async () => {
    const { f } = await addField("pf1", {
      viewMembers: ["me"],
      editMembers: ["me"],
      locked: true,
    });
    expect(ids(f.viewMembers)).toEqual([me.id]);
    expect(f.editMembers?.[0]).toMatchObject({ oid: me.oid, id: me.id, name: me.name });
    expect(f.locked).toBe(true);
    // With viewMembers the field is always hidden from guests, so `private`
    // isn't a choice and isn't returned.
    expect(f.private).toBeUndefined();
  });

  it("PF2 a field without restrictions returns none of them — false flags are omitted", async () => {
    const { f } = await addField("pf2", {});
    expect(f.viewMembers).toBeUndefined();
    expect(f.editMembers).toBeUndefined();
    expect(f.locked).toBeUndefined();
    expect(f.private).toBeUndefined();
  });

  it("PF3 private: false with viewMembers is 400", async () => {
    const name = `${runTag}-pf3`;
    const r = await rawApi<{ message?: string }>("POST", `/project/add-field/${PROJECT_OID}`, {
      name,
      type: "text",
      viewMembers: ["me"],
      private: false,
    });
    if (r.status === 200) fields.push(name);
    expect(r.status).toBe(400);
    expect(r.data?.message).toContain("private");
  });

  it("PF4 clearing viewMembers leaves the field private; editMembers [] means admins only", async () => {
    const { name } = await addField("pf4", { viewMembers: ["me"] });

    const cleared = await client.updateProjectField(PROJECT_OID, name, { viewMembers: null });
    expect(cleared.viewMembers).toBeUndefined();
    // Still hidden from guests and public visitors — lifting the member
    // restriction doesn't expose the field.
    expect(cleared.private).toBe(true);

    const adminsOnly = await client.updateProjectField(PROJECT_OID, name, { editMembers: [] });
    expect(adminsOnly.editMembers).toEqual([]);

    // The definition on the project matches.
    const project = await client.getProject(PROJECT_OID);
    expect(project.fields?.[name]?.editMembers).toEqual([]);
  });

  it("PF5 locked doesn't stop API writes, and an admin can write an admins-only field", async () => {
    const { name } = await addField("pf5", { locked: true, editMembers: [] });
    await client.updateTask(taskOid!, { customFields: { [name]: "pushed" } });
    expect(await readValue(name)).toBe("pushed");
  });

  it.skipIf(!COLLEAGUE)("PF6 an admin not in viewMembers sees the definition but not the value; write and search are 400", async () => {
    const { name } = await addField("pf6", {});
    await client.updateTask(taskOid!, { customFields: { [name]: "before" } });
    await client.updateProjectField(PROJECT_OID, name, {
      viewMembers: [COLLEAGUE!],
      editMembers: [COLLEAGUE!],
    });

    const task = await client.getTask(taskOid!);
    expect(name in task).toBe(false);

    const project = await client.getProject(PROJECT_OID);
    expect(project.fields?.[name]).toBeDefined();
    expect(project.fields?.[name]?.viewMembers).toHaveLength(1);

    const write = await writeValue(name, "after");
    expect(write.status).toBe(400);
    expect(write.data?.message).toContain("can't edit");

    // A field the caller can't view is an unknown search parameter.
    const search = await rawApi<{ message?: string }>(
      "GET",
      `/task/search/${PROJECT_OID}?${encodeURIComponent(name)}=before`,
    );
    expect(search.status).toBe(400);
    expect(search.data?.message).toContain("Unknown query parameter");
  });

  it.skipIf(!COLLEAGUE)("PF7 viewing without editing: the value is returned, a write is 400", async () => {
    const { name } = await addField("pf7", {});
    await client.updateTask(taskOid!, { customFields: { [name]: "seen" } });
    await client.updateProjectField(PROJECT_OID, name, {
      viewMembers: ["me", COLLEAGUE!],
      editMembers: [COLLEAGUE!],
    });

    expect(await readValue(name)).toBe("seen");
    const write = await writeValue(name, "changed");
    expect(write.status).toBe(400);
    expect(await readValue(name)).toBe("seen");
  });
});

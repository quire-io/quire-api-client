/**
 * Live API tests for /sublist (SL1, SL2, SL2a, SL2b, SL2c, SL3, SL4).
 *
 * Membership note: adding/removing tasks goes through PUT /sublist/{oid}
 * with `{ changes: [{ task, exclude? }] }`, NOT /task/move (which only
 * reparents within the task tree and 400s with the confusing
 * "Missing query parameter(s)" when handed a sublist OID). The PUT
 * response strips fdIncludes/fdExcludes, so membership has to be verified
 * via /task/search?sublist=.
 *
 * QuireClient exposes the membership op as `updateSublistMembership`.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireSublist, QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /sublist", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const SUBLIST_NAME = `${runTag}-sublist`;

  let sublistOid: string | undefined;
  let taskOid: string | undefined;

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
    if (sublistOid) await client.deleteSublist(sublistOid).catch(() => {});
  });

  it("SL1 createSublist creates a sublist under a project", async () => {
    const s = await client.createSublist("project", PROJECT_OID, {
      name: SUBLIST_NAME,
    });
    expect(s.oid).toBeTruthy();
    expect(s.nameText ?? s.name).toBe(SUBLIST_NAME);
    sublistOid = s.oid;
  });

  it("SL2 listSublists contains the new sublist", async () => {
    const list = await client.listSublists("project", PROJECT_OID);
    expect(list.some((s) => s.oid === sublistOid)).toBe(true);
  });

  it("SL2a updateSublist updates name + description", async () => {
    const updated = await client.updateSublist(sublistOid!, {
      name: `${SUBLIST_NAME}-renamed`,
      description: "sl2a body",
    });
    expect(updated.nameText ?? updated.name).toBe(`${SUBLIST_NAME}-renamed`);
    expect(updated.descriptionText ?? updated.description).toContain(
      "sl2a body",
    );
  });

  it("SL2b updateSublistMembership adds the task to the sublist", async () => {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-sl-task`,
    });
    taskOid = t.oid;

    await client.updateSublistMembership(sublistOid!, [{ task: taskOid }]);

    // Verify via /task/search?sublist=… — the PUT response strips
    // fdIncludes/fdExcludes, so membership can only be checked via search.
    const hits = await client.searchTasks(PROJECT_OID, { sublist: sublistOid });
    expect(hits.some((x) => x.oid === taskOid)).toBe(true);
  });

  it("SL2c updateSublistMembership with exclude:true removes the task", async () => {
    if (!taskOid) throw new Error("SL2b did not complete");
    await client.updateSublistMembership(sublistOid!, [
      { task: taskOid, exclude: true },
    ]);

    const hits = await client.searchTasks(PROJECT_OID, { sublist: sublistOid });
    expect(hits.some((x) => x.oid === taskOid)).toBe(false);
  });

  it("SL3 deleteSublist removes the sublist", async () => {
    await client.deleteSublist(sublistOid!);
    const list = await client.listSublists("project", PROJECT_OID);
    expect(list.some((s) => s.oid === sublistOid)).toBe(false);
    sublistOid = undefined;
  });

  it("SL4 undoRemoveSublist restores a removed sublist", async () => {
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-undo`,
    });
    await client.deleteSublist(created.oid);
    // GET on a deleted sublist 404s — use rawApi to confirm.
    expect((await rawApi<QuireSublist>("GET", `/sublist/${created.oid}`)).status).toBe(404);

    const restored = await client.undoRemoveSublist(created.oid);
    expect(restored.oid).toBe(created.oid);

    const list = await client.listSublists("project", PROJECT_OID);
    expect(list.some((s) => s.oid === created.oid)).toBe(true);

    await client.deleteSublist(created.oid).catch(() => {});
  });
});

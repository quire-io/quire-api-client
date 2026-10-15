/**
 * Live API tests for /sublist (SL1-SL4, `members` SL5-SL8, `private`
 * SL9-SL11).
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

  // `members` (Sep 21 2026) — create-only, tri-state, and returned as user
  // objects rather than the OID strings it used to be. All three states come
  // back explicitly so they can be told apart:
  //   null → every member of the owner
  //   []   → the owner's admins only
  //   list → only those users
  it("SL5 createSublist without members returns members: null", async () => {
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-members-default`,
    });
    try {
      expect(created.members ?? null).toBeNull();
    } finally {
      await client.deleteSublist(created.oid).catch(() => {});
    }
  });

  it("SL6 createSublist with members: ['me'] scopes it to that user", async () => {
    const me = await client.getMe();
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-members-me`,
      members: ["me"],
    });
    try {
      // User objects now, not OID strings — same shape as `followers`.
      expect(Array.isArray(created.members)).toBe(true);
      expect(created.members!.some((m) => m.oid === me.oid)).toBe(true);
      expect(typeof created.members![0]!.name).toBe("string");
    } finally {
      await client.deleteSublist(created.oid).catch(() => {});
    }
  });

  it("SL7 createSublist with members: [] means admins only", async () => {
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-members-admins`,
      members: [],
    });
    try {
      // Empty list echoed back, NOT collapsed to null — that's the whole
      // point of the tri-state.
      expect(created.members).toEqual([]);
    } finally {
      await client.deleteSublist(created.oid).catch(() => {});
    }
  });

  // A non-empty list must include the caller, otherwise they could not see
  // what they just created. Rejected outright rather than silently repaired.
  it("SL8 createSublist with a members list excluding the caller is 400", async () => {
    const res = await rawApi<{ oid?: string }>(
      "POST",
      `/sublist/project/${PROJECT_OID}`,
      {
        name: `${runTag}-sublist-members-invalid`,
        members: ["nobody@example.invalid"],
      },
    );
    expect(res.status).toBe(400);
    if (res.status === 200 && res.data?.oid) {
      await client.deleteSublist(res.data.oid).catch(() => {});
    }
  });

  // `private` (Oct 15 2026) hides a record from guests and from the visitors
  // of a public project or share link. It is a choice only while `members`
  // and `partner` are both null; with either set the record is always hidden
  // from them. Docs, chats, insights and dashboards share the rule (the same
  // probes against docs returned the same results).
  it("SL9 createSublist returns private: false by default and honours private: true", async () => {
    const plain = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-public`,
    });
    const hidden = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-private`,
      private: true,
    });
    try {
      expect(plain.private).toBe(false);
      expect(hidden.private).toBe(true);
      expect((await client.getSublist(hidden.oid)).private).toBe(true);
    } finally {
      await client.deleteSublist(plain.oid).catch(() => {});
      await client.deleteSublist(hidden.oid).catch(() => {});
    }
  });

  it("SL10 updateSublist turns private on and off", async () => {
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-private-toggle`,
    });
    try {
      const on = await client.updateSublist(created.oid, { private: true });
      expect(on.private).toBe(true);
      const off = await client.updateSublist(created.oid, { private: false });
      expect(off.private).toBe(false);
    } finally {
      await client.deleteSublist(created.oid).catch(() => {});
    }
  });

  // With `members` set, `private` isn't returned at all, `true` is accepted
  // as a no-op, and `false` is rejected — the record can't be shown to guests.
  it("SL11 with members, private is absent from the response and false is 400", async () => {
    const created = await client.createSublist("project", PROJECT_OID, {
      name: `${runTag}-sublist-members-private`,
      members: ["me"],
      private: true,
    });
    try {
      expect(created.private).toBeUndefined();
    } finally {
      await client.deleteSublist(created.oid).catch(() => {});
    }

    const res = await rawApi<{ oid?: string; message?: string }>(
      "POST",
      `/sublist/project/${PROJECT_OID}`,
      {
        name: `${runTag}-sublist-members-public`,
        members: [],
        private: false,
      },
    );
    expect(res.status).toBe(400);
    expect(res.data?.message).toContain("private");
    if (res.status === 200 && res.data?.oid) {
      await client.deleteSublist(res.data.oid).catch(() => {});
    }
  });
});

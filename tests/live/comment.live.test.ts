/**
 * Live API tests for /comment on tasks (C1-C4b) and chats (C5-C8b).
 *
 * Comments are the same entity regardless of host — `owner.type` is the
 * discriminator ("Task" vs "Chat"). Both hosts use the same /comment/{oid}
 * routes for read / update / delete / undo-remove. The create endpoints
 * differ:
 *   POST /comment/{taskOid}        — task-owned (QuireClient.addComment)
 *   POST /comment/chat/{chatOid}   — chat-owned (QuireClient.addChatComment)
 *
 * C7a locks in the pinAt / pinBy contract for the `pinned` toggle on PUT
 * /comment/{oid}; C1a the `pinned` and `asUser` flags on create.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireComment } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /comment on a task", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const COMMENT_TEXT = `${runTag}-comment`;

  let taskOid: string | undefined;
  let taskId: number | undefined;
  let commentOid: string | undefined;

  beforeAll(async () => {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-comment-host`,
    });
    taskOid = t.oid;
    taskId = t.id;
  });

  afterAll(async () => {
    if (commentOid) await client.deleteComment(commentOid).catch(() => {});
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("C1 addComment creates a task comment", async () => {
    const c = await client.addComment(taskOid!, COMMENT_TEXT);
    expect(c.oid).toBeTruthy();
    // A user object, as `editedBy` / `pinBy` are — the bare OID it was
    // until zkoss/boeneo#26017.
    expect(c.createdBy?.oid).toBeTruthy();
    expect(c.createdBy?.name).toBeTruthy();
    // Probe: does the create response include `url`? If so, add_comment
    // can surface a deep-link directly.
    console.log("[C1] task comment url field:", c.url);
    commentOid = c.oid;
  });

  // `asUser: true` posts as the app, so `createdBy` is the app (its `id`
  // starts with `ap|`), not the authorizing user.
  it("C1a addComment honours pinned and asUser", async () => {
    const c = await client.addComment(taskOid!, `${runTag}-as-app`, {
      pinned: true,
      asUser: true,
    });
    try {
      expect(c.pinAt).toBeTruthy();
      expect(c.createdBy?.id).toMatch(/^ap\|/);
    } finally {
      await client.deleteComment(c.oid).catch(() => {});
    }
  });

  it("C2 getTaskComments contains the new comment", async () => {
    const comments = await client.getTaskComments(taskOid!);
    expect(comments.some((c) => c.oid === commentOid)).toBe(true);
  });

  // `ownerType`, an internal number, is gone since Oct 30 2026; `owner`
  // tells the type and the task's ID.
  it("C3 getComment returns the single comment with owner pointing back to the task", async () => {
    const c = await client.getComment(commentOid!);
    expect(c.oid).toBe(commentOid);
    expect(c.owner?.oid).toBe(taskOid);
    expect(c.owner?.type).toBe("Task");
    expect(c.owner?.id).toBe(taskId);
    expect(c.ownerType).toBeUndefined();
  });

  it("C3a updateComment updates the description", async () => {
    const c = await client.updateComment(commentOid!, {
      description: `${COMMENT_TEXT} edited`,
    });
    expect(c.descriptionText ?? c.description).toContain("edited");
  });

  // `asUser: true` on an update records the app as the editor (and as the
  // one who pinned it), as it does for the author on addComment.
  it("C3c updateComment with asUser records the app in editedBy and pinBy", async () => {
    const c = await client.updateComment(commentOid!, {
      description: `${COMMENT_TEXT} edited by the app`,
      pinned: true,
      asUser: true,
    });
    expect(c.editedBy?.id).toMatch(/^ap\|/);
    expect(c.pinBy?.id).toMatch(/^ap\|/);
    await client.updateComment(commentOid!, { pinned: false });
  });

  // ?return=compact on /comment endpoints. Comments don't carry a numeric
  // id, so the compact response is just `{oid}` — verify and confirm the
  // server's full-record render fields are absent.
  it("C3b addComment + updateComment honour compact (no id, no render fields)", async () => {
    const created = await client.addComment(
      taskOid!,
      `${runTag}-compact`,
      { compact: true },
    );
    expect(typeof created.oid).toBe("string");
    expect(created.id).toBeUndefined();
    expect((created as Record<string, unknown>).description).toBeUndefined();
    expect((created as Record<string, unknown>).descriptionText).toBeUndefined();

    const updated = await client.updateComment(created.oid, {
      description: `${runTag}-compact-edited`,
      compact: true,
    });
    expect(updated.oid).toBe(created.oid);
    expect((updated as Record<string, unknown>).description).toBeUndefined();

    // The update actually persisted — full GET shows the edited text.
    const got = await client.getComment(created.oid);
    expect(got.descriptionText ?? got.description).toContain("compact-edited");

    await client.deleteComment(created.oid);
  });

  it("C4 deleteComment removes it and a subsequent GET returns 404", async () => {
    await client.deleteComment(commentOid!);
    const get = await rawApi("GET", `/comment/${commentOid}`);
    expect(get.status).toBe(404);
    commentOid = undefined;
  });

  it("C4b undoRemoveComment restores a task-owned comment", async () => {
    const created = await client.addComment(taskOid!, `${runTag}-undo`);
    await client.deleteComment(created.oid);
    expect((await rawApi("GET", `/comment/${created.oid}`)).status).toBe(404);

    const restored = await client.undoRemoveComment(created.oid);
    expect(restored.oid).toBe(created.oid);

    const got = (await client.getComment(created.oid)) as QuireComment & {
      removedBy?: unknown;
    };
    // Changelog calls out that removedBy clears on restore — lock that in.
    expect(got.removedBy).toBeFalsy();

    // Idempotent on an already-restored comment.
    const again = await client.undoRemoveComment(created.oid);
    expect(again.oid).toBe(created.oid);

    await client.deleteComment(created.oid).catch(() => {});
  });
});

describe.skipIf(!hasTokens)("Live API — /comment on a chat", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const COMMENT_TEXT = `${runTag}-chat-comment`;

  let chatOid: string | undefined;
  let commentOid: string | undefined;

  beforeAll(async () => {
    const chat = await client.createChat("project", PROJECT_OID, {
      name: `${runTag}-comment-chat-host`,
    });
    chatOid = chat.oid;
  });

  afterAll(async () => {
    if (commentOid) await client.deleteComment(commentOid).catch(() => {});
    if (chatOid) await client.deleteChat(chatOid).catch(() => {});
  });

  it("C5 addChatComment creates a comment on the chat", async () => {
    const c = await client.addChatComment(chatOid!, {
      description: COMMENT_TEXT,
    });
    expect(c.oid).toBeTruthy();
    expect(c.owner?.oid).toBe(chatOid);
    console.log("[C5] chat comment url field:", c.url);
    commentOid = c.oid;
  });

  it("C5a addChatComment honours asUser", async () => {
    const c = await client.addChatComment(chatOid!, {
      description: `${runTag}-chat-as-app`,
      asUser: true,
    });
    try {
      expect(c.createdBy?.id).toMatch(/^ap\|/);
    } finally {
      await client.deleteComment(c.oid).catch(() => {});
    }
  });

  it("C6 listChatComments contains the new comment", async () => {
    const comments = await client.listChatComments(chatOid!);
    expect(comments.some((c) => c.oid === commentOid)).toBe(true);
  });

  it("C7 getComment reports owner.type === 'Chat'", async () => {
    const c = await client.getComment(commentOid!);
    expect(c.owner?.oid).toBe(chatOid);
    expect(c.owner?.type).toBe("Chat");
  });

  it("C7a updateComment({pinned:true}) populates pinAt + pinBy", async () => {
    const pinned = await client.updateComment(commentOid!, { pinned: true });
    expect(pinned.pinAt).toBeTruthy();
    expect(pinned.pinBy?.oid).toBeTruthy();

    const unpinned = await client.updateComment(commentOid!, {
      pinned: false,
    });
    expect(unpinned.pinAt).toBeFalsy();
  });

  it("C8 deleteComment removes a chat-owned comment", async () => {
    await client.deleteComment(commentOid!);
    const get = await rawApi("GET", `/comment/${commentOid}`);
    expect(get.status).toBe(404);
    commentOid = undefined;
  });

  it("C8b undoRemoveComment restores a chat-owned comment", async () => {
    const created = await client.addChatComment(chatOid!, {
      description: `${runTag}-chat-undo`,
    });
    await client.deleteComment(created.oid);
    expect((await rawApi("GET", `/comment/${created.oid}`)).status).toBe(404);

    const restored = await client.undoRemoveComment(created.oid);
    expect(restored.oid).toBe(created.oid);

    const got = await client.getComment(created.oid);
    expect(got.owner?.oid).toBe(chatOid);

    await client.deleteComment(created.oid).catch(() => {});
  });
});

/**
 * Live API tests for /chat (CH1-CH5).
 *
 * Self-contained: each describe creates its own throwaway chat in
 * beforeAll so the suite doesn't depend on a hand-seeded chat in the
 * test project.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireChat } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /chat", () => {
  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const CHAT_NAME = `${runTag}-chat`;

  let chat: QuireChat | undefined;

  beforeAll(async () => {
    chat = await client.createChat("project", PROJECT_OID, { name: CHAT_NAME });
  });

  afterAll(async () => {
    if (chat) await client.deleteChat(chat.oid).catch(() => {});
  });

  it("CH1 listChats contains the created chat", async () => {
    const chats = await client.listChats("project", PROJECT_OID);
    expect(chats.some((c) => c.oid === chat!.oid)).toBe(true);
  });

  it("CH2 getChat returns the same chat", async () => {
    const got = await client.getChat(chat!.oid);
    expect(got.oid).toBe(chat!.oid);
    expect(got.id).toBe(chat!.id);
  });

  it("CH3 getChatByProjectAndId matches by id", async () => {
    const got = await client.getChatByProjectAndId(PROJECT_ID, chat!.id);
    expect(got.oid).toBe(chat!.oid);
  });

  it("CH3a updateChat updates name + description", async () => {
    const updated = await client.updateChat(chat!.oid, {
      name: `${CHAT_NAME}-renamed`,
      description: "ch3a body",
    });
    expect(updated.nameText ?? updated.name).toBe(`${CHAT_NAME}-renamed`);
    expect(updated.descriptionText ?? updated.description).toContain(
      "ch3a body",
    );
  });

  it("CH4 listChatComments returns an array (empty is fine)", async () => {
    const comments = await client.listChatComments(chat!.oid);
    expect(Array.isArray(comments)).toBe(true);
  });

  // undoRemoveChat counts against the chat creation quota. Throwaway chat
  // so the describe-level fixture isn't mutated or torn down early.
  it("CH5 undoRemoveChat restores a removed chat", async () => {
    const created = await client.createChat("project", PROJECT_OID, {
      name: `${runTag}-chat-undo`,
    });

    await client.deleteChat(created.oid);
    expect((await rawApi("GET", `/chat/${created.oid}`)).status).toBe(404);

    const restored = await client.undoRemoveChat(created.oid);
    expect(restored.oid).toBe(created.oid);

    const fresh = await client.getChat(created.oid);
    expect(fresh.oid).toBe(created.oid);

    await client.deleteChat(created.oid).catch(() => {});
  });
});

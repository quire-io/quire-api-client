/**
 * Live API tests for emoji reactions on comments (CE1-CE16), added in the
 * Oct 15 2026 server release.
 *
 *   POST   /comment/add-emoji/{commentOid}/{emojis}     (addCommentEmojis)
 *   DELETE /comment/remove-emoji/{commentOid}/{emojis}  (removeCommentEmojis)
 *
 * `{emojis}` is a comma list, percent-encoded, each item an emoji or one of
 * its GitHub / Slack shortcodes (`+1`, `:tada:`, case-insensitive). Both
 * return 204 with no body, are all-or-nothing (one bad item → 400, nothing
 * written) and idempotent. Add accepts only the 20 emojis the apps' picker
 * offers; remove accepts any non-empty value so a legacy key can go too.
 *
 * Every comment response carries `emojis` — `[{emoji, users: [{oid, id,
 * name}]}]` in stored order — and omits it when there are none.
 *
 * Happy paths go through QuireClient; rawApi is kept for the status-code and
 * wire-format assertions the wrapper would hide (CE5, CE7's second call,
 * CE8-CE12, CE15).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireCommentEmoji, QuireUser } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

const HEART = "❤️";
const WARNING = "⚠️";

// The picker's emojis in picker order, each with every name the server
// accepts for it.
const EMOJI_NAMES: [string, string[]][] = [
  ["😃", ["smiley"]],
  ["😞", ["disappointed"]],
  ["😐", ["neutral_face"]],
  ["😂", ["joy"]],
  ["😍", ["heart_eyes"]],
  ["😜", ["stuck_out_tongue_winking_eye"]],
  ["😏", ["smirk"]],
  ["😱", ["scream"]],
  ["😭", ["sob"]],
  ["😡", ["rage", "pout"]],
  ["👍", ["+1", "thumbsup"]],
  ["👎", ["-1", "thumbsdown"]],
  ["🙌", ["raised_hands"]],
  ["👊", ["punch", "facepunch", "fist_oncoming"]],
  ["💪", ["muscle"]],
  [HEART, ["heart"]],
  ["🎉", ["tada"]],
  ["🚀", ["rocket"]],
  ["💯", ["100"]],
  [WARNING, ["warning"]],
];
const PICKER = EMOJI_NAMES.map(([emoji]) => emoji);

// Raw forms of the two writes, for status assertions. Each emoji
// percent-encoded on its own and joined with a literal comma — the same
// shape QuireClient builds.
const emojiPath = (op: "add" | "remove", oid: string, emojis: string[]) =>
  `/comment/${op}-emoji/${oid}/${emojis.map(encodeURIComponent).join(",")}`;
const addEmojis = (oid: string, emojis: string[]) =>
  rawApi<{ message?: string }>("POST", emojiPath("add", oid, emojis));
const removeEmojis = (oid: string, emojis: string[]) =>
  rawApi<{ message?: string }>("DELETE", emojiPath("remove", oid, emojis));

describe.skipIf(!hasTokens)("Live API — comment emoji reactions", () => {
  if (!hasTokens) return;

  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let me: QuireUser;
  let taskOid: string | undefined;
  let chatOid: string | undefined;
  let commentOid: string | undefined;
  let tableOid: string | undefined;

  // A reaction by the authorizing user — the only reactor in this suite.
  const mine = (emoji: string): QuireCommentEmoji => ({
    emoji,
    users: [{ oid: me.oid, id: me.id, name: me.name }],
  });
  const readEmojis = async (oid: string) =>
    (await client.getComment(oid)).emojis;

  beforeAll(async () => {
    me = await client.getMe();
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-emoji-host`,
    });
    taskOid = t.oid;
  });

  afterAll(async () => {
    for (const oid of [commentOid, tableOid]) {
      if (oid) await client.deleteComment(oid).catch(() => {});
    }
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
    if (chatOid) await client.deleteChat(chatOid).catch(() => {});
  });

  it("CE1 a comment without reactions omits `emojis` on create and get", async () => {
    const c = await client.addComment(taskOid!, `${runTag}-emoji`);
    commentOid = c.oid;
    expect(c.emojis).toBeUndefined();
    expect(await readEmojis(commentOid)).toBeUndefined();
  });

  it("CE2 addCommentEmojis resolves with no body; reactions read back in the order added", async () => {
    await expect(
      client.addCommentEmojis(commentOid!, ["👍", "🎉"]),
    ).resolves.toBeUndefined();
    expect(await readEmojis(commentOid!)).toEqual([mine("👍"), mine("🎉")]);
  });

  it("CE3 adding an existing reaction is a no-op", async () => {
    await client.addCommentEmojis(commentOid!, ["👍"]);
    expect(await readEmojis(commentOid!)).toEqual([mine("👍"), mine("🎉")]);
  });

  it("CE4 names resolve to the emoji — with or without colons, any case", async () => {
    // thumbsup is 👍, already there; the response returns emojis, never names.
    await client.addCommentEmojis(commentOid!, ["thumbsup", ":Muscle:", "ROCKET"]);
    expect(await readEmojis(commentOid!)).toEqual([
      mine("👍"), mine("🎉"), mine("💪"), mine("🚀"),
    ]);
  });

  it("CE5 ❤ / ⚠ without U+FE0F are stored as ❤️ / ⚠️; an encoded comma separates too", async () => {
    const r = await rawApi(
      "POST",
      `/comment/add-emoji/${commentOid}/${encodeURIComponent("❤,⚠")}`,
    );
    expect(r.status).toBe(204);
    expect(r.data).toBeUndefined();
    expect(await readEmojis(commentOid!)).toEqual([
      mine("👍"), mine("🎉"), mine("💪"), mine("🚀"), mine(HEART), mine(WARNING),
    ]);
  });

  it("CE6 list and update responses carry `emojis` too", async () => {
    const expected = await readEmojis(commentOid!);

    const listed = (await client.getTaskComments(taskOid!)).find(
      (c) => c.oid === commentOid,
    );
    expect(listed?.emojis).toEqual(expected);

    const updated = await client.updateComment(commentOid!, {
      description: `${runTag}-emoji edited`,
    });
    expect(updated.emojis).toEqual(expected);
  });

  it("CE7 removeCommentEmojis takes emojis or names; a missing or legacy value is a no-op", async () => {
    await client.removeCommentEmojis(commentOid!, ["👍", "muscle", "❤", ":rocket:"]);
    expect(await readEmojis(commentOid!)).toEqual([mine("🎉"), mine(WARNING)]);

    // Raw, since the client drops the empty item before sending: 👍 is
    // already gone, legacy-key never existed, and the server ignores "".
    const again = await removeEmojis(commentOid!, ["👍", "legacy-key", ""]);
    expect(again.status).toBe(204);
    expect(await readEmojis(commentOid!)).toEqual([mine("🎉"), mine(WARNING)]);
  });

  it("CE8 add is all-or-nothing: one emoji outside the picker → 400 naming it", async () => {
    const r = await addEmojis(commentOid!, ["👍", "🐱"]);
    expect(r.status).toBe(400);
    expect(r.data?.message).toContain("🐱");

    // Unknown name; nothing specified (empty and blank items only).
    expect((await addEmojis(commentOid!, ["nope"])).status).toBe(400);
    expect((await addEmojis(commentOid!, ["", " "])).status).toBe(400);

    expect(await readEmojis(commentOid!)).toEqual([mine("🎉"), mine(WARNING)]);
  });

  it("CE9 missing emojis, trailing junk, bad encoding and the byId form → 400", async () => {
    const thumb = encodeURIComponent("👍");
    for (const path of [
      `/comment/add-emoji/${commentOid}`,
      `/comment/add-emoji/${commentOid}/${thumb}/junk`,
      `/comment/add-emoji/${commentOid}/%E2%9D`,
      `/comment/add-emoji/id/${PROJECT_ID}/${commentOid}/${thumb}`,
    ]) {
      expect((await rawApi("POST", path)).status, path).toBe(400);
    }
    expect(await readEmojis(commentOid!)).toEqual([mine("🎉"), mine(WARNING)]);
  });

  it("CE10 PUT /comment/{oid} still rejects `emojis`", async () => {
    const r = await rawApi("PUT", `/comment/${commentOid}`, {
      emojis: [{ emoji: "👍", users: [{ oid: me.oid }] }],
    });
    expect(r.status).toBe(400);
    expect(await readEmojis(commentOid!)).toEqual([mine("🎉"), mine(WARNING)]);
  });

  it("CE11 a removed comment: add → 404, remove → 204 writing nothing; undo-remove brings reactions back", async () => {
    await client.deleteComment(commentOid!);
    expect((await addEmojis(commentOid!, ["👍"])).status).toBe(404);
    // Like every DELETE in the API, a missing target is a 204 no-op rather
    // than a 404 — though the remove-emoji doc lists 404. Nothing is
    // written: 🎉 is still there after the restore below.
    expect((await removeEmojis(commentOid!, ["🎉"])).status).toBe(204);

    const restored = await client.undoRemoveComment(commentOid!);
    expect(restored.emojis).toEqual([mine("🎉"), mine(WARNING)]);
  });

  it("CE12 an unknown comment OID: add → 404, remove → 204 like every DELETE", async () => {
    expect((await addEmojis("not_exist_oid", ["👍"])).status).toBe(404);
    expect((await removeEmojis("not_exist_oid", ["👍"])).status).toBe(204);
  });

  it("CE13 every documented name in one request → the 20 picker emojis, in picker order", async () => {
    const c = await client.addComment(taskOid!, `${runTag}-emoji-table`);
    tableOid = c.oid;

    // 26 names but 20 distinct emojis: the per-request cap counts emojis
    // after names resolve, so this is within it.
    await client.addCommentEmojis(tableOid, EMOJI_NAMES.flatMap(([, n]) => n));
    expect((await readEmojis(tableOid))?.map((e) => e.emoji)).toEqual(PICKER);

    await client.removeCommentEmojis(tableOid, PICKER);
    expect(await readEmojis(tableOid)).toBeUndefined();
  });

  it("CE14 aliases resolve to the same emoji as their primary name", async () => {
    await client.addCommentEmojis(tableOid!, [
      "pout", "THUMBSUP", "thumbsdown", "facepunch", "fist_oncoming",
    ]);
    expect(await readEmojis(tableOid!)).toEqual([
      mine("😡"), mine("👍"), mine("👎"), mine("👊"),
    ]);

    await client.removeCommentEmojis(tableOid!, ["rage", "+1", "-1", "punch"]);
    expect(await readEmojis(tableOid!)).toBeUndefined();
  });

  it("CE15 at most 20 distinct emojis per request (only reachable on remove)", async () => {
    const legacy = (n: number) =>
      Array.from({ length: n }, (_, i) => `${runTag}-legacy-${i}`);
    expect((await removeEmojis(tableOid!, legacy(21))).status).toBe(400);
    expect((await removeEmojis(tableOid!, legacy(20))).status).toBe(204);
  });

  it("CE16 chat comments take reactions the same way", async () => {
    const chat = await client.createChat("project", PROJECT_OID, {
      name: `${runTag}-emoji-chat`,
    });
    chatOid = chat.oid;
    const c = await client.addChatComment(chatOid, {
      description: `${runTag}-emoji-chat-comment`,
    });

    await client.addCommentEmojis(c.oid, ["rocket"]);
    const listed = (await client.listChatComments(chatOid)).find(
      (x) => x.oid === c.oid,
    );
    expect(listed?.emojis).toEqual([mine("🚀")]);

    await client.removeCommentEmojis(c.oid, ["🚀"]);
    expect(await readEmojis(c.oid)).toBeUndefined();
  });
});

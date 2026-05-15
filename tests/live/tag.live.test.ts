/**
 * Live API tests for /tag (TAG1, TAG1b, TAG2, TAG2a, TAG3, TAG4).
 *
 * Quire auto-assigns a color from its fixed 2-digit palette when `color`
 * is omitted on create (boeneo's `correctColor` → `nextIconColor`).
 * Resolved-color codes match the palette regex `^[0-5][0-7]$`.
 *
 * TAG1b iterates every code in `NAMED_COLORS` against the live API to
 * guard against drift between our palette table and Quire's server-side
 * `iconColorRowSpan` / `ColSpan` if the table changes upstream. Sequential
 * on purpose — firing the whole set in parallel burns each request's retry
 * budget simultaneously and blows the timeout under load.
 */

import { describe, it, expect, afterAll } from "vitest";
import { NAMED_COLORS } from "../../src/index.js";
import type { QuireTag } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /tag", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const TAG_NAME = `${runTag}-tag`;

  let tagOid: string | undefined;

  afterAll(async () => {
    if (tagOid) await client.deleteTag(tagOid).catch(() => {});
  });

  it("TAG1 createTag without color auto-assigns a palette color", async () => {
    const t = await client.createTag(PROJECT_OID, { name: TAG_NAME });
    expect(t.oid).toBeTruthy();
    expect(t.nameText ?? t.name).toBe(TAG_NAME);
    expect(t.color).toMatch(/^[0-5][0-7]$/);
    tagOid = t.oid;
  });

  it("TAG1b createTag accepts every NAMED_COLORS palette code", async () => {
    const codes = [...new Set(Object.values(NAMED_COLORS))];
    const created: QuireTag[] = [];
    try {
      for (const code of codes) {
        const t = await client.createTag(PROJECT_OID, {
          name: `${runTag}-${code}`,
          color: code,
        });
        created.push(t);
        expect(t.color, `color=${code}`).toBe(code);
      }
    } finally {
      for (const t of created) {
        await client.deleteTag(t.oid).catch(() => {});
      }
    }
  });

  it("TAG2 listTags contains the new tag", async () => {
    const tags = await client.listTags(PROJECT_OID);
    expect(tags.some((t) => t.oid === tagOid)).toBe(true);
  });

  it("TAG2a updateTag renames + recolors the tag", async () => {
    const t = await client.updateTag(tagOid!, {
      name: `${TAG_NAME}-renamed`,
      color: "34",
    });
    expect(t.nameText ?? t.name).toBe(`${TAG_NAME}-renamed`);
    expect(t.color).toBe("34");
  });

  it("TAG3 deleteTag removes the tag", async () => {
    await client.deleteTag(tagOid!);
    tagOid = undefined;
  });

  it("TAG4 listTags no longer contains the deleted tag", async () => {
    const tags = await client.listTags(PROJECT_OID);
    expect(tags.some((t) => (t.nameText ?? t.name) === TAG_NAME)).toBe(false);
  });
});

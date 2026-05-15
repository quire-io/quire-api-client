/**
 * Live API tests for cursor pagination on /task/list and /task/search
 * (TPG1-TPG4).
 *
 * Wire shape: with `?limit=N` and more results to come, the LAST item in
 * the response carries `"cursor": "<token>"`. Pass it back as
 * `?cursor=<token>` (with the same `?limit=` and any filter) for the next
 * page. End-of-stream is the absence of `cursor` on the last item of a
 * page. Same bare-array shape on every page — no envelope.
 *
 * Scope:
 *   TPG1/TPG2 — /task/list under a parent task (small fixture).
 *   TPG3/TPG4 — /task/search filtered by a fresh tag.
 *
 * Negative cases (cursor + sublist on search → 400, cursor + depth>1 on
 * list → 400) are out-of-scope.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTag, QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

type CursorTask = QuireTask & { cursor?: string };

describe.skipIf(!hasTokens)("Live API — cursor pagination", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let parent: QuireTask;
  let tag: QuireTag;
  const childOids: string[] = [];

  beforeAll(async () => {
    parent = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tpg-parent`,
    });
    // Three children — verifies a 2-per-page flow yields page1 (2 items
    // + cursor) and page2 (1 item, no cursor).
    for (let i = 1; i <= 3; i++) {
      const child = await client.createSubtask(parent.oid, {
        name: `${runTag}-tpg-child${i}`,
      });
      childOids.push(child.oid);
    }

    // Tag fixture for the search-cursor cases; applied to all three so
    // ?tag=<tagOid> scopes to exactly our fixture set.
    tag = await client.createTag(PROJECT_OID, { name: `${runTag}-tpg-tag` });
    for (const oid of childOids) {
      await client.updateTask(oid, { addTags: [tag.oid] });
    }
  });

  afterAll(async () => {
    if (parent?.oid) await client.deleteTask(parent.oid).catch(() => {});
    if (tag?.oid) await client.deleteTag(tag.oid).catch(() => {});
  });

  it("TPG1 listSubtasks({limit:2}) returns page1 with cursor on the last item", async () => {
    const page = (await client.listSubtasks(parent.oid, {
      limit: 2,
    })) as CursorTask[];
    expect(page.length).toBe(2);
    expect(typeof page[1]!.cursor).toBe("string");
    expect(page[1]!.cursor!.length).toBeGreaterThan(0);
    expect(page[0]!.cursor).toBeUndefined();
  });

  it("TPG2 listSubtasks({limit:2, cursor}) returns page2 without a cursor", async () => {
    const page1 = (await client.listSubtasks(parent.oid, {
      limit: 2,
    })) as CursorTask[];
    const cursor = page1[1]!.cursor!;
    const page2 = (await client.listSubtasks(parent.oid, {
      limit: 2,
      cursor,
    })) as CursorTask[];
    expect(page2.length).toBe(1);
    expect(page2[0]!.cursor).toBeUndefined();
    expect(childOids).toContain(page2[0]!.oid);
  });

  it("TPG3 searchTasks({tag, limit:2}) returns search-page1 with cursor", async () => {
    const page1 = (await client.searchTasks(PROJECT_OID, {
      tag: tag.oid,
      limit: 2,
    })) as CursorTask[];
    expect(page1.length).toBe(2);
    expect(typeof page1[1]!.cursor).toBe("string");
  });

  it("TPG4 searchTasks({tag, limit:2, cursor}) returns search-page2 with no cursor", async () => {
    const page1 = (await client.searchTasks(PROJECT_OID, {
      tag: tag.oid,
      limit: 2,
    })) as CursorTask[];
    const cursor = page1[1]!.cursor!;
    const page2 = (await client.searchTasks(PROJECT_OID, {
      tag: tag.oid,
      limit: 2,
      cursor,
    })) as CursorTask[];
    expect(page2.length).toBe(1);
    expect(page2[0]!.cursor).toBeUndefined();
    expect(childOids).toContain(page2[0]!.oid);
  });
});

/**
 * Live API tests for relative task creation (TPos1-TPos3).
 *
 *   POST /task/{oid}?position=before|after|parent
 *
 * When `oid` refers to a task, `position` controls where the new task lands:
 *   - before → sibling placed before the target
 *   - after  → sibling placed after the target
 *   - parent → subtask of the target (default — equivalent to omitting)
 *
 * `parent` is already covered by createSubtask (the default subtask path).
 * This block focuses on `before` / `after` at root level (TPos1, TPos2)
 * and within a subtask list (TPos3). QuireClient wraps the endpoint as
 * `createTaskRelative(siblingOid, body, position)`.
 *
 * Fixture: one root anchor task plus one anchor subtask. We verify ordering
 * via /task/list/{parentOid}, which returns siblings in display order. The
 * POST-create response does NOT include `parent` on the returned task, so
 * verification has to go through a list call.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — task position", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  let anchor: QuireTask;
  let anchorSub: QuireTask;
  const createdOids: string[] = [];

  beforeAll(async () => {
    anchor = await client.createTask(PROJECT_OID, {
      name: `${runTag}-pos-anchor`,
    });
    anchorSub = await client.createSubtask(anchor.oid, {
      name: `${runTag}-pos-anchor-sub`,
    });
  });

  afterAll(async () => {
    for (const oid of [...createdOids].reverse()) {
      await client.deleteTask(oid).catch(() => {});
    }
    if (anchorSub?.oid) await client.deleteTask(anchorSub.oid).catch(() => {});
    if (anchor?.oid) await client.deleteTask(anchor.oid).catch(() => {});
  });

  it("TPos1 createTaskRelative(<rootAnchor>, …, 'before') creates a sibling before the anchor", async () => {
    const created = await client.createTaskRelative(
      anchor.oid,
      { name: `${runTag}-pos-before` },
      "before",
    );
    createdOids.push(created.oid);

    const list = await client.listTasks(PROJECT_OID);
    const newIdx = list.findIndex((t) => t.oid === created.oid);
    const anchorIdx = list.findIndex((t) => t.oid === anchor.oid);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(anchorIdx);
  });

  it("TPos2 createTaskRelative(<rootAnchor>, …, 'after') creates a sibling after the anchor", async () => {
    const created = await client.createTaskRelative(
      anchor.oid,
      { name: `${runTag}-pos-after` },
      "after",
    );
    createdOids.push(created.oid);

    const list = await client.listTasks(PROJECT_OID);
    const newIdx = list.findIndex((t) => t.oid === created.oid);
    const anchorIdx = list.findIndex((t) => t.oid === anchor.oid);
    expect(newIdx).toBeGreaterThan(anchorIdx);
  });

  it("TPos3 createTaskRelative(<subtaskAnchor>, …, 'before') creates a subtask sibling", async () => {
    const created = await client.createTaskRelative(
      anchorSub.oid,
      { name: `${runTag}-pos-sub-before` },
      "before",
    );
    createdOids.push(created.oid);

    // Use rawApi here because the wrapped listSubtasks API doesn't matter —
    // we just need siblings of anchorSub under anchor. Either works; rawApi
    // keeps the intent obvious.
    const list = await rawApi<QuireTask[]>("GET", `/task/list/${anchor.oid}`);
    expect(list.status).toBe(200);
    const newIdx = list.data.findIndex((t) => t.oid === created.oid);
    const subIdx = list.data.findIndex((t) => t.oid === anchorSub.oid);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(subIdx);
  });
});

/**
 * Live API tests for /task/move + /task/transfer ?position= (TMP1-TMP4).
 *
 * `?position=` extends move and transfer with the same `parent | before |
 * after` grammar used by relative-create. Without it, the moved /
 * transferred task becomes a CHILD of `?task=`. With `before` / `after`,
 * it becomes a SIBLING of `?task=`, under that reference's parent.
 *
 * Tests verify ordering via the parent's `/task/list/{parentOid}` (siblings
 * in display order). For root-level siblings, the project's
 * `/task/list/{projectOid}` plays the same role.
 *
 * QuireClient.moveTask accepts an optional `position` argument matching
 * the wire grammar. QuireClient.transferTask accepts the same.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

// Mirrors /task/transfer fixture — optional second project for the
// cross-project sibling case (TMP4). When unset, TMP4 skips; TMP1-3 still run.
const SOURCE_PROJECT_ID = readEnvOptional("QUIRE_TEST_TRANSFER_PROJECT_ID");

describe.skipIf(!hasTokens)("Live API — /task/move ?position=", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let parent: QuireTask;
  let anchor: QuireTask;
  let moverOid = "";

  beforeAll(async () => {
    // Build: parent → [anchor (existing child), mover (sibling we'll move
    // around)]. Re-anchor mover before each test to keep cases independent.
    parent = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tm-parent`,
    });
    anchor = await client.createSubtask(parent.oid, {
      name: `${runTag}-tm-anchor`,
    });
    const mover = await client.createSubtask(parent.oid, {
      name: `${runTag}-tm-mover`,
    });
    moverOid = mover.oid;
  });

  afterAll(async () => {
    if (parent?.oid) await client.deleteTask(parent.oid).catch(() => {});
  });

  it("TMP1 moveTask(mover, anchor, 'before') places mover as sibling before anchor", async () => {
    await client.moveTask(moverOid, anchor.oid, "before");

    const list = await client.listSubtasks(parent.oid);
    const moverIdx = list.findIndex((t) => t.oid === moverOid);
    const anchorIdx = list.findIndex((t) => t.oid === anchor.oid);
    expect(moverIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(moverIdx).toBeLessThan(anchorIdx);
    // Mover stays a sibling of anchor (NOT a child of it).
    const anchorChildren = await client.listSubtasks(anchor.oid);
    expect(anchorChildren.some((t) => t.oid === moverOid)).toBe(false);
  });

  it("TMP2 moveTask(mover, anchor, 'after') places mover as sibling after anchor", async () => {
    await client.moveTask(moverOid, anchor.oid, "after");

    const list = await client.listSubtasks(parent.oid);
    const moverIdx = list.findIndex((t) => t.oid === moverOid);
    const anchorIdx = list.findIndex((t) => t.oid === anchor.oid);
    expect(moverIdx).toBeGreaterThan(anchorIdx);
  });

  it("TMP3 moveTask(mover, anchor, 'parent') makes mover a child of anchor (pre-Apr-27 behavior)", async () => {
    await client.moveTask(moverOid, anchor.oid, "parent");

    const anchorChildren = await client.listSubtasks(anchor.oid);
    expect(anchorChildren.some((t) => t.oid === moverOid)).toBe(true);
    // No longer a direct child of parent.
    const parentChildren = await client.listSubtasks(parent.oid);
    expect(parentChildren.some((t) => t.oid === moverOid)).toBe(false);
  });

  it.skipIf(!SOURCE_PROJECT_ID)("TMP4 transferTask({task:anchor, position:'before'}) lands cross-project as sibling", async () => {
    // Create a task in the source project (by id), transfer in with
    // anchor+position so it ends up as anchor's sibling under `parent`.
    const xfer = await rawApi<QuireTask>(
      "POST",
      `/task/id/${encodeURIComponent(SOURCE_PROJECT_ID!)}`,
      { name: `${runTag}-tm-xfer` },
    );
    expect(xfer.status).toBe(200);
    const xferOid = xfer.data.oid;
    try {
      await client.transferTask(xferOid, {
        project: PROJECT_OID,
        task: anchor.oid,
        position: "before",
      });

      const list = await client.listSubtasks(parent.oid);
      const xferIdx = list.findIndex((t) => t.oid === xferOid);
      const anchorIdx = list.findIndex((t) => t.oid === anchor.oid);
      expect(xferIdx).toBeGreaterThanOrEqual(0);
      expect(anchorIdx).toBeGreaterThanOrEqual(0);
      expect(xferIdx).toBeLessThan(anchorIdx);
    } finally {
      // After transfer the task lives under `parent`, so afterAll's cascade
      // delete picks it up. Defensive cleanup in case of partial state.
      await client.deleteTask(xferOid).catch(() => {});
    }
  });
});

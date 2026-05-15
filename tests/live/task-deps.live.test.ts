/**
 * Live API tests for task dependencies (successors / predecessors) —
 * T21-T24.
 *
 * Only the `successors` list on the source task is editable. `predecessors`
 * is computed server-side by reverse lookup and is read-only.
 *
 * PUT /task/{oid} accepts addSuccessors / removeSuccessors in the same
 * delta style as addTags / addAssignees. Each element accepts:
 *   - a task OID (string)
 *   - a numeric id (int)
 *   - "#<id>" (string)
 *   - "*" — remove-only wildcard
 *
 * Response shape: `successors` and `predecessors` are string arrays in
 * "#<numeric-id>" form. Both fields only appear when non-empty.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — task dependencies", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  let source: QuireTask;
  let successor: QuireTask;

  beforeAll(async () => {
    source = await client.createTask(PROJECT_OID, {
      name: `${runTag}-dep-source`,
    });
    successor = await client.createTask(PROJECT_OID, {
      name: `${runTag}-dep-succ`,
    });
  });

  afterAll(async () => {
    if (source?.oid) await client.deleteTask(source.oid).catch(() => {});
    if (successor?.oid) await client.deleteTask(successor.oid).catch(() => {});
  });

  it("T21 updateTask({addSuccessors}) links two tasks; GET shows the link on both sides", async () => {
    await client.updateTask(source.oid, { addSuccessors: [successor.oid] });

    const src = await client.getTask(source.oid);
    expect(src.successors).toContain(`#${successor.id}`);

    const dst = await client.getTask(successor.oid);
    expect(dst.predecessors).toContain(`#${source.id}`);
  });

  it("T22 updateTask({removeSuccessors}) drops the link from both sides", async () => {
    await client.updateTask(source.oid, {
      removeSuccessors: [successor.oid],
    });

    const src = await client.getTask(source.oid);
    expect(src.successors ?? []).not.toContain(`#${successor.id}`);

    const dst = await client.getTask(successor.oid);
    expect(dst.predecessors ?? []).not.toContain(`#${source.id}`);
  });

  it("T23 updateTask({removeSuccessors:['*']}) clears every successor at once", async () => {
    const extra = await client.createTask(PROJECT_OID, {
      name: `${runTag}-dep-extra`,
    });
    try {
      await client.updateTask(source.oid, {
        addSuccessors: [successor.oid, extra.oid],
      });

      await client.updateTask(source.oid, { removeSuccessors: ["*"] });

      const src = await client.getTask(source.oid);
      expect(src.successors ?? []).toEqual([]);
    } finally {
      await client.deleteTask(extra.oid).catch(() => {});
    }
  });

  it("T24 updateTask({addSuccessors:['#<id>']}) accepts the '#<numeric-id>' form", async () => {
    await client.updateTask(source.oid, {
      addSuccessors: [`#${successor.id}`],
    });

    const src = await client.getTask(source.oid);
    expect(src.successors).toContain(`#${successor.id}`);

    // Reset so T21/T22 re-runs on the same fixtures start clean.
    await client.updateTask(source.oid, { removeSuccessors: ["*"] });
  });
});

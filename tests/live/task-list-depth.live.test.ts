/**
 * Live API tests for /task/list ?depth= subtree fetch (TT1-TT5).
 *
 * `GET /task/list/{taskOid}?depth=N|full` walks the task's subtree in one
 * call instead of N+1 calls per level. Each task carries a nested `tasks`
 * field for its walked children. Constraints:
 *   - Anchor required: ?depth>1 rejects the whole-project case
 *     (`/task/list/{projectOid}?depth>1` → 400).
 *   - Plan-tier cap: Free → 402; Pro 500; Premium 2000; Enterprise unbounded.
 *     When the cap is hit, the last sibling at the cropped level carries
 *     `cropped: true` and the caller drills into that level via a follow-up
 *     `/task/list/{parentOid}` call.
 *   - ?status= cascades per-branch all-or-nothing — a non-matching child
 *     is excluded along with its descendants.
 *   - ?return=compact renders nodes as { oid, id, tasks?, cropped? }; tree
 *     shape is unchanged.
 *
 * Fixture: parent → [child1 → grandchild1, child2] (3 levels) so depth=2
 * vs depth=full are distinguishable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTask, QuireTaskNode } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/list ?depth=", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let parentOid = "";
  let child1Oid = "";
  let child2Oid = "";
  let child2Id = 0;
  let grandchildOid = "";

  beforeAll(async () => {
    const parent = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tt-parent`,
    });
    parentOid = parent.oid;

    const child1 = await client.createSubtask(parentOid, {
      name: `${runTag}-tt-child1`,
    });
    child1Oid = child1.oid;

    const grandchild = await client.createSubtask(child1Oid, {
      name: `${runTag}-tt-grandchild1`,
    });
    grandchildOid = grandchild.oid;

    const child2 = await client.createSubtask(parentOid, {
      name: `${runTag}-tt-child2`,
    });
    child2Oid = child2.oid;
    child2Id = child2.id;
  });

  afterAll(async () => {
    // Cascade-removes the whole subtree.
    if (parentOid) await client.deleteTask(parentOid).catch(() => {});
  });

  it("TT1 listTaskTree({depth:2}) returns one extra level deep", async () => {
    const data = await client.listTaskTree(parentOid, { depth: 2 });
    const c1 = data.find((t) => t.oid === child1Oid);
    const c2 = data.find((t) => t.oid === child2Oid);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    // child1 has a grandchild → its `tasks` must contain it.
    expect(c1!.tasks?.some((t) => t.oid === grandchildOid)).toBe(true);
    // child2 has no children → `tasks` should be absent or empty.
    if (c2!.tasks !== undefined) expect(c2!.tasks).toEqual([]);
  });

  it("TT2 listTaskTree({depth:'full'}) walks the whole subtree", async () => {
    const data = await client.listTaskTree(parentOid, { depth: "full" });
    const c1 = data.find((t) => t.oid === child1Oid);
    expect(c1?.tasks?.some((t) => t.oid === grandchildOid)).toBe(true);
    const gc = c1?.tasks?.find((t) => t.oid === grandchildOid);
    if (gc?.tasks !== undefined) expect(gc.tasks).toEqual([]);
  });

  it("TT3 listTaskTree({depth:'full', status:'active'}) cascades — excluding a branch drops its descendants", async () => {
    await client.updateTask(child1Oid, { status: 100 });
    try {
      const data = await client.listTaskTree(parentOid, {
        depth: "full",
        status: "active",
      });
      expect(data.some((t) => t.oid === child1Oid)).toBe(false);
      const flatten = (nodes: QuireTaskNode[]): QuireTaskNode[] =>
        nodes.flatMap((n) => [n, ...flatten(n.tasks ?? [])]);
      expect(flatten(data).some((t) => t.oid === grandchildOid)).toBe(false);
      expect(data.some((t) => t.oid === child2Oid)).toBe(true);
    } finally {
      await client.updateTask(child1Oid, { status: 0 });
    }
  });

  it("TT4 listTaskTree({depth:2, return:'compact'}) renders {oid, id, tasks?}", async () => {
    const data = await client.listTaskTree(parentOid, {
      depth: 2,
      return: "compact",
    });
    const c2 = data.find((t) => t.oid === child2Oid);
    expect(c2).toBeDefined();
    expect(c2!.id).toBe(child2Id);
    // Compact must NOT carry full task fields.
    expect((c2 as unknown as Record<string, unknown>).name).toBeUndefined();
    expect((c2 as unknown as Record<string, unknown>).status).toBeUndefined();
    const c1 = data.find((t) => t.oid === child1Oid);
    expect(c1!.tasks?.some((t) => t.oid === grandchildOid)).toBe(true);
  });

  it("TT5 ?depth>1 without a task anchor returns 400", async () => {
    // Anchor-required rule: /task/list/{projectOid}?depth>1 → 400. The
    // client doesn't expose the project-as-anchor case (rightly), so probe
    // with rawApi.
    const res = await rawApi<QuireTask[]>(
      "GET",
      `/task/list/${PROJECT_OID}?depth=2`,
    );
    expect(res.status).toBe(400);
  });
});

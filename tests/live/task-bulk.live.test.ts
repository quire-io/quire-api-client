/**
 * Live API tests for bulk task endpoints (TBA, TBU, TBM, TBP, TBX, TBD).
 *
 * Wire shape (project-scoped, atomic, up to 300 items per call):
 *   - Body is a top-level JSON array. Mixed-form refs (OID / integer id /
 *     "#<id>") are accepted on bulk-update / bulk-remove / bulk-move /
 *     bulk-approve.
 *   - Response is the same-length array (one element per input slot, with
 *     null placeholders for skip-not-found on update / remove).
 *   - ?return=compact renders {oid, id} per non-null slot. Required on
 *     bulk-approve to reduce its response from full Approval objects.
 *   - Per-item errors prefix items[i]: in the thrown body; the whole batch
 *     rolls back atomically.
 *
 * Each test creates its own throwaway tasks and cleans up — no shared
 * fixture, so cases can be retried individually.
 */

import { describe, it, expect } from "vitest";
import type { QuireApproval, QuireTask } from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

type CompactTask = { oid: string; id: number };

describe.skipIf(!hasTokens)("Live API — bulk task endpoints", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  it("TBA1 bulkCreateTasks(projectOid, …, {return:'compact'}) creates N root tasks atomically", async () => {
    const items = [
      { name: `${runTag}-tba1-a` },
      { name: `${runTag}-tba1-b`, priority: "High" },
      { name: `${runTag}-tba1-c` },
    ];
    const created = (await client.bulkCreateTasks(PROJECT_OID, items, {
      return: "compact",
    })) as unknown as CompactTask[];
    expect(created).toHaveLength(3);
    for (const t of created) {
      expect(typeof t.oid).toBe("string");
      expect(typeof t.id).toBe("number");
    }
    await client.bulkRemoveTasks(
      PROJECT_OID,
      created.map((t) => t.oid),
    );
  });

  it("TBA2 bulkCreateSubtasks(parentOid, …) anchors items as subtasks of a parent", async () => {
    const parent = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tba2-parent`,
    });
    try {
      const items = [
        { name: `${runTag}-tba2-c1` },
        { name: `${runTag}-tba2-c2` },
      ];
      const created = (await client.bulkCreateSubtasks(parent.oid, items, {
        return: "compact",
      })) as unknown as CompactTask[];
      expect(created).toHaveLength(2);

      const list = await client.listSubtasks(parent.oid);
      for (const t of created) {
        expect(list.some((x) => x.oid === t.oid)).toBe(true);
      }
    } finally {
      await client.deleteTask(parent.oid).catch(() => {}); // cascade
    }
  });

  it("TBU1 bulkUpdateTasks updates N tasks atomically", async () => {
    const a = await client.createTask(PROJECT_OID, { name: `${runTag}-tbu1-a` });
    const b = await client.createTask(PROJECT_OID, { name: `${runTag}-tbu1-b` });
    try {
      const items = [
        { oid: a.oid, name: `${runTag}-tbu1-a-updated`, priority: "High" },
        { oid: b.oid, description: "added body" },
      ];
      const updated = (await client.bulkUpdateTasks(PROJECT_OID, items, {
        return: "compact",
      })) as unknown as CompactTask[];
      expect(updated).toHaveLength(2);

      const aAfter = await client.getTask(a.oid);
      expect(aAfter.name).toBe(`${runTag}-tbu1-a-updated`);
      expect(aAfter.priority?.name).toBe("High");
      const bAfter = await client.getTask(b.oid);
      expect((bAfter.descriptionText ?? bAfter.description ?? "")).toContain(
        "added body",
      );
    } finally {
      await client.bulkRemoveTasks(PROJECT_OID, [a.oid, b.oid]);
    }
  });

  it("TBM1 bulkMoveTasks({task:anchor}) reparents N tasks", async () => {
    const anchor = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tbm1-anchor`,
    });
    const a = await client.createTask(PROJECT_OID, { name: `${runTag}-tbm1-a` });
    const b = await client.createTask(PROJECT_OID, { name: `${runTag}-tbm1-b` });
    try {
      const moved = (await client.bulkMoveTasks(PROJECT_OID, [a.oid, b.oid], {
        task: anchor.oid,
      })) as unknown as CompactTask[];
      expect(moved).toHaveLength(2);

      const list = await client.listSubtasks(anchor.oid);
      expect(list.some((t) => t.oid === a.oid)).toBe(true);
      expect(list.some((t) => t.oid === b.oid)).toBe(true);
    } finally {
      // Cascade-remove via the anchor.
      await client.deleteTask(anchor.oid).catch(() => {});
    }
  });

  it("TBP1 bulkApproveTasks({state:'request'}) opens approval on N tasks", async () => {
    const a = await client.createTask(PROJECT_OID, { name: `${runTag}-tbp1-a` });
    const b = await client.createTask(PROJECT_OID, { name: `${runTag}-tbp1-b` });
    try {
      const approvals = await client.bulkApproveTasks(
        PROJECT_OID,
        [a.oid, b.oid],
        { state: "request", return: "compact" },
      );
      expect(approvals).toHaveLength(2);

      const aAfter = (await client.getTask(a.oid)) as QuireTask & {
        approval?: QuireApproval;
      };
      expect(aAfter.approval?.state).toBe("awaiting");
      const bAfter = (await client.getTask(b.oid)) as QuireTask & {
        approval?: QuireApproval;
      };
      expect(bAfter.approval?.state).toBe("awaiting");
    } finally {
      await client.bulkRemoveTasks(PROJECT_OID, [a.oid, b.oid]);
    }
  });

  // bulk-transfer needs a SECOND project distinct from QUIRE_TEST_PROJECT_ID,
  // configured via QUIRE_TEST_FREE_PROJECT_ID. Skip when not set.
  const FREE_PROJECT_ID = readEnvOptional("QUIRE_TEST_FREE_PROJECT_ID");
  const TARGET_PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");

  it.skipIf(!FREE_PROJECT_ID)(
    "TBX1 bulkTransferTasks moves N tasks across projects (id-form URL)",
    async () => {
      // bulkCreateTasks wraps the OID form; the id-form (bulk-add/id/{slug})
      // is not exposed. Probe it raw to seed fixtures in the source project.
      const items = [
        { name: `${runTag}-tbx1-a` },
        { name: `${runTag}-tbx1-b` },
        { name: `${runTag}-tbx1-c` },
      ];
      const created = await rawApi<CompactTask[]>(
        "POST",
        `/task/bulk-add/id/${encodeURIComponent(FREE_PROJECT_ID!)}?return=compact`,
        items,
      );
      expect(created.status).toBe(200);
      const oids = created.data.map((t) => t.oid);

      let transferred = false;
      try {
        // Same id-form story for bulk-transfer — drop to rawApi.
        const xfer = await rawApi<CompactTask[]>(
          "PUT",
          `/task/bulk-transfer/id/${encodeURIComponent(FREE_PROJECT_ID!)}?project=${encodeURIComponent(TARGET_PROJECT_ID)}&return=compact`,
          oids,
        );
        expect(xfer.status).toBe(200);
        expect(xfer.data).toHaveLength(3);
        transferred = true;

        const targetList = await rawApi<QuireTask[]>(
          "GET",
          `/task/list/id/${encodeURIComponent(TARGET_PROJECT_ID)}`,
        );
        for (const oid of oids) {
          expect(targetList.data.some((t) => t.oid === oid)).toBe(true);
        }

        const sourceList = await rawApi<QuireTask[]>(
          "GET",
          `/task/list/id/${encodeURIComponent(FREE_PROJECT_ID!)}`,
        );
        for (const oid of oids) {
          expect(sourceList.data.some((t) => t.oid === oid)).toBe(false);
        }
      } finally {
        // After transfer, tasks live in TARGET; if transfer failed, in FREE.
        const cleanupProjectId = transferred
          ? TARGET_PROJECT_ID
          : FREE_PROJECT_ID!;
        await rawApi(
          "DELETE",
          `/task/bulk-remove/id/${encodeURIComponent(cleanupProjectId)}`,
          oids,
        );
      }
    },
  );

  it("TBD1 bulkRemoveTasks removes N tasks atomically", async () => {
    const a = await client.createTask(PROJECT_OID, { name: `${runTag}-tbd1-a` });
    const b = await client.createTask(PROJECT_OID, { name: `${runTag}-tbd1-b` });
    const c = await client.createTask(PROJECT_OID, { name: `${runTag}-tbd1-c` });

    const removed = await client.bulkRemoveTasks(PROJECT_OID, [
      a.oid,
      b.oid,
      c.oid,
    ]);
    expect(removed).toHaveLength(3);

    for (const oid of [a.oid, b.oid, c.oid]) {
      const get = await rawApi("GET", `/task/${oid}`);
      expect(get.status).toBe(404);
    }
  });

  // dry-run rolls back inside a transaction (May 22 2026). The response
  // mirrors the real call's shape but no DB changes persist. Each test
  // verifies (a) the response shape, (b) absence of the side effect.

  it("TBDRY1 bulkCreateTasks dry-run returns compact rows but persists nothing", async () => {
    const items = [
      { name: `${runTag}-tbdry1-a` },
      { name: `${runTag}-tbdry1-b` },
    ];
    const previewed = (await client.bulkCreateTasks(PROJECT_OID, items, {
      return: "compact",
      dryRun: true,
    })) as unknown as CompactTask[];
    // Server still validates and shapes the response.
    expect(previewed).toHaveLength(2);
    for (const t of previewed) {
      // Server may either omit the oid or hand back a synthetic placeholder
      // — either way, none of the previewed oids should resolve via GET.
      if (t?.oid) {
        const get = await rawApi("GET", `/task/${t.oid}`);
        expect(get.status).toBe(404);
      }
    }
    // Nothing matching the names should exist in the project either.
    const list = await client.listTasks(PROJECT_OID);
    for (const name of items.map((i) => i.name)) {
      expect(list.some((t) => t.name === name)).toBe(false);
    }
  });

  it("TBDRY2 bulkUpdateTasks dry-run shapes the response but leaves fields untouched", async () => {
    const a = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tbdry2-a`,
    });
    const b = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tbdry2-b`,
    });
    try {
      const items = [
        { oid: a.oid, name: `${runTag}-tbdry2-a-WOULD-UPDATE`, priority: "High" },
        { oid: b.oid, description: "would-add-body" },
      ];
      const previewed = (await client.bulkUpdateTasks(PROJECT_OID, items, {
        return: "compact",
        dryRun: true,
      })) as unknown as CompactTask[];
      expect(previewed).toHaveLength(2);

      // Rollback check — the original values should still be present.
      const aAfter = await client.getTask(a.oid);
      expect(aAfter.name).toBe(`${runTag}-tbdry2-a`);
      expect(aAfter.priority?.name ?? "").not.toBe("High");
      const bAfter = await client.getTask(b.oid);
      expect((bAfter.descriptionText ?? bAfter.description ?? "")).not.toContain(
        "would-add-body",
      );
    } finally {
      await client.bulkRemoveTasks(PROJECT_OID, [a.oid, b.oid]);
    }
  });

  it("TBDRY3 bulkRemoveTasks dry-run reports the planned removal but tasks survive", async () => {
    const a = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tbdry3-a`,
    });
    const b = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tbdry3-b`,
    });
    try {
      const previewed = await client.bulkRemoveTasks(
        PROJECT_OID,
        [a.oid, b.oid],
        { dryRun: true },
      );
      expect(previewed).toHaveLength(2);

      // Both tasks should still be fetchable.
      for (const oid of [a.oid, b.oid]) {
        const get = await rawApi("GET", `/task/${oid}`);
        expect(get.status).toBe(200);
      }
    } finally {
      await client.bulkRemoveTasks(PROJECT_OID, [a.oid, b.oid]);
    }
  });
});

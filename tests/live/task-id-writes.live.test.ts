/**
 * Live API tests for write endpoints via the /id/{projectId}/{taskId}
 * URL form (TID1-TID6).
 *
 * Quire exposes two URL forms for a task:
 *   /task/{oid}                   — canonical OID form (what QuireClient wraps)
 *   /task/id/{projectId}/{taskId} — project-id + numeric task-id
 *
 * QuireClient deliberately only wraps the OID form. These tests probe the
 * id-form for PUT update / PUT move / PUT undo-remove / DELETE so the
 * contract stays verified — if Quire ever drops support, a future
 * `*ByProjectAndId` helper would surface the regression here.
 *
 * Each test creates its own fixture so the block can run as
 *   npx vitest run --project live tests/live/task-id-writes.live.test.ts -t "TID"
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTag, QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/id/ write endpoints", () => {
  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const createdOids: string[] = [];
  let tag: QuireTag;

  beforeAll(async () => {
    tag = await client.createTag(PROJECT_OID, {
      name: `${runTag}-id-write-tag`,
    });
  });

  afterAll(async () => {
    for (const oid of createdOids) {
      await client.deleteTask(oid).catch(() => {});
    }
    if (tag?.oid) await client.deleteTag(tag.oid).catch(() => {});
  });

  async function createTask(suffix: string): Promise<QuireTask> {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-${suffix}`,
    });
    createdOids.push(t.oid);
    return t;
  }

  function idPath(t: QuireTask): string {
    return `/task/id/${encodeURIComponent(PROJECT_ID)}/${t.id}`;
  }

  it("TID1 PUT /task/id/{projectId}/{taskId} updates name + description", async () => {
    const t = await createTask("tid1");
    const NEW_NAME = `${runTag}-tid1 renamed`;
    const { status, data } = await rawApi<QuireTask>("PUT", idPath(t), {
      name: NEW_NAME,
      description: "tid1 body",
    });
    expect(status).toBe(200);
    expect(data.oid).toBe(t.oid);
    expect(data.nameText ?? data.name).toBe(NEW_NAME);
    expect(data.descriptionText ?? data.description).toContain("tid1 body");
  });

  it("TID2 PUT /task/id/{projectId}/{taskId} accepts status, dates, and delta tags in one call", async () => {
    const t = await createTask("tid2");
    const { status, data } = await rawApi<QuireTask>("PUT", idPath(t), {
      status: 100,
      start: "2026-05-15",
      due: "2026-06-01",
      addTags: [tag.oid],
    });
    expect(status).toBe(200);
    const s = typeof data.status === "object" ? data.status?.value : data.status;
    expect(s).toBe(100);
    expect(data.start).toBe("2026-05-15");
    expect(data.due).toBe("2026-06-01");
    expect(data.tags?.some((x) => x.oid === tag.oid)).toBe(true);
  });

  it("TID3 PUT /task/id/{projectId}/{taskId} clears dates via null", async () => {
    const t = await createTask("tid3");
    // Seed the dates via the wrapper (oid form) first so the clear has
    // something to clear.
    await client.updateTask(t.oid, {
      start: "2026-05-15",
      due: "2026-06-01",
    });
    const { status, data } = await rawApi<QuireTask>("PUT", idPath(t), {
      start: null,
      due: null,
    });
    expect(status).toBe(200);
    expect(data.start).toBeFalsy();
    expect(data.due).toBeFalsy();
  });

  it("TID4 PUT /task/move/id/{projectId}/{taskId}?task=root reparents via id form", async () => {
    const parent = await createTask("tid4-parent");
    const child = await client.createSubtask(parent.oid, {
      name: `${runTag}-tid4-child`,
    });
    createdOids.push(child.oid);

    const toRoot = await rawApi<QuireTask>(
      "PUT",
      `/task/move/id/${encodeURIComponent(PROJECT_ID)}/${child.id}?task=root`,
    );
    expect(toRoot.status).toBe(200);

    const got = await client.getTask(child.oid);
    expect(got.parent).toBeFalsy();
  });

  it("TID5 PUT /task/undo-remove/id/{projectId}/{taskId} restores a removed task", async () => {
    const t = await createTask("tid5");
    await client.deleteTask(t.oid);
    expect((await rawApi("GET", `/task/${t.oid}`)).status).toBe(404);

    const undo = await rawApi<QuireTask>(
      "PUT",
      `/task/undo-remove/id/${encodeURIComponent(PROJECT_ID)}/${t.id}`,
    );
    expect(undo.status).toBe(200);
    expect(undo.data.oid).toBe(t.oid);

    expect((await rawApi("GET", `/task/${t.oid}`)).status).toBe(200);
  });

  it("TID6 DELETE /task/id/{projectId}/{taskId} removes the task via id form", async () => {
    const t = await createTask("tid6");
    const del = await rawApi("DELETE", idPath(t));
    expect([200, 204]).toContain(del.status);
    // Drop from cleanup so afterAll doesn't double-delete.
    const i = createdOids.indexOf(t.oid);
    if (i >= 0) createdOids.splice(i, 1);

    expect((await rawApi("GET", `/task/${t.oid}`)).status).toBe(404);
  });
});

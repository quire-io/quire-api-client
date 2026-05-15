/**
 * Live-API tests for /task endpoints.
 *
 * Each test runs against a real Quire workspace via the bearer token in
 * `~/.config/quire/test-api.env` (see helpers.ts for resolution). Setup is
 * gated by `describe.skipIf(!hasTokens)`, so this file cleanly no-ops when
 * the env is missing.
 *
 * Pilot scope: T1–T17c — task CRUD + search + subtasks + tags + assignees
 * + dates + move + status + delete + undo-remove. Custom fields, /id/ write
 * endpoints, transfer, recurrence, peekaboo, dependencies, position, type
 * conversion, approval, bulk, timelogs, pagination, and inbox follow in
 * companion describe blocks (one per concern).
 *
 * Style: prefer `client.method()` so a test failure pinpoints whether the
 * QuireClient wrapper or the underlying API drifted. Drop to `rawApi(...)`
 * only when the test's intent is to probe path shape (id-form URLs) or a
 * specific non-2xx response that QuireClient deliberately throws on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  runTag,
} from "./helpers.js";
import type { QuireTag, QuireTask, QuireUser } from "../../src/index.js";

describe.skipIf(!hasTokens)("Quire API — /task", () => {
  // describe.skipIf marks tests as skipped but vitest still EXECUTES this
  // callback during collection. Without this guard, the readEnv / liveClient
  // calls below would throw against an empty env file before vitest gets a
  // chance to apply the skip.
  if (!hasTokens) return;

  const client = liveClient();

  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const ORG_OID = readEnv("QUIRE_TEST_ORG_OID");
  // Folder ID of the containing folder in the test workspace
  // (https://quire.io/f/Test03). Stable fixture, safe to hardcode.
  const FOLDER_ID = "Test03";
  const SEARCH_MARKER = `zxq${Date.now()}`; // high-entropy keyword for T5
  const TASK_NAME = `${runTag}-task ${SEARCH_MARKER}`;

  let task: QuireTask;
  let subtask: QuireTask;
  let tag: QuireTag;
  let me: QuireUser;

  beforeAll(async () => {
    me = await client.getMe();
    tag = await client.createTag(PROJECT_OID, { name: `${runTag}-task-tag` });
  });

  afterAll(async () => {
    // T17 deletes `task`, which cascades to `subtask`. Guard cleanup in case
    // earlier tests threw.
    if (task?.oid) {
      await client.deleteTask(task.oid).catch(() => {});
    }
    if (tag?.oid) {
      await client.deleteTag(tag.oid).catch(() => {});
    }
  });

  it("T1 createTask sets all base fields and returns oid + numeric id", async () => {
    task = await client.createTask(PROJECT_OID, {
      name: TASK_NAME,
      description: "t1 body",
      priority: "High",
      due: "2026-05-01",
    });
    expect(task.oid).toBeTruthy();
    expect(task.id).toBeGreaterThan(0);
    expect(task.nameText ?? task.name).toBe(TASK_NAME);
    expect(task.priority?.name).toBe("High");
    expect(task.priority?.value).toBe(1);
    expect(task.due).toBe("2026-05-01");
  });

  // QuireClient.createTask takes an OID — there's no method-level support for
  // the `/task/id/{projectId}` URL form. Probe it raw to keep the contract
  // verified, then clean up.
  it("T1b POST /task/id/{projectId} — creation via project id works", async () => {
    const { status, data } = await rawApi<QuireTask>(
      "POST",
      `/task/id/${encodeURIComponent(PROJECT_ID)}`,
      { name: `${runTag}-by-id` },
    );
    expect(status).toBe(200);
    expect(data.oid).toBeTruthy();
    await client.deleteTask(data.oid);
  });

  it("T2 listTasks includes the new task", async () => {
    const tasks = await client.listTasks(PROJECT_OID);
    expect(tasks.some((t) => t.oid === task.oid)).toBe(true);
  });

  it("T3 getTask returns matching fields", async () => {
    const got = await client.getTask(task.oid);
    expect(got.oid).toBe(task.oid);
    expect(got.nameText ?? got.name).toBe(TASK_NAME);
  });

  it("T4 getTaskByProjectAndId returns same oid", async () => {
    const got = await client.getTaskByProjectAndId(PROJECT_ID, task.id);
    expect(got.oid).toBe(task.oid);
  });

  it("T5 searchTasks text filter finds the task", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { text: SEARCH_MARKER });
    expect(hits.some((t) => t.oid === task.oid)).toBe(true);
  });

  // Org-scoped search is paid-plan-gated. The test org is paid, so a 403
  // ecQuotaExceeded here means the fixture changed plan. Response decorates
  // each task with `project: { oid, id }` since results can span projects.
  it("T5a searchTasksInOrganization finds the task with project field", async () => {
    const hits = await client.searchTasksInOrganization(ORG_OID, {
      text: SEARCH_MARKER,
    });
    const hit = hits.find((t) => t.oid === task.oid);
    expect(hit).toBeTruthy();
    expect(hit?.project?.oid).toBe(PROJECT_OID);
    expect(hit?.project?.id).toBe(PROJECT_ID);
  });

  // Folder-scoped search uses the same decorated shape as org-scoped. The
  // `/id/{folderId}` URL form is not exposed on QuireClient.searchTasksInFolder
  // (which takes an OID), so probe it raw.
  it("T5b GET /task/search-folder/id/{folderId} finds the task", async () => {
    const { status, data } = await rawApi<QuireTask[]>(
      "GET",
      `/task/search-folder/id/${encodeURIComponent(FOLDER_ID)}?text=${encodeURIComponent(SEARCH_MARKER)}`,
    );
    expect(status).toBe(200);
    expect(data.some((t) => t.oid === task.oid)).toBe(true);
  });

  // Rich-param coverage for project-scoped search: `status=active` filters
  // to incomplete tasks; `limit=5` caps the result set. Free-plan max is 30.
  it("T5c searchTasks honours status + limit", async () => {
    const hits = await client.searchTasks(PROJECT_OID, {
      status: "active",
      limit: 5,
    });
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const t of hits) {
      expect(t.status?.value ?? 0).toBeLessThan(100);
    }
  });

  // Custom-field filter. Quire flattens customFields into top-level query
  // params keyed by display name; QuireClient handles the flattening.
  // Sets `Cost` on the main task first so there's something to match.
  it("T5d searchTasks with customFields filter finds the task", async () => {
    await client.updateTask(task.oid, { customFields: { Cost: 100 } });
    const hits = await client.searchTasks(PROJECT_OID, {
      customFields: { Cost: 100 },
    });
    expect(hits.some((t) => t.oid === task.oid)).toBe(true);
  });

  // `mine=true` finds tasks assigned to the current user. Idempotent with
  // T12 which later asserts the same state.
  it("T5e searchTasks with mine=true finds tasks assigned to me", async () => {
    await client.updateTask(task.oid, { assignees: [me.oid] });
    const hits = await client.searchTasks(PROJECT_OID, { mine: true });
    expect(hits.some((t) => t.oid === task.oid)).toBe(true);
  });

  // `modified` uses an interval string like "7d" / "3h" / "30m".
  it("T5f searchTasks with modified=7d includes recently-edited tasks", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { modified: "7d" });
    expect(hits.some((t) => t.oid === task.oid)).toBe(true);
  });

  it("T6 createSubtask preserves priority on creation", async () => {
    subtask = await client.createSubtask(task.oid, {
      name: `${runTag}-sub`,
      priority: "Urgent",
    });
    expect(subtask.oid).toBeTruthy();
    expect(subtask.priority?.name).toBe("Urgent");
    expect(subtask.priority?.value).toBe(2);
  });

  it("T7 listSubtasks contains the subtask", async () => {
    const subs = await client.listSubtasks(task.oid);
    expect(subs.some((t) => t.oid === subtask.oid)).toBe(true);
  });

  it("T8 updateTask updates name + description", async () => {
    const NEW_NAME = `${TASK_NAME} renamed`;
    const updated = await client.updateTask(task.oid, {
      name: NEW_NAME,
      description: "t8 body",
    });
    expect(updated.nameText ?? updated.name).toBe(NEW_NAME);
    expect(updated.descriptionText ?? updated.description).toContain("t8 body");
  });

  it("T9 updateTask with addTags attaches a tag", async () => {
    const updated = await client.updateTask(task.oid, { addTags: [tag.oid] });
    expect(updated.tags?.some((t) => t.oid === tag.oid)).toBe(true);
  });

  it("T10 updateTask with removeTags detaches the tag", async () => {
    const updated = await client.updateTask(task.oid, {
      removeTags: [tag.oid],
    });
    expect(updated.tags?.some((t) => t.oid === tag.oid)).toBe(false);
  });

  it("T11 updateTask with tags replaces the whole tag set", async () => {
    const withTag = await client.updateTask(task.oid, { tags: [tag.oid] });
    expect(withTag.tags?.map((t) => t.oid)).toEqual([tag.oid]);

    const cleared = await client.updateTask(task.oid, { tags: [] });
    expect(cleared.tags ?? []).toEqual([]);
  });

  it("T12 updateTask sets the current user as assignee", async () => {
    const updated = await client.updateTask(task.oid, { assignees: [me.oid] });
    expect(updated.assignees?.some((a) => a.oid === me.oid)).toBe(true);
  });

  it("T13 updateTask sets start + due dates", async () => {
    const updated = await client.updateTask(task.oid, {
      start: "2026-05-15",
      due: "2026-06-01",
    });
    expect(updated.start).toBe("2026-05-15");
    expect(updated.due).toBe("2026-06-01");
  });

  // Built-in Estimate field (wire name `etc`, non-negative integer seconds).
  // Quire rejects `customFields: { Estimate }` with 400 "Not allowed to
  // access `Estimate`" — must be passed at the top level.
  it("T13a updateTask with etc sets Estimate and GET round-trips it", async () => {
    const put = await client.updateTask(task.oid, { etc: 36000 }); // 10h
    expect(put.etc).toBe(36000);

    const got = await client.getTask(task.oid);
    expect(got.etc).toBe(36000);
  });

  it("T13b createTask with etc sets Estimate at creation time", async () => {
    const created = await client.createTask(PROJECT_OID, {
      name: `${runTag}-etc-create`,
      etc: 7200, // 2h
    });
    expect(created.etc).toBe(7200);
    await client.deleteTask(created.oid);
  });

  // Quire clears dates on `null`, NOT empty string ("" → 400 "Invalid time
  // for `due`: "). updateTask's body type already encodes this with
  // `due?: string | null` — empty strings should be normalized to null by
  // callers before reaching the client.
  it("T14 updateTask with null dates clears them", async () => {
    const updated = await client.updateTask(task.oid, {
      start: null,
      due: null,
    });
    expect(updated.start).toBeFalsy();
    expect(updated.due).toBeFalsy();
  });

  // moveTask wraps PUT /task/move/{oid}?task=<target>. Omit `parentOid` (or
  // pass empty) for "root". Verified against the underlying contract — Quire
  // takes the target via query string, NOT body.
  it("T15 moveTask reparents to root and back under the parent", async () => {
    const toRoot = await client.moveTask(subtask.oid); // root
    expect(toRoot.oid).toBe(subtask.oid);
    const afterRoot = await client.getTask(subtask.oid);
    expect(afterRoot.parent).toBeFalsy();

    const backUnder = await client.moveTask(subtask.oid, task.oid);
    expect(backUnder.oid).toBe(subtask.oid);
    const afterBack = await client.getTask(subtask.oid);
    expect(afterBack.parent?.oid).toBe(task.oid);
  });

  it("T16 updateTask status=100 marks the task complete", async () => {
    const updated = await client.updateTask(task.oid, { status: 100 });
    expect(updated.status?.value).toBe(100);
  });

  // QuireClient throws on non-2xx, so the 404 assertion uses rawApi.
  it("T17 deleteTask removes the task and GET returns 404", async () => {
    await client.deleteTask(task.oid);

    const get = await rawApi("GET", `/task/${task.oid}`);
    expect(get.status).toBe(404);
    task = { oid: "" } as QuireTask; // prevent afterAll re-delete
  });

  // undoRemoveTask: counts against the task-creation quota, so the
  // single-task case stays cheap. Spec promises a no-op on a non-removed
  // entity (returns current state) — locked down here so callers can mark
  // it idempotent.
  it("T17b undoRemoveTask restores a removed task with its fields", async () => {
    const name = `${runTag}-undo-probe`;
    const description = "undo-remove body";
    const created = await client.createTask(PROJECT_OID, {
      name,
      description,
      priority: "High",
      due: "2026-05-01",
    });
    const oid = created.oid;

    await client.deleteTask(oid);
    expect((await rawApi("GET", `/task/${oid}`)).status).toBe(404);

    const restored = await client.undoRemoveTask(oid);
    expect(restored.oid).toBe(oid);

    const got = await client.getTask(oid);
    expect(got.nameText ?? got.name).toBe(name);
    expect(got.descriptionText ?? got.description).toContain("undo-remove body");
    expect(got.due).toBeTruthy();

    // Second call on a non-removed entity is a no-op returning current state.
    const restored2 = await client.undoRemoveTask(oid);
    expect(restored2.oid).toBe(oid);

    await client.deleteTask(oid);
  });

  // Cascade check — deleting a parent removes subtasks, so undo-remove on
  // the parent should also bring the subtree back. Locks down the expected
  // behavior so any future divergence surfaces as a test failure.
  it("T17c undoRemoveTask restores subtasks too", async () => {
    const parent = await client.createTask(PROJECT_OID, {
      name: `${runTag}-undo-parent`,
    });
    const child = await client.createSubtask(parent.oid, {
      name: `${runTag}-undo-child`,
    });

    await client.deleteTask(parent.oid);
    expect((await rawApi("GET", `/task/${parent.oid}`)).status).toBe(404);
    expect((await rawApi("GET", `/task/${child.oid}`)).status).toBe(404);

    await client.undoRemoveTask(parent.oid);

    // Parent comes back; subtask should too (cascade-restore).
    expect((await rawApi("GET", `/task/${parent.oid}`)).status).toBe(200);
    expect((await rawApi("GET", `/task/${child.oid}`)).status).toBe(200);

    await client.deleteTask(parent.oid);
  });
});

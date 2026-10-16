/**
 * Live API tests for /reminder (RM1-RM10), added in the Sep 21 2026 server
 * release; the list's `timing` / `status` filters (RM9-RM10) came Sep 25.
 *
 * Two things make reminders different from the other work endpoints, and
 * both are pinned here:
 *
 *   1. `ownerType` is ALWAYS required — there is no implied `project` the
 *      way sublist / doc / chat / insight / dashboard have one.
 *   2. What a reminder fires from depends on its task. A task WITH a start
 *      or due date supplies the time, so `when` / `recurrence` are rejected
 *      with 400; a task with neither, or no task at all, requires `when`.
 *
 * Delete is permanent (no trash, no undo-remove), so every reminder created
 * here is cleaned up in-test and again in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";
import type { QuireReminder, QuireTask, QuireUser } from "../../src/index.js";

describe.skipIf(!hasTokens)("Live API — /reminder", () => {
  if (!hasTokens) return;

  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  // Far enough out that the reminder never actually fires during a run.
  const WHEN = "2027-01-15T09:00:00.000Z";

  let me: QuireUser;
  let reminder: QuireReminder | undefined;
  let datedTask: QuireTask | undefined;
  let undatedTask: QuireTask | undefined;
  let standaloneReminder: QuireReminder | undefined;
  let anchoredReminder: QuireReminder | undefined;
  const strays: string[] = [];

  beforeAll(async () => {
    me = await client.getMe();
  });

  afterAll(async () => {
    for (const oid of [reminder?.oid, ...strays].filter(Boolean) as string[]) {
      await client.deleteReminder(oid).catch(() => {});
    }
    for (const t of [datedTask, undatedTask]) {
      if (t?.oid) await client.deleteTask(t.oid).catch(() => {});
    }
  });

  it("RM1 createReminder on a project returns a standalone reminder", async () => {
    reminder = await client.createReminder("project", PROJECT_OID, {
      when: WHEN,
      name: `${runTag}-reminder`,
    });
    expect(reminder.oid).toBeTruthy();
    expect(reminder.when).toBe(WHEN);
    // No task → it stands on its own.
    expect(reminder.task ?? null).toBeNull();
    // Created without `leads`, so the default single notification at the
    // fire time is what comes back.
    expect(reminder.leads).toEqual([{ minutes: 0 }]);
  });

  it("RM2 getReminder round-trips the record", async () => {
    const got = await client.getReminder(reminder!.oid);
    expect(got.oid).toBe(reminder!.oid);
    expect(got.nameText ?? got.name).toContain(runTag);
    expect(got.createdBy?.oid).toBe(me.oid);
  });

  it("RM3 listReminders on the project includes it", async () => {
    const list = await client.listReminders("project", PROJECT_OID);
    expect(list.some((r) => r.oid === reminder!.oid)).toBe(true);
  });

  it("RM4 updateReminder changes when, name and leads", async () => {
    const updated = await client.updateReminder(reminder!.oid, {
      when: "2027-03-20T18:30:00.000Z",
      name: `${runTag}-reminder-edited`,
      leads: [{ minutes: 30 }, { days: 1, at: "09:00" }],
    });
    expect(updated.when).toBe("2027-03-20T18:30:00.000Z");
    expect(updated.nameText ?? updated.name).toContain("edited");
    // Replaces the list wholesale, and each form round-trips as sent —
    // `minutes` is not normalised into `days` or vice versa.
    expect(updated.leads).toEqual([{ minutes: 30 }, { days: 1, at: "09:00" }]);
  });

  // A task with no start/due date has no schedule to fire from, so `when`
  // is required — same as a standalone reminder.
  it("RM5 createReminder on an undated task requires when", async () => {
    undatedTask = await client.createTask(PROJECT_OID, {
      name: `${runTag}-reminder-undated`,
    });
    const created = await client.createReminder("task", undatedTask.oid, {
      when: WHEN,
    });
    strays.push(created.oid);
    standaloneReminder = created;
    expect(created.task?.oid).toBe(undatedTask.oid);
    expect(created.when).toBe(WHEN);
  });

  // The inverse: a dated task supplies the fire time, so a `when` of its own
  // would be ignored and is rejected rather than silently dropped.
  it("RM6 createReminder on a dated task rejects when with 400", async () => {
    datedTask = await client.createTask(PROJECT_OID, {
      name: `${runTag}-reminder-dated`,
      due: "2027-02-01",
    });

    const rejected = await rawApi("POST", `/reminder/task/${datedTask.oid}`, {
      when: WHEN,
    });
    expect(rejected.status).toBe(400);

    // `leads` alone is the supported form there, and `when` comes back null
    // because the task's due date is what it fires from.
    const created = await client.createReminder("task", datedTask.oid, {
      leads: [{ days: 1, at: "09:00" }],
    });
    strays.push(created.oid);
    anchoredReminder = created;
    expect(created.when ?? null).toBeNull();
    expect(created.leads).toEqual([{ days: 1, at: "09:00" }]);
  });

  // `ownerType` has no implied default on these endpoints — unlike every
  // other work endpoint, omitting it is not "project".
  it("RM7 listReminders narrows to one task with ownerType task", async () => {
    const onTask = await client.listReminders("task", datedTask!.oid);
    expect(onTask.length).toBeGreaterThan(0);
    expect(onTask.every((r) => r.task?.oid === datedTask!.oid)).toBe(true);
    // The project's list is the wider one: it includes task reminders too.
    const onProject = await client.listReminders("project", PROJECT_OID);
    expect(onProject.length).toBeGreaterThanOrEqual(onTask.length);
  });

  it("RM8 deleteReminder is permanent — GET then 404s", async () => {
    const oid = reminder!.oid;
    await client.deleteReminder(oid);
    const got = await rawApi("GET", `/reminder/${oid}`);
    expect(got.status).toBe(404);
    reminder = undefined; // prevent afterAll re-delete
  });

  // RM5's reminder fires at its own `when` (its task is undated); RM6's
  // fires from its task's due date. `timing` splits the project's list
  // along exactly that line.
  it("RM9 listReminders filters by timing", async () => {
    const standalone = await client.listReminders("project", PROJECT_OID, {
      timing: "standalone",
    });
    const ids = (list: QuireReminder[]) => list.map((r) => r.oid);
    expect(ids(standalone)).toContain(standaloneReminder!.oid);
    expect(ids(standalone)).not.toContain(anchoredReminder!.oid);
    expect(standalone.every((r) => r.when)).toBe(true);

    const anchored = await client.listReminders("project", PROJECT_OID, {
      timing: "anchored",
    });
    expect(ids(anchored)).toContain(anchoredReminder!.oid);
    expect(ids(anchored)).not.toContain(standaloneReminder!.oid);
    expect(anchored.every((r) => (r.when ?? null) === null)).toBe(true);
  });

  // A reminder on a completed task has no notification still to come, so
  // `active` drops it while `all` (the default) keeps it.
  it("RM10 listReminders with status active leaves out a completed task's", async () => {
    const ids = async (status?: "active" | "all") =>
      (await client.listReminders("project", PROJECT_OID, { status })).map(
        (r) => r.oid,
      );
    expect(await ids("active")).toContain(standaloneReminder!.oid);

    await client.updateTask(undatedTask!.oid, { status: 100 });
    const active = await ids("active");
    expect(active).not.toContain(standaloneReminder!.oid);
    expect(active).toContain(anchoredReminder!.oid);
    expect(await ids("all")).toContain(standaloneReminder!.oid);
    expect(await ids()).toContain(standaloneReminder!.oid);
  });
});

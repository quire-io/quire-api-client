/**
 * Live API tests for task-type conversion (TY1-TY9).
 *
 * Three task types via two boolean flags on the body:
 *   normal    — section + milestone both absent/false
 *   section   — section: true  (organizational container, stateless)
 *   milestone — milestone: true (timeline marker, stateful)
 *
 * Server treats stateful vs stateless distinctly:
 *   normal (0), milestone (1)  → stateful
 *   section (5)                → stateless
 *
 * Conversion rules:
 *   stateful → stateless (task/milestone → section): wipes assignees,
 *     assignors, tags, timelogs, doings, start, due, priority (→ default),
 *     recurring, etc.
 *   any → milestone: clears `start` only. due, assignees, tags, priority,
 *     etc. are PRESERVED.
 *   stateless → stateful (section → task/milestone): NO auto-restore —
 *     fields cleared on the way in stay cleared.
 *
 * Bundling field writes with a type change in a single PUT has a subtle
 * ordering bug: the server strips section/milestone from the body first,
 * applies the other fields, THEN flips the type. For section (stateless)
 * this means sibling field writes get wiped immediately after by the
 * type-change clear. TY8 and TY9 lock this footgun down.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTag, QuireTask, QuireUser } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — task type (section/milestone)", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const createdOids: string[] = [];
  let me: QuireUser;
  let tag: QuireTag;

  beforeAll(async () => {
    me = await client.getMe();
    tag = await client.createTag(PROJECT_OID, { name: `${runTag}-type-tag` });
  });

  afterAll(async () => {
    for (const oid of createdOids) {
      await client.deleteTask(oid).catch(() => {});
    }
    if (tag?.oid) await client.deleteTag(tag.oid).catch(() => {});
  });

  async function createTask(
    body: Parameters<typeof client.createTask>[1],
  ): Promise<QuireTask> {
    const t = await client.createTask(PROJECT_OID, body);
    createdOids.push(t.oid);
    return t;
  }

  it("TY1 createTask({milestone:true}) creates a milestone directly", async () => {
    const data = await createTask({
      name: `${runTag}-milestone-create`,
      milestone: true,
    });
    expect(data.milestone).toBe(true);
    expect(data.section).toBeFalsy();
  });

  it("TY2 createTask({section:true}) creates a section directly", async () => {
    const data = await createTask({
      name: `${runTag}-section-create`,
      section: true,
    });
    expect(data.section).toBe(true);
    expect(data.milestone).toBeFalsy();
  });

  it("TY3 createTask without type flags creates a normal task", async () => {
    const data = await createTask({ name: `${runTag}-normal-create` });
    expect(data.milestone).toBeFalsy();
    expect(data.section).toBeFalsy();
  });

  it("TY4 updateTask({milestone:true}) converts task → milestone; clears start only", async () => {
    const task = await createTask({
      name: `${runTag}-to-milestone`,
      priority: "High",
      start: "2026-04-20",
      due: "2026-05-01",
      assignees: [me.oid],
      tags: [tag.oid],
      etc: 3600,
    });
    expect(task.start).toBe("2026-04-20");

    const updated = await client.updateTask(task.oid, { milestone: true });
    expect(updated.milestone).toBe(true);
    expect(updated.start).toBeFalsy();
    // Everything else preserved.
    expect(updated.due).toBe("2026-05-01");
    expect(updated.assignees?.some((a) => a.oid === me.oid)).toBe(true);
    expect(updated.tags?.some((t) => t.oid === tag.oid)).toBe(true);
    expect(updated.priority?.name).toBe("High");
    expect(updated.etc).toBe(3600);
  });

  it("TY5 updateTask({section:true}) converts task → section and clears assignees/tags/start/due/etc", async () => {
    const task = await createTask({
      name: `${runTag}-to-section`,
      priority: "High",
      start: "2026-04-20",
      due: "2026-05-15",
      assignees: [me.oid],
      tags: [tag.oid],
      etc: 3600,
    });
    expect(task.assignees?.length).toBeGreaterThan(0);

    const updated = await client.updateTask(task.oid, { section: true });
    expect(updated.section).toBe(true);
    expect(updated.assignees ?? []).toEqual([]);
    expect(updated.tags ?? []).toEqual([]);
    expect(updated.start).toBeFalsy();
    expect(updated.due).toBeFalsy();
    expect(updated.etc).toBeFalsy();
  });

  it("TY6 updateTask({milestone:false}) converts milestone → task; preserves all fields", async () => {
    const task = await createTask({
      name: `${runTag}-milestone-to-normal`,
      milestone: true,
      due: "2026-08-01",
      assignees: [me.oid],
    });
    expect(task.milestone).toBe(true);
    expect(task.due).toBe("2026-08-01");

    const updated = await client.updateTask(task.oid, { milestone: false });
    expect(updated.milestone).toBeFalsy();
    expect(updated.section).toBeFalsy();
    expect(updated.due).toBe("2026-08-01");
    expect(updated.assignees?.some((a) => a.oid === me.oid)).toBe(true);
  });

  it("TY7 updateTask({section:false}) converts section → task WITHOUT restoring cleared fields", async () => {
    const task = await createTask({
      name: `${runTag}-section-to-normal`,
      due: "2026-05-01",
      assignees: [me.oid],
    });
    const toSection = await client.updateTask(task.oid, { section: true });
    expect(toSection.section).toBe(true);

    const updated = await client.updateTask(task.oid, { section: false });
    expect(updated.section).toBeFalsy();
    expect(updated.milestone).toBeFalsy();
    expect(updated.due).toBeFalsy();
    expect(updated.assignees ?? []).toEqual([]);
  });

  it("TY8 updateTask({section:true, …sibling fields}) — type change wipes siblings", async () => {
    const task = await createTask({ name: `${runTag}-section-merged-put` });

    const updated = await client.updateTask(task.oid, {
      section: true,
      assignees: [me.oid],
      due: "2026-06-01",
    });
    expect(updated.section).toBe(true);
    expect(updated.assignees ?? []).toEqual([]);
    expect(updated.due).toBeFalsy();
  });

  it("TY9 updateTask({section:false, due}) does NOT restore the date — must split into two PUTs", async () => {
    const task = await createTask({
      name: `${runTag}-section-restore`,
      section: true,
    });

    const merged = await client.updateTask(task.oid, {
      section: false,
      due: "2026-07-01",
    });
    expect(merged.section).toBeFalsy();
    // Due was applied while still a section → dropped silently.
    expect(merged.due).toBeFalsy();

    const followup = await client.updateTask(task.oid, { due: "2026-07-01" });
    expect(followup.due).toBe("2026-07-01");
  });
});

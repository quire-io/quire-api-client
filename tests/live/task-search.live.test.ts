/**
 * Live API tests for /task/search filter grammar (TSF1-TSF8).
 *
 * Apr 24 2026 filters (TSF1-TSF4):
 *   - User refs: assignee / assignor / follower — value is user OID, id, or
 *     email. Boolean grammar: `,` (AND), `|` (OR), `!` (NOT).
 *   - Tag: tag — OID or name; same boolean grammar; `"..."` for names
 *     with special chars.
 *   - Date columns: created / edited / archived / unarchived / toggled /
 *     start / due — keyword ops (today, yesterday, last7d, …), value ops
 *     (ge: / gt: / le: / lt: / eq: / ne: / between: / notBetween:), null
 *     ops (isNull / isNotNull). start / due also accept bare YYYY-MM-DD.
 *
 * Apr 27 2026 filters (TSF5-TSF8):
 *   - priority: int (-1..2) or label (low/medium/high/urgent). No "none".
 *   - type: normal | task | section | milestone (alias task = normal).
 *   - createdBy: user OID, id, or email.
 *   - recurring: true / false.
 *
 * Org / folder search dispatches through the same handler, so verifying
 * the project-scoped path is sufficient coverage.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTag, QuireTask, QuireUser } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/search (Apr 24 2026 filters)", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let taskOid = "";
  let tagOid = "";
  const tagName = `${runTag}-tsf-tag`;
  let me: QuireUser;

  beforeAll(async () => {
    me = await client.getMe();
    const tag = await client.createTag(PROJECT_OID, { name: tagName });
    tagOid = tag.oid;
    // Fixture: assigned to me, tagged, due in the far future — satisfies
    // every filter below. Sub-second creation guarantees created=today
    // matches in the test's timezone.
    const created = await client.createTask(PROJECT_OID, {
      name: `${runTag}-search-task`,
      assignees: [me.oid],
      tags: [tagOid],
      due: "2030-12-31",
    });
    taskOid = created.oid;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
    if (tagOid) await client.deleteTag(tagOid).catch(() => {});
  });

  it("TSF1 searchTasks({assignee:<id>}) filters to tasks assigned to that user", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { assignee: me.id });
    expect(hits.some((t) => t.oid === taskOid)).toBe(true);
  });

  it("TSF2 searchTasks({tag:<name>}) filters to tasks with that tag", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { tag: tagName });
    expect(hits.some((t) => t.oid === taskOid)).toBe(true);
  });

  it("TSF3 searchTasks({created:'today'}) matches a task created moments ago", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { created: "today" });
    expect(hits.some((t) => t.oid === taskOid)).toBe(true);
  });

  it("TSF4 searchTasks({due:'ge:<past-date>'}) matches a future-due task", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { due: "ge:2025-01-01" });
    expect(hits.some((t) => t.oid === taskOid)).toBe(true);
  });
});

describe.skipIf(!hasTokens)("Live API — /task/search (Apr 27 2026 filters)", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let me: QuireUser;
  const createdOids: string[] = [];
  let highTaskOid = "";
  let sectionOid = "";
  let milestoneOid = "";
  let recurringOid = "";

  beforeAll(async () => {
    me = await client.getMe();
    const high = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tsf-high`,
      priority: "High",
    });
    highTaskOid = high.oid;
    createdOids.push(high.oid);

    const section = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tsf-section`,
      section: true,
    });
    sectionOid = section.oid;
    createdOids.push(section.oid);

    const milestone = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tsf-milestone`,
      milestone: true,
      due: "2026-12-31",
    });
    milestoneOid = milestone.oid;
    createdOids.push(milestone.oid);

    const recurring = await client.createTask(PROJECT_OID, {
      name: `${runTag}-tsf-recurring`,
      recurrence: { freq: "weekly", interval: 1, byweekday: [0] },
    });
    recurringOid = recurring.oid;
    createdOids.push(recurring.oid);
  });

  afterAll(async () => {
    for (const oid of [...createdOids].reverse()) {
      await client.deleteTask(oid).catch(() => {});
    }
  });

  it("TSF5 searchTasks({priority:'high'}) matches a high-priority task", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { priority: "high" });
    expect(hits.some((t) => t.oid === highTaskOid)).toBe(true);
    expect(hits.some((t) => t.oid === sectionOid)).toBe(false);
  });

  it("TSF6 searchTasks({type:'section|milestone'}) returns only sections + milestones", async () => {
    const hits = await client.searchTasks(PROJECT_OID, {
      type: "section|milestone",
    });
    expect(hits.some((t) => t.oid === sectionOid)).toBe(true);
    expect(hits.some((t) => t.oid === milestoneOid)).toBe(true);
    expect(hits.some((t) => t.oid === highTaskOid)).toBe(false);
  });

  it("TSF7 searchTasks({createdBy:<me>}) matches tasks created by the caller", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { createdBy: me.oid });
    expect(hits.some((t) => t.oid === highTaskOid)).toBe(true);
  });

  it("TSF8 searchTasks({recurring:true}) returns only tasks with a recurrence", async () => {
    const hits = await client.searchTasks(PROJECT_OID, { recurring: true });
    expect(hits.some((t) => t.oid === recurringOid)).toBe(true);
    expect(hits.some((t) => t.oid === highTaskOid)).toBe(false);
  });
});

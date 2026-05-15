/**
 * Live API tests for peekaboo (TP1-TP3) — temporarily hide a task with an
 * optional auto-reshow time.
 *
 * Wire contract:
 *   PUT /api/task/{oid} with `peekaboo` body field:
 *     - true            → archive indefinitely (no auto-reshow)
 *     - positive int    → archive + reshowAt = the int (ms-since-epoch).
 *                         Small values (e.g. 7) resolve to 1970 and auto-
 *                         unarchive fires immediately.
 *     - false           → unarchive (clears archivedAt / reshowAt).
 *
 * Response shape: the task serializer surfaces `archivedAt` / `reshowAt`
 * when set, and derives `peekaboo: true` whenever archivedAt is non-null.
 * `reshowAt` is read-only — callers drive it via the integer form.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — peekaboo", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const createdOids: string[] = [];

  afterAll(async () => {
    for (const oid of createdOids) {
      await client.deleteTask(oid).catch(() => {});
    }
  });

  async function createTask(): Promise<QuireTask> {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-peekaboo`,
    });
    createdOids.push(t.oid);
    return t;
  }

  it("TP1 updateTask({peekaboo:true}) archives the task with no auto-reshow", async () => {
    const task = await createTask();
    expect(task.archivedAt).toBeFalsy();

    const updated = await client.updateTask(task.oid, { peekaboo: true });
    expect(updated.peekaboo).toBe(true);
    expect(updated.archivedAt).toBeTruthy();
    expect(updated.reshowAt).toBeFalsy();
  });

  it("TP2 updateTask({peekaboo:<future-ms>}) sets reshowAt to that timestamp", async () => {
    const task = await createTask();
    const targetMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

    const updated = await client.updateTask(task.oid, { peekaboo: targetMs });
    expect(updated.peekaboo).toBe(true);
    expect(updated.archivedAt).toBeTruthy();
    expect(updated.reshowAt).toBeTruthy();

    const reshowMs = Date.parse(updated.reshowAt as string);
    expect(Number.isFinite(reshowMs)).toBe(true);
    // Allow a few seconds of skew for server encoding + clock drift.
    expect(Math.abs(reshowMs - targetMs)).toBeLessThan(5000);
  });

  it("TP3 updateTask({peekaboo:false}) unarchives the task", async () => {
    const task = await createTask();
    const archived = await client.updateTask(task.oid, { peekaboo: true });
    expect(archived.archivedAt).toBeTruthy();

    const unarchived = await client.updateTask(task.oid, { peekaboo: false });
    expect(unarchived.peekaboo).toBeFalsy();
    expect(unarchived.archivedAt).toBeFalsy();
    expect(unarchived.reshowAt).toBeFalsy();
  });
});

/**
 * Live API tests for peekaboo (TP1-TP8) — temporarily hide a task with an
 * optional auto-reshow time.
 *
 * Wire contract (Nov 3 2026), the same on POST and PUT /api/task:
 *   `peekaboo` body field:
 *     - true            → archive indefinitely (no auto-reshow)
 *     - int ≤ 10000     → archive for that many days. Until Nov 3 2026 an
 *                         update read it as ms since the epoch, so 7 showed
 *                         the task again at once.
 *     - larger int      → archive + reshowAt = the int (ms since the epoch)
 *     - date/time str   → archive + reshowAt = `yyyy-MM-dd'T'HH:mmZ`, or a
 *                         date only for 6 AM that day in the user's zone
 *     - a past time     → 400 (e.g. one in seconds)
 *     - false           → unarchive (clears archivedAt / reshowAt).
 *
 * Response shape: the task serializer surfaces `archivedAt` / `reshowAt`
 * when set, and derives `peekaboo: true` whenever archivedAt is non-null.
 * `reshowAt` is read-only — callers drive it via `peekaboo`.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// `yyyy-MM-dd'T'HH:mmZ`, the minute-precision UTC form peekaboo takes.
function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

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

  // Nov 3 2026: an integer up to 10000 is days, as the API doc says.
  it("TP4 updateTask({peekaboo:7}) hides the task for 7 days", async () => {
    const task = await createTask();
    const before = Date.now();

    const updated = await client.updateTask(task.oid, { peekaboo: 7 });
    expect(updated.peekaboo).toBe(true);
    const reshowMs = Date.parse(updated.reshowAt as string);
    // How the server rounds a day isn't documented: allow one either way.
    expect(Math.abs(reshowMs - (before + 7 * DAY_MS))).toBeLessThan(DAY_MS);
  });

  it("TP5 updateTask({peekaboo:<date/time string>}) hides it until then", async () => {
    const task = await createTask();
    const target = utcMinute(Date.now() + 3 * DAY_MS);

    const updated = await client.updateTask(task.oid, { peekaboo: target });
    expect(updated.peekaboo).toBe(true);
    expect(Date.parse(updated.reshowAt as string)).toBe(Date.parse(target));
  });

  // A date only is 6 AM that day in the user's time zone (UTC-12..UTC+14).
  it("TP6 updateTask({peekaboo:<date>}) hides it until that morning", async () => {
    const task = await createTask();
    const date = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10);

    const updated = await client.updateTask(task.oid, { peekaboo: date });
    expect(updated.peekaboo).toBe(true);
    const reshowMs = Date.parse(updated.reshowAt as string);
    const sixUtc = Date.parse(`${date}T06:00Z`);
    expect(reshowMs).toBeGreaterThanOrEqual(sixUtc - 14 * HOUR_MS);
    expect(reshowMs).toBeLessThanOrEqual(sixUtc + 12 * HOUR_MS);
  });

  it("TP7 a past time is 400: seconds since the epoch, or a past date", async () => {
    const task = await createTask();

    await expect(
      client.updateTask(task.oid, { peekaboo: Math.floor(Date.now() / 1000) }),
    ).rejects.toThrow(/Quire API error 400/);
    await expect(
      client.updateTask(task.oid, { peekaboo: "2020-01-01T00:00Z" }),
    ).rejects.toThrow(/Quire API error 400/);
    await expect(
      client.createTask(PROJECT_OID, {
        name: `${runTag}-peekaboo-past`,
        peekaboo: "2020-01-01",
      }),
    ).rejects.toThrow(/Quire API error 400/);
  });

  // Nov 3 2026: create takes a time too; it used to be 400.
  it("TP8 createTask takes peekaboo: days, ms and a date/time string", async () => {
    const before = Date.now();
    const byDays = await client.createTask(PROJECT_OID, {
      name: `${runTag}-peekaboo-days`,
      peekaboo: 2,
    });
    createdOids.push(byDays.oid);
    expect(byDays.peekaboo).toBe(true);
    expect(
      Math.abs(Date.parse(byDays.reshowAt as string) - (before + 2 * DAY_MS)),
    ).toBeLessThan(DAY_MS);

    const targetMs = before + 4 * DAY_MS;
    const byMs = await client.createTask(PROJECT_OID, {
      name: `${runTag}-peekaboo-ms`,
      peekaboo: targetMs,
    });
    createdOids.push(byMs.oid);
    expect(Math.abs(Date.parse(byMs.reshowAt as string) - targetMs)).toBeLessThan(5000);

    const target = utcMinute(before + 6 * DAY_MS);
    const byString = await client.createTask(PROJECT_OID, {
      name: `${runTag}-peekaboo-string`,
      peekaboo: target,
    });
    createdOids.push(byString.oid);
    expect(Date.parse(byString.reshowAt as string)).toBe(Date.parse(target));
  });
});

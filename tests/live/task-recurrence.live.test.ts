/**
 * Live API tests for task recurrence (TR1-TR9).
 *
 *   POST /task/{projectOid}   body.recurrence = { freq, interval, ... }
 *   PUT  /task/{taskOid}      body.recurrence = { ... } | null
 *
 * Recurrence semantics:
 *   - byweekday uses 0..6 = Mon..Sun (weekly: int[]; monthly/yearly
 *     nth-week: int).
 *   - Monthly/yearly "nth day of month" uses `bydayno`; "nth week" uses
 *     `byweekno` (1..5 or "last") + `byweekday`.
 *   - Yearly adds `bymonth` (1..12).
 *   - `until` (ISO date) is the only end condition — no count-based end.
 *   - `sincelatest` is daily-only.
 *   - Server assigns `seriesId` on creation.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireRecurrence } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — task recurrence", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const createdOids: string[] = [];

  afterAll(async () => {
    for (const oid of [...createdOids].reverse()) {
      await client.deleteTask(oid).catch(() => {});
    }
  });

  async function createWithRecurrence(
    label: string,
    recurrence: QuireRecurrence,
  ) {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-rec-${label}`,
      due: "2026-05-01", // recurrence anchors against a due date
      recurrence,
    });
    expect(t.oid).toBeTruthy();
    createdOids.push(t.oid);
    return t;
  }

  it("TR1 weekly Mon+Wed every 2 weeks round-trips", async () => {
    const rec: QuireRecurrence = {
      freq: "weekly",
      interval: 2,
      byweekday: [0, 2],
      dupsubtasks: true,
    };
    const created = await createWithRecurrence("tr1", rec);
    expect(created.recurrence?.freq).toBe("weekly");
    expect(created.recurrence?.interval).toBe(2);
    expect(created.recurrence?.byweekday).toEqual([0, 2]);
    expect(created.recurrence?.dupsubtasks).toBe(true);

    const got = await client.getTask(created.oid);
    expect(got.recurrence?.freq).toBe("weekly");
    expect(got.recurrence?.byweekday).toEqual([0, 2]);
    expect(got.recurrence?.seriesId).toBeTruthy();
  });

  it("TR2 daily every 3 days with sincelatest round-trips", async () => {
    const created = await createWithRecurrence("tr2", {
      freq: "daily",
      interval: 3,
      sincelatest: true,
      dupsubtasks: true,
    });
    expect(created.recurrence?.freq).toBe("daily");
    expect(created.recurrence?.interval).toBe(3);
    expect(created.recurrence?.sincelatest).toBe(true);
  });

  it("TR3 monthly 12th of every month round-trips", async () => {
    const created = await createWithRecurrence("tr3", {
      freq: "monthly",
      interval: 1,
      bydayno: 12,
    });
    expect(created.recurrence?.freq).toBe("monthly");
    expect(created.recurrence?.bydayno).toBe(12);
  });

  it("TR4 monthly last Thursday round-trips (byweekno:'last' + byweekday:3)", async () => {
    const created = await createWithRecurrence("tr4", {
      freq: "monthly",
      interval: 1,
      byweekno: "last",
      byweekday: 3,
    });
    expect(created.recurrence?.freq).toBe("monthly");
    expect(created.recurrence?.byweekno).toBe("last");
    expect(created.recurrence?.byweekday).toBe(3);
  });

  it("TR5 yearly May 12 round-trips", async () => {
    const created = await createWithRecurrence("tr5", {
      freq: "yearly",
      interval: 1,
      bymonth: 5,
      bydayno: 12,
    });
    expect(created.recurrence?.freq).toBe("yearly");
    expect(created.recurrence?.bymonth).toBe(5);
    expect(created.recurrence?.bydayno).toBe(12);
  });

  it("TR6 weekly with `until` end date round-trips", async () => {
    const created = await createWithRecurrence("tr6", {
      freq: "weekly",
      interval: 1,
      byweekday: [0],
      until: "2026-12-31",
    });
    expect(created.recurrence?.until).toBe("2026-12-31");
  });

  it("TR7 dupsubtasks:false round-trips", async () => {
    const created = await createWithRecurrence("tr7", {
      freq: "weekly",
      interval: 1,
      byweekday: [0],
      dupsubtasks: false,
    });
    expect(created.recurrence?.dupsubtasks).toBe(false);
  });

  it("TR8 updateTask({recurrence:null}) clears an existing recurrence", async () => {
    const created = await createWithRecurrence("tr8", {
      freq: "weekly",
      interval: 1,
      byweekday: [0],
    });
    expect(created.recurrence?.freq).toBe("weekly");

    await client.updateTask(created.oid, { recurrence: null });

    const got = await client.getTask(created.oid);
    // Accept either field-absent or explicit-null — both mean no active
    // recurrence on the task.
    expect(got.recurrence ?? null).toBeNull();
  });

  it("TR9 updateTask({recurrence:{…}}) updates an existing recurrence's interval", async () => {
    const created = await createWithRecurrence("tr9", {
      freq: "weekly",
      interval: 1,
      byweekday: [0],
    });
    expect(created.recurrence?.interval).toBe(1);

    await client.updateTask(created.oid, {
      recurrence: { freq: "weekly", interval: 2, byweekday: [0] },
    });

    const got = await client.getTask(created.oid);
    expect(got.recurrence?.interval).toBe(2);
    expect(got.recurrence?.byweekday).toEqual([0]);
  });
});

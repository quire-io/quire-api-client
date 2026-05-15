/**
 * Live API tests for custom fields on tasks (T18, T19, T20, TC1).
 *
 * Requires these fields to exist on the QUIRE_TEST_PROJECT_ID project:
 *   - Cost       (Currency)
 *   - Work time  (Duration)
 *   - Note       (Paragraph)
 *
 * Quire keys custom fields by their exact display name (case-sensitive,
 * spaces preserved). The wire format puts them at the top level of the
 * task JSON; the QuireClient `customFields: { ... }` body field flattens
 * to that wire shape automatically.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

interface TaskWithCustomFields extends QuireTask {
  Cost?: number;
  "Work time"?: number;
  Note?: string;
}

describe.skipIf(!hasTokens)("Live API — task custom fields", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let taskOid = "";

  beforeAll(async () => {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-custom-fields`,
    });
    taskOid = t.oid;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("T18 updateTask({customFields:{Cost, Work time, Note}}) sets all three", async () => {
    const updated = (await client.updateTask(taskOid, {
      customFields: {
        Cost: 123.45,
        "Work time": 3600,
        Note: "line 1\nline 2",
      },
    })) as TaskWithCustomFields;
    expect(updated.Cost).toBe(123.45);
    expect(updated["Work time"]).toBe(3600);
    expect(updated.Note).toBe("line 1\nline 2");
  });

  it("T19 getTask returns the same custom-field values", async () => {
    const got = (await client.getTask(taskOid)) as TaskWithCustomFields;
    expect(got.Cost).toBe(123.45);
    expect(got["Work time"]).toBe(3600);
    expect(got.Note).toBe("line 1\nline 2");
  });

  // Verifies custom fields are honored at CREATION time (not just on PUT).
  it("TC1 createTask({customFields}) sets values at creation time and they round-trip", async () => {
    const created = (await client.createTask(PROJECT_OID, {
      name: `${runTag}-custom-create`,
      customFields: { Cost: 99, Note: "hello at create" },
    })) as TaskWithCustomFields;
    expect(created.oid).toBeTruthy();
    expect(created.Cost).toBe(99);
    expect(created.Note).toBe("hello at create");

    const got = (await client.getTask(created.oid)) as TaskWithCustomFields;
    expect(got.Cost).toBe(99);
    expect(got.Note).toBe("hello at create");

    await client.deleteTask(created.oid);
  });

  // Contract note (discovered 2026-04-21) — per-type clear behavior:
  //   Paragraph: null OR "" → cleared (undefined on GET)
  //   Currency:  null → cleared; "" → 400
  //   Duration:  null → 400 "Invalid value for `Work time`: null";
  //              "" → 400; 0 → stored as 0 (no way to truly unset)
  //
  // Use rawApi for the 400 assertion on Duration — QuireClient throws on
  // 4xx, which hides the status code.
  it("T20 null clears Paragraph + Currency; Duration 400s on null and rounds-trips 0", async () => {
    const cleared = (await client.updateTask(taskOid, {
      customFields: { Cost: null, Note: null },
    })) as TaskWithCustomFields;
    expect(cleared.Cost).toBeUndefined();
    expect(cleared.Note).toBeUndefined();

    const badDuration = await rawApi<{ code: number; message: string }>(
      "PUT",
      `/task/${taskOid}`,
      { "Work time": null },
    );
    expect(badDuration.status).toBe(400);
    expect(badDuration.data.message).toMatch(/Invalid value for/);

    const reset = (await client.updateTask(taskOid, {
      customFields: { "Work time": 0 },
    })) as TaskWithCustomFields;
    expect(reset["Work time"]).toBe(0);
  });
});

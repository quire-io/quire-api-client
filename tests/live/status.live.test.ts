/**
 * Live API tests for /status (S1-S8).
 *
 * Status semantics:
 *   - value 0   = active (default; reserved)
 *   - value 100 = completed (default; reserved)
 *   - value ≥ 100 = custom COMPLETED states (e.g. "Won't Fix" = 101).
 *     S6 locks this in — Quire deliberately does NOT cap status values at
 *     100, so a client-side max-100 validation would be wrong.
 *
 * QuireClient's status methods auto-detect OID vs id form via
 * `looksLikeOid`, so the same method handles both URL variants. S7/S8
 * pass the project's slug id instead of its OID and the request routes
 * through the `/status/id/…` path automatically.
 */

import { describe, it, expect, afterAll } from "vitest";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /status", () => {
  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  // Mid-range values unlikely to collide with existing custom statuses.
  const CUSTOM_STATUS_VALUE = 47;
  const COMPLETED_STATUS_VALUE = 105;
  let createdCustom = false;
  let createdCompleted = false;

  afterAll(async () => {
    if (createdCustom) {
      await client
        .deleteStatus(PROJECT_OID, CUSTOM_STATUS_VALUE)
        .catch(() => {});
    }
    if (createdCompleted) {
      await client
        .deleteStatus(PROJECT_OID, COMPLETED_STATUS_VALUE)
        .catch(() => {});
    }
  });

  it("S1 listStatuses returns the default active + completed entries", async () => {
    const list = await client.listStatuses(PROJECT_OID);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((s) => s.value === 0)).toBe(true);
    expect(list.some((s) => s.value === 100)).toBe(true);
  });

  it("S2 getStatus returns the active status (value 0)", async () => {
    const s = await client.getStatus(PROJECT_OID, 0);
    expect(s.value).toBe(0);
    expect(s.name).toBeTruthy();
  });

  it("S3 createStatus creates a custom status at a mid-range value", async () => {
    const s = await client.createStatus(PROJECT_OID, {
      name: `${runTag}-status`,
      color: "03",
      value: CUSTOM_STATUS_VALUE,
    });
    expect(s.value).toBe(CUSTOM_STATUS_VALUE);
    expect(s.name).toBe(`${runTag}-status`);
    expect(s.color).toBe("03");
    createdCustom = true;
  });

  it("S4 updateStatus renames + recolors a custom status", async () => {
    const s = await client.updateStatus(PROJECT_OID, CUSTOM_STATUS_VALUE, {
      name: `${runTag}-status-renamed`,
      color: "34",
    });
    expect(s.name).toBe(`${runTag}-status-renamed`);
    expect(s.color).toBe("34");
  });

  it("S5 deleteStatus removes the custom status", async () => {
    await client.deleteStatus(PROJECT_OID, CUSTOM_STATUS_VALUE);
    createdCustom = false;
    const list = await client.listStatuses(PROJECT_OID);
    expect(list.some((s) => s.value === CUSTOM_STATUS_VALUE)).toBe(false);
  });

  // Locked in: Quire deliberately does NOT cap status values at 100. Custom
  // completed states live above 100 (e.g. "Won't Fix" = 101). A client-side
  // max-100 validation would be wrong.
  it("S6 createStatus accepts value > 100 (custom completed state)", async () => {
    const s = await client.createStatus(PROJECT_OID, {
      name: `${runTag}-wontfix`,
      color: "34",
      value: COMPLETED_STATUS_VALUE,
    });
    expect(s.value).toBe(COMPLETED_STATUS_VALUE);
    expect(s.name).toBe(`${runTag}-wontfix`);
    createdCompleted = true;

    const list = await client.listStatuses(PROJECT_OID);
    expect(list.some((s) => s.value === COMPLETED_STATUS_VALUE)).toBe(true);

    await client.deleteStatus(PROJECT_OID, COMPLETED_STATUS_VALUE);
    createdCompleted = false;
  });

  // Same methods accept a project slug instead of an OID — auto-routes to
  // the /status/id/{projectId}/… URL form.
  it("S7 listStatuses + getStatus work when called with the project's slug id", async () => {
    const list = await client.listStatuses(PROJECT_ID);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((s) => s.value === 0)).toBe(true);
    expect(list.some((s) => s.value === 100)).toBe(true);

    const s = await client.getStatus(PROJECT_ID, 0);
    expect(s.value).toBe(0);
    expect(s.name).toBeTruthy();
  });

  it("S8 createStatus + updateStatus + deleteStatus round-trip via the slug-id form", async () => {
    const idValue = 48;
    let created = false;
    try {
      const create = await client.createStatus(PROJECT_ID, {
        name: `${runTag}-id-status`,
        color: "03",
        value: idValue,
      });
      expect(create.value).toBe(idValue);
      created = true;

      const update = await client.updateStatus(PROJECT_ID, idValue, {
        name: `${runTag}-id-status-renamed`,
        color: "34",
      });
      expect(update.name).toBe(`${runTag}-id-status-renamed`);
      expect(update.color).toBe("34");

      await client.deleteStatus(PROJECT_ID, idValue);
      created = false;
    } finally {
      if (created) {
        await client.deleteStatus(PROJECT_OID, idValue).catch(() => {});
      }
    }
  });
});

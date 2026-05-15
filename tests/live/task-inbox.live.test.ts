/**
 * Live API tests for Inbox via the `-` sentinel (TI1-TI5).
 *
 * Boeneo's `getTaskScope` translates the project-id sentinel `-` (= the
 * inbox marker) to the current user's private Inbox before any /task/*
 * handler runs. Every project-scoped endpoint should accept `-` to mean
 * "my Inbox". Confirm here for the three endpoints (POST / GET list /
 * GET search) plus the by-id read path.
 *
 * Out of scope: /task/search-organization and /task/search-folder use
 * voidScope (no project resolution), so `-` doesn't apply there.
 *
 * QuireClient doesn't expose the `-` sentinel directly on most calls
 * (they take an OID-typed parameter that happens to accept "-" on the
 * wire), so several of these go through rawApi for clarity.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — Inbox via `-`", () => {
  const client = liveClient();
  const SEARCH_MARKER = `inbox${Date.now()}`;
  const TASK_NAME = `${runTag}-inbox ${SEARCH_MARKER}`;

  let inboxTask: QuireTask;

  afterAll(async () => {
    if (inboxTask?.oid) await client.deleteTask(inboxTask.oid).catch(() => {});
  });

  it("TI1 POST /task/- creates a task in the user's Inbox", async () => {
    // `-` is a project-id sentinel; QuireClient.createTask takes an OID,
    // and the `-` path isn't part of the typed surface. Probe with rawApi.
    const { status, data } = await rawApi<QuireTask>("POST", `/task/-`, {
      name: TASK_NAME,
      description: "ti1 body",
    });
    expect(status).toBe(200);
    expect(data.oid).toBeTruthy();
    expect(data.id).toBeGreaterThan(0);
    expect(data.nameText ?? data.name).toBe(TASK_NAME);
    inboxTask = data;
  });

  it("TI2 GET /task/list/- lists tasks in the user's Inbox", async () => {
    const { status, data } = await rawApi<QuireTask[]>("GET", `/task/list/-`);
    expect(status).toBe(200);
    expect(data.some((t) => t.oid === inboxTask.oid)).toBe(true);
  });

  // searchTasks accepts "-" as the project arg — the type is just `string`
  // and the wire passes it through. Stays on the wrapper for parity with
  // the project-scoped search tests.
  it("TI3 searchTasks('-', {text}) finds the inbox task", async () => {
    const hits = await client.searchTasks("-", { text: SEARCH_MARKER });
    expect(hits.some((t) => t.oid === inboxTask.oid)).toBe(true);
  });

  it("TI4 searchTasks('-', {status:'active', limit:5}) honours status + limit", async () => {
    const hits = await client.searchTasks("-", {
      status: "active",
      limit: 5,
    });
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const t of hits) {
      const s = typeof t.status === "object" ? t.status?.value : t.status;
      expect(s ?? 0).toBeLessThan(100);
    }
  });

  it("TI5 GET /task/id/-/{taskId} resolves an inbox task by numeric id", async () => {
    // Self-contained — TI1's inboxTask isn't reachable when run with a
    // -t filter that skips TI1.
    const created = await rawApi<QuireTask>("POST", `/task/-`, {
      name: `${runTag}-ti5`,
    });
    expect(created.status).toBe(200);
    try {
      const { status, data } = await rawApi<QuireTask>(
        "GET",
        `/task/id/-/${created.data.id}`,
      );
      expect(status).toBe(200);
      expect(data.oid).toBe(created.data.oid);
    } finally {
      await client.deleteTask(created.data.oid).catch(() => {});
    }
  });
});

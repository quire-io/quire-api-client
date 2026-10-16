/**
 * Live API tests for /dashboard (DB1-DB7), added in the Jul 20 2026 server
 * release.
 *
 * The API manages the dashboard container only — name, description, icon
 * and archive state. Widgets aren't part of it, and neither are `start` /
 * `due`: the API doc lists them because a dashboard shares its model with
 * a sublist, but only a sublist takes them (DB5).
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireDashboard } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /dashboard", () => {
  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const NAME = `${runTag}-dashboard`;

  let dashboard: QuireDashboard | undefined;

  afterAll(async () => {
    if (dashboard) await client.deleteDashboard(dashboard.oid).catch(() => {});
  });

  it("DB1 createDashboard under a project", async () => {
    dashboard = await client.createDashboard("project", PROJECT_OID, {
      name: NAME,
      description: "DB1 body",
    });
    expect(dashboard.oid).toBeTruthy();
    expect(dashboard.nameText ?? dashboard.name).toBe(NAME);
    expect((dashboard.owner as { oid?: string } | undefined)?.oid).toBe(PROJECT_OID);
  });

  it("DB2 listDashboards contains it", async () => {
    const list = await client.listDashboards("project", PROJECT_OID);
    expect(list.some((d) => d.oid === dashboard!.oid)).toBe(true);
  });

  it("DB3 getDashboard and getDashboardById return it", async () => {
    const byOid = await client.getDashboard(dashboard!.oid);
    expect(byOid.oid).toBe(dashboard!.oid);
    const byId = await client.getDashboardById("project", PROJECT_ID, dashboard!.id);
    expect(byId.oid).toBe(dashboard!.oid);
  });

  it("DB4 updateDashboard renames it and toggles archived", async () => {
    const renamed = `${NAME}-renamed`;
    const archived = await client.updateDashboard(dashboard!.oid, {
      name: renamed,
      archived: true,
    });
    expect(archived.nameText ?? archived.name).toBe(renamed);
    expect(archived.archivedAt).toBeTruthy();

    const unarchived = await client.updateDashboard(dashboard!.oid, {
      archived: false,
    });
    expect(unarchived.archivedAt).toBeFalsy();
  });

  it("DB5 start and due are rejected with 400", async () => {
    const created = await rawApi("POST", `/dashboard/project/${PROJECT_OID}`, {
      name: `${NAME}-dated`,
      start: "2027-01-02",
    });
    expect(created.status).toBe(400);

    const updated = await rawApi("PUT", `/dashboard/${dashboard!.oid}`, {
      due: null,
    });
    expect(updated.status).toBe(400);
  });

  it("DB6 deleteDashboard removes it and a subsequent GET returns 404", async () => {
    await client.deleteDashboard(dashboard!.oid);
    const got = await rawApi("GET", `/dashboard/${dashboard!.oid}`);
    expect(got.status).toBe(404);
  });

  it("DB7 undoRemoveDashboard restores it and is idempotent", async () => {
    const restored = await client.undoRemoveDashboard(dashboard!.oid);
    expect(restored.oid).toBe(dashboard!.oid);
    const again = await client.undoRemoveDashboard(dashboard!.oid);
    expect(again.oid).toBe(dashboard!.oid);
    // afterAll cleans up.
  });
});

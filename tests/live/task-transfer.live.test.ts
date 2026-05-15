/**
 * Live API tests for /task/transfer (TT1).
 *
 * Transfer moves a task cross-project, distinct from /task/move which is
 * intra-project. The QuireClient `transferTask` wrapper builds the query
 * string (`?project=<target>` and friends) and PUTs an empty body.
 *
 * Creates a task in a secondary project (Test_Transfer_Project) and transfers
 * it into the configured test project. Cleans up by deleting in afterAll.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/transfer", () => {
  const client = liveClient();
  const TARGET_PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  // A second project in the test workspace used as the transfer source.
  // https://quire.io/w/Test_Transfer_Project — stable fixture, safe to hardcode.
  const SOURCE_PROJECT_ID = "Test_Transfer_Project";

  let transferredTaskOid = "";

  afterAll(async () => {
    if (transferredTaskOid) {
      await client.deleteTask(transferredTaskOid).catch(() => {});
    }
  });

  it("TT1 transferTask moves the task into the target project", async () => {
    // QuireClient.createTask requires a project OID; use rawApi to create
    // by project id (Test_Transfer_Project) since we only have the slug.
    const create = await rawApi<QuireTask>(
      "POST",
      `/task/id/${encodeURIComponent(SOURCE_PROJECT_ID)}`,
      { name: `${runTag}-transfer` },
    );
    expect(create.status).toBe(200);
    transferredTaskOid = create.data.oid;

    await client.transferTask(transferredTaskOid, {
      project: TARGET_PROJECT_OID,
    });

    // GET /task/{oid} doesn't echo a `project` field (that decoration only
    // appears on org/folder search results). Verify the move via presence
    // in the target project's list and absence from the source.
    const targetList = await client.listTasks(TARGET_PROJECT_OID);
    expect(targetList.some((t) => t.oid === transferredTaskOid)).toBe(true);

    const sourceList = await rawApi<QuireTask[]>(
      "GET",
      `/task/list/id/${encodeURIComponent(SOURCE_PROJECT_ID)}`,
    );
    expect(sourceList.status).toBe(200);
    expect(sourceList.data.some((t) => t.oid === transferredTaskOid)).toBe(false);
  });
});

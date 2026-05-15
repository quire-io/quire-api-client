/**
 * Live API tests for /task/transfer (TT1).
 *
 * Transfer moves a task cross-project, distinct from /task/move which is
 * intra-project. The QuireClient `transferTask` wrapper builds the query
 * string (`?project=<target>` and friends) and PUTs an empty body.
 *
 * Creates a task in a secondary project (QUIRE_TEST_TRANSFER_PROJECT_ID) and
 * transfers it into the configured test project. Skipped when that env var
 * isn't set — Quire project ids are workspace-globally unique, so each fork
 * has to provision its own second project. Cleans up by deleting in afterAll.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireTask } from "../../src/index.js";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

const SOURCE_PROJECT_ID = readEnvOptional("QUIRE_TEST_TRANSFER_PROJECT_ID");

describe.skipIf(!hasTokens || !SOURCE_PROJECT_ID)("Live API — /task/transfer", () => {
  const client = liveClient();
  const TARGET_PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");

  let transferredTaskOid = "";

  afterAll(async () => {
    if (transferredTaskOid) {
      await client.deleteTask(transferredTaskOid).catch(() => {});
    }
  });

  it("TT1 transferTask moves the task into the target project", async () => {
    // QuireClient.createTask requires a project OID; use rawApi to create
    // by project id (the source project slug) since we only have the slug.
    const create = await rawApi<QuireTask>(
      "POST",
      `/task/id/${encodeURIComponent(SOURCE_PROJECT_ID!)}`,
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
      `/task/list/id/${encodeURIComponent(SOURCE_PROJECT_ID!)}`,
    );
    expect(sourceList.status).toBe(200);
    expect(sourceList.data.some((t) => t.oid === transferredTaskOid)).toBe(false);
  });
});

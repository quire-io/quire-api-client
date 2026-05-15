/**
 * Live API tests for /doc (D1-D7).
 *
 * Documents are owned by a project (the only owner type the API supports).
 * QuireClient's `listDocuments` / `createDocument` / `updateDocument` /
 * `deleteDocument` / `undoRemoveDocument` wrap the OID-form endpoints;
 * `getDocumentByProjectAndId` covers the /id/ read path.
 */

import { describe, it, expect, afterAll } from "vitest";
import type { QuireDocument } from "../../src/index.js";
import { hasTokens, liveClient, rawApi, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /doc", () => {
  const client = liveClient();
  const PROJECT_ID = readEnv("QUIRE_TEST_PROJECT_ID");
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const DOC_NAME = `${runTag}-doc`;

  let doc: QuireDocument | undefined;

  afterAll(async () => {
    if (doc) await client.deleteDocument(doc.oid).catch(() => {});
  });

  it("D1 createDocument under a project", async () => {
    doc = await client.createDocument("project", PROJECT_OID, {
      name: DOC_NAME,
    });
    expect(doc.oid).toBeTruthy();
    expect(doc.nameText ?? doc.name).toBe(DOC_NAME);
  });

  it("D2 listDocuments contains the new doc", async () => {
    const list = await client.listDocuments("project", PROJECT_OID);
    expect(list.some((d) => d.oid === doc!.oid)).toBe(true);
  });

  it("D3 getDocument returns the doc", async () => {
    const got = await client.getDocument(doc!.oid);
    expect(got.oid).toBe(doc!.oid);
    expect(got.nameText ?? got.name).toBe(DOC_NAME);
  });

  it("D4 getDocumentByProjectAndId matches by id", async () => {
    const got = await client.getDocumentByProjectAndId(PROJECT_ID, doc!.id);
    expect(got.oid).toBe(doc!.oid);
  });

  it("D5 updateDocument changes the name", async () => {
    const RENAMED = `${DOC_NAME}-renamed`;
    const updated = await client.updateDocument(doc!.oid, { name: RENAMED });
    expect(updated.nameText ?? updated.name).toBe(RENAMED);

    const fresh = await client.getDocument(doc!.oid);
    expect(fresh.nameText ?? fresh.name).toBe(RENAMED);
  });

  it("D6 deleteDocument removes the doc and a subsequent GET returns 404", async () => {
    await client.deleteDocument(doc!.oid);
    const get = await rawApi("GET", `/doc/${doc!.oid}`);
    expect(get.status).toBe(404);
    doc = undefined;
  });

  // undoRemoveDocument counts against the doc creation quota. Self-contained
  // so the test can run without depending on D6.
  it("D7 undoRemoveDocument restores a removed doc", async () => {
    const created = await client.createDocument("project", PROJECT_OID, {
      name: `${runTag}-doc-undo`,
    });
    await client.deleteDocument(created.oid);
    expect((await rawApi("GET", `/doc/${created.oid}`)).status).toBe(404);

    const restored = await client.undoRemoveDocument(created.oid);
    expect(restored.oid).toBe(created.oid);

    const fresh = await client.getDocument(created.oid);
    expect(fresh.oid).toBe(created.oid);

    await client.deleteDocument(created.oid).catch(() => {});
  });
});

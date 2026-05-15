/**
 * Live API tests for file attachments on tasks (A1, A2) and comments (A3,
 * A4).
 *
 * Wire contract: POST /task/attach/{taskOid}/{filename} (and
 * /comment/attach/{commentOid}/{filename}) accept a raw-bytes body with
 * the caller's Content-Type. Response shape: { name, url, length }, where
 * `url` is a presigned download link. QuireClient wraps both via
 * `attachTaskFile` / `attachCommentFile`.
 *
 * The comment endpoint's byId form is explicitly rejected server-side
 * (boeneo `comment_api.dart:93`) — only the OID form is exposed.
 *
 * On subsequent GET /task/{oid} or GET /comment/{oid}, the attachment
 * appears in `attachments[]`; the per-entry shape is captured via console
 * output so future read-side wiring can match it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QuireComment, QuireTask } from "../../src/index.js";
import { hasTokens, liveClient, readEnv, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /task/attach", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const FILE_NAME = `${runTag}-attach.md`;
  const FILE_BODY = `# ${runTag}\n\nProbe payload for the attach contract.\n`;
  const FILE_BYTES = new TextEncoder().encode(FILE_BODY);

  let taskOid: string | undefined;

  beforeAll(async () => {
    const t = await client.createTask(PROJECT_OID, {
      name: `${runTag}-attach-host`,
    });
    taskOid = t.oid;
  });

  afterAll(async () => {
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("A1 attachTaskFile uploads raw bytes and returns { name, url, length }", async () => {
    const att = await client.attachTaskFile(
      taskOid!,
      FILE_NAME,
      FILE_BYTES,
      "text/markdown; charset=utf-8",
    );
    console.log("[A1] body:", att);

    expect(att.name).toBe(FILE_NAME);
    expect(typeof att.url).toBe("string");
    expect(att.url).toMatch(/^https?:\/\//);
    expect(att.length).toBe(FILE_BYTES.byteLength);
  });

  it("A2 getTask reflects the new attachment", async () => {
    const task = (await client.getTask(taskOid!)) as QuireTask & {
      attachments?: Array<Record<string, unknown>>;
    };
    const atts = task.attachments ?? [];
    console.log("[A2] attachments[]:", atts);

    expect(atts.length).toBeGreaterThanOrEqual(1);
    const match = atts.find(
      (a) => a.name === FILE_NAME || a.filename === FILE_NAME,
    );
    expect(match).toBeTruthy();
  });
});

describe.skipIf(!hasTokens)("Live API — /comment/attach", () => {
  const client = liveClient();
  const PROJECT_OID = readEnv("QUIRE_TEST_PROJECT_OID");
  const FILE_NAME = `${runTag}-comment-attach.md`;
  const FILE_BODY = `# ${runTag}\n\nProbe payload for comment attachment.\n`;
  const FILE_BYTES = new TextEncoder().encode(FILE_BODY);

  let taskOid: string | undefined;
  let commentOid: string | undefined;

  beforeAll(async () => {
    // Host task — comments are owned by tasks or chats. A task host is
    // simpler to set up than a chat and exercises the more common path.
    const task = await client.createTask(PROJECT_OID, {
      name: `${runTag}-comment-attach-host`,
    });
    taskOid = task.oid;
    const c = await client.addComment(taskOid, `${runTag}-comment-attach`);
    commentOid = c.oid;
  });

  afterAll(async () => {
    // Deleting the host task cascades to comments + their attachments.
    if (taskOid) await client.deleteTask(taskOid).catch(() => {});
  });

  it("A3 attachCommentFile uploads raw bytes and returns the same shape", async () => {
    const att = await client.attachCommentFile(
      commentOid!,
      FILE_NAME,
      FILE_BYTES,
      "text/markdown; charset=utf-8",
    );
    console.log("[A3] body:", att);

    expect(att.name).toBe(FILE_NAME);
    expect(typeof att.url).toBe("string");
    expect(att.url).toMatch(/^https?:\/\//);
    expect(att.length).toBe(FILE_BYTES.byteLength);
  });

  it("A4 getComment reflects the new attachment", async () => {
    const comment = (await client.getComment(commentOid!)) as QuireComment & {
      attachments?: Array<Record<string, unknown>>;
    };
    const atts = comment.attachments ?? [];
    console.log("[A4] attachments[]:", atts);

    expect(atts.length).toBeGreaterThanOrEqual(1);
    const match = atts.find(
      (a) => a.name === FILE_NAME || a.filename === FILE_NAME,
    );
    expect(match).toBeTruthy();
  });
});

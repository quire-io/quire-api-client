import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QuireClient } from "../client.js";
import {
  QuireAuthRevokedError,
  QuireTokenRefreshError,
} from "../errors.js";

const FAR_FUTURE = Date.now() + 60 * 60 * 1000;
const NEAR_EXPIRY = Date.now() + 60 * 1000; // inside the 5-min refresh window

function mkTokens(expiresAt = FAR_FUTURE) {
  return {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt,
  };
}

function htmlResponse(status: number): Response {
  return new Response("<!DOCTYPE html><html>...</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const apiServer = "https://quire.io";

describe("QuireClient auth handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onAuthRevoked: ReturnType<typeof vi.fn>;
  let onTokenRefresh: ReturnType<typeof vi.fn>;
  let refreshTokens: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    onAuthRevoked = vi.fn().mockResolvedValue(undefined);
    onTokenRefresh = vi.fn().mockResolvedValue(undefined);
    refreshTokens = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(tokens = mkTokens()) {
    return new QuireClient({
      tokens,
      apiServer,
      refreshTokens,
      onTokenRefresh,
      onAuthRevoked,
    });
  }

  it("returns the response body on a normal 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "u1" }));

    await expect(mkClient().getMe()).resolves.toEqual({ oid: "u1" });
    expect(onAuthRevoked).not.toHaveBeenCalled();
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("retries once on 401 after a successful refresh and keeps going", async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(401))
      .mockResolvedValueOnce(jsonResponse({ oid: "u1" }));
    refreshTokens.mockResolvedValueOnce({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: FAR_FUTURE,
    });

    await expect(mkClient().getMe()).resolves.toEqual({ oid: "u1" });

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(refreshTokens).toHaveBeenCalledWith("old-refresh");
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthRevoked).not.toHaveBeenCalled();
    // The retry must use the newly-refreshed access token, not the stale one.
    const retryHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer new-access");
  });

  it("revokes + throws QuireAuthRevokedError when refresh returns 4xx", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(401));
    refreshTokens.mockRejectedValueOnce(new QuireTokenRefreshError(401));

    await expect(mkClient().getMe()).rejects.toBeInstanceOf(QuireAuthRevokedError);

    expect(onAuthRevoked).toHaveBeenCalledTimes(1);
    expect(onTokenRefresh).not.toHaveBeenCalled();
    // Only the original request fires — no retry after the refresh fails.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revokes when the retry still 401s even though refresh claimed success", async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(401))
      .mockResolvedValueOnce(htmlResponse(401));
    refreshTokens.mockResolvedValueOnce({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: FAR_FUTURE,
    });

    await expect(mkClient().getMe()).rejects.toBeInstanceOf(QuireAuthRevokedError);

    expect(onAuthRevoked).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("revokes on a near-expiry preemptive refresh 4xx without hitting the API", async () => {
    refreshTokens.mockRejectedValueOnce(new QuireTokenRefreshError(400));

    await expect(mkClient(mkTokens(NEAR_EXPIRY)).getMe()).rejects.toBeInstanceOf(
      QuireAuthRevokedError,
    );

    expect(onAuthRevoked).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows without revoking when refresh fails with 5xx (transient)", async () => {
    refreshTokens.mockRejectedValueOnce(new QuireTokenRefreshError(503));

    await expect(mkClient(mkTokens(NEAR_EXPIRY)).getMe()).rejects.toBeInstanceOf(
      QuireTokenRefreshError,
    );

    expect(onAuthRevoked).not.toHaveBeenCalled();
  });

  it("treats a 401 as revoked when no refreshTokens callback is wired up", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(401));

    const client = new QuireClient({
      tokens: mkTokens(),
      apiServer,
      onAuthRevoked,
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(QuireAuthRevokedError);
    expect(onAuthRevoked).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("apiServer URL normalization", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips trailing slashes from apiServer", async () => {
    const client = new QuireClient({
      tokens: mkTokens(),
      apiServer: "https://quire.io///",
    });
    await client.listTasks("oid-p1");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://quire.io/api/task/list/oid-p1");
  });
});

describe("project export endpoints", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("exportProjectCsv returns the raw body string (no JSON parse)", async () => {
    const csv = "id,name\n1,Hello\n2,\"with, comma\"\n";
    fetchMock.mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }),
    );

    await expect(mkClient().exportProjectCsv("oid-p1")).resolves.toBe(csv);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://quire.io/api/project/export-csv/oid-p1",
    );
  });

  it("exportProjectJsonById percent-encodes the slug and returns raw text", async () => {
    const body = '{"name":"My Project","tasks":[]}';
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(
      mkClient().exportProjectJsonById("acme/my project"),
    ).resolves.toBe(body);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://quire.io/api/project/export-json/id/acme%2Fmy%20project",
    );
  });
});

describe("listTasks / listSubtasks pagination params", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("listTasks omits the query string when no paging options are passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().listTasks("oid-p1");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/\/task\/list\/oid-p1$/);
  });

  it("listTasks forwards limit + cursor as query params (Apr 27 2026)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().listTasks("oid-p1", { limit: 30, cursor: "tok=abc" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("limit=30");
    // Cursor must be percent-encoded — `=` in `tok=abc` becomes `%3D`.
    expect(url).toContain("cursor=tok%3Dabc");
  });

  it("listSubtasks supports limit=no for explicit unlimited", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().listSubtasks("oid-t1", { limit: "no" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("limit=no");
  });
});

describe("getMyTasks scope routing", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("project scope forces mine=true on /task/search/{projectOid}", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().getMyTasks({ project: "oid-p1" }, { status: "active" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/task/search/oid-p1");
    expect(url).toContain("mine=true");
    expect(url).toContain("status=active");
  });

  it("project='-' (Inbox) omits mine=true so self-created tasks aren't dropped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().getMyTasks({ project: "-" }, { status: "active" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/task/search/-");
    expect(url).not.toContain("mine=");
    expect(url).toContain("status=active");
  });

  it("organization scope forces mine=true on /task/search-organization/{orgOid}", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().getMyTasks({ organization: "oid-org" }, { priority: "high" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/task/search-organization/oid-org");
    expect(url).toContain("mine=true");
    expect(url).toContain("priority=high");
  });

  it("allOrganizations fans out per-org, includes Inbox last, dedupes by oid", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ oid: "o1" }, { oid: "o2" }]))
      .mockResolvedValueOnce(jsonResponse([{ oid: "t1" }, { oid: "t2" }]))
      .mockResolvedValueOnce(jsonResponse([{ oid: "t2" }, { oid: "t3" }]))
      .mockResolvedValueOnce(jsonResponse([{ oid: "t1" }, { oid: "t4" }]));
    const tasks = await mkClient().getMyTasks(
      { allOrganizations: true },
      { status: "active" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]![0]).toContain("/organization/list");
    expect(fetchMock.mock.calls[1]![0]).toContain("/task/search-organization/o1");
    expect(fetchMock.mock.calls[1]![0]).toContain("mine=true");
    expect(fetchMock.mock.calls[2]![0]).toContain("/task/search-organization/o2");
    expect(fetchMock.mock.calls[3]![0]).toContain("/task/search/-");
    expect(fetchMock.mock.calls[3]![0]).not.toContain("mine=");
    expect(tasks.map((t) => t.oid)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("allOrganizations with inbox=false skips the /task/search/- call", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ oid: "o1" }]))
      .mockResolvedValueOnce(jsonResponse([{ oid: "t1" }]));
    const tasks = await mkClient().getMyTasks(
      { allOrganizations: true, inbox: false },
      { status: "active" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tasks.map((t) => t.oid)).toEqual(["t1"]);
  });

  it("allOrganizations strips cursor — cursors don't compose with fan-out", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ oid: "o1" }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    await mkClient().getMyTasks(
      { allOrganizations: true },
      { status: "active", cursor: "tok=abc" },
    );
    for (let i = 1; i < fetchMock.mock.calls.length; i++) {
      expect(fetchMock.mock.calls[i]![0]).not.toContain("cursor=");
    }
  });
});

describe("bulk endpoints accept dry-run (May 22 2026)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("bulkCreateTasks omits dry-run by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkCreateTasks("oid-p1", [{ name: "x" }]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/task/bulk-add/oid-p1");
  });

  it("bulkCreateTasks appends dry-run=true when requested", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkCreateTasks("oid-p1", [{ name: "x" }], {
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("dry-run=true");
  });

  it("bulkCreateTasks composes return=compact with dry-run", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkCreateTasks("oid-p1", [{ name: "x" }], {
      return: "compact",
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("return=compact");
    expect(url).toContain("dry-run=true");
  });

  it("bulkCreateSubtasks composes position + dry-run", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkCreateSubtasks("oid-t1", [{ name: "x" }], {
      position: "before",
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("position=before");
    expect(url).toContain("dry-run=true");
  });

  it("bulkUpdateTasks appends dry-run=true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkUpdateTasks("oid-p1", [{ oid: "oid-t1", name: "x" }], {
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("dry-run=true");
  });

  it("bulkRemoveTasks appends dry-run=true alongside default return=compact", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkRemoveTasks("oid-p1", ["oid-t1"], { dryRun: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("return=compact");
    expect(url).toContain("dry-run=true");
  });

  it("bulkRemoveTasks with return=full omits the return param but keeps dry-run", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkRemoveTasks("oid-p1", ["oid-t1"], {
      return: "full",
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain("return=");
    expect(url).toContain("dry-run=true");
  });

  it("bulkMoveTasks appends dry-run after the required task ref", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkMoveTasks("oid-p1", ["oid-t1"], {
      task: "root",
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("task=root");
    expect(url).toContain("dry-run=true");
  });

  it("bulkTransferTasks appends dry-run with per-aspect remap flags", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkTransferTasks("oid-src", ["oid-t1"], {
      project: "oid-dst",
      tag: false,
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("project=oid-dst");
    expect(url).toContain("tag=false");
    expect(url).toContain("dry-run=true");
  });

  it("bulkApproveTasks appends dry-run alongside state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkApproveTasks("oid-p1", ["oid-t1"], {
      state: "approve",
      dryRun: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("state=approve");
    expect(url).toContain("dry-run=true");
  });

  it("dryRun: false (or omitted) does not emit the param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await mkClient().bulkApproveTasks("oid-p1", ["oid-t1"], {
      state: "approve",
      dryRun: false,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain("dry-run");
  });
});

describe("single-resource writes accept ?return=compact (May 22 2026)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("createTask omits the return param by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1" }));
    await mkClient().createTask("oid-p1", { name: "x" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/task/oid-p1");
  });

  it("createTask appends return=compact when compact: true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().createTask("oid-p1", { name: "x" }, { compact: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/task/oid-p1?return=compact");
  });

  it("createSubtask appends return=compact when compact: true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().createSubtask("oid-parent", { name: "x" }, { compact: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("return=compact");
  });

  it("createTaskRelative composes position + return=compact", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().createTaskRelative(
      "oid-sib",
      { name: "x" },
      "after",
      { compact: true },
    );
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("position=after");
    expect(url).toContain("return=compact");
  });

  it("updateTask appends return=compact when compact: true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().updateTask("oid-t1", { name: "new" }, { compact: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/task/oid-t1?return=compact");
  });

  it("moveTask composes task + position + return=compact", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().moveTask("oid-t1", "oid-anchor", "before", { compact: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("task=oid-anchor");
    expect(url).toContain("position=before");
    expect(url).toContain("return=compact");
  });

  it("transferTask threads compact through the params bag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().transferTask("oid-t1", {
      project: "oid-dst",
      tag: false,
      compact: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("project=oid-dst");
    expect(url).toContain("tag=false");
    expect(url).toContain("return=compact");
  });

  it("approveTask threads compact through the body bag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "t1", id: 1 }));
    await mkClient().approveTask("oid-t1", {
      state: "approve",
      compact: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("state=approve");
    expect(url).toContain("return=compact");
    // Confirm `compact` is NOT echoed into the request body (it's a wire-
    // level query-string control, not a server-side field).
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body ?? "").not.toContain("compact");
  });

  it("addComment appends return=compact via options", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "c1" }));
    await mkClient().addComment("oid-t1", "hi", { compact: true });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/comment/oid-t1?return=compact");
  });

  it("addChatComment strips compact from the body before sending", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "c1" }));
    await mkClient().addChatComment("oid-chat", {
      description: "hi",
      pinned: true,
      compact: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/comment/chat/oid-chat?return=compact");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ description: "hi", pinned: true });
    expect(sent.compact).toBeUndefined();
  });

  it("updateComment strips compact from the body before sending", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oid: "c1" }));
    await mkClient().updateComment("oid-c1", {
      description: "edited",
      compact: true,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("https://quire.io/api/comment/oid-c1?return=compact");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.compact).toBeUndefined();
  });

  // Type-narrowing assertions. These are checked at compile time by tsc
  // (which runs as part of `npm run typecheck` and the prepublishOnly hook);
  // the runtime body is a no-op since the conditional generic only matters
  // at the type layer.
  it("const-generic narrows the return type from compact literal", async () => {
    // Each fetch call needs a fresh Response — bodies can only be consumed once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ oid: "t1", id: 1, name: "x" })),
    );
    const c = mkClient();
    const full = await c.createTask("p", { name: "x" });
    const _fullName: string = full.name; // QuireTask path

    const compact = await c.createTask("p", { name: "x" }, { compact: true });
    const _compactOid: string = compact.oid; // QuireCompactRef path
    // @ts-expect-error — QuireCompactRef has no `name`
    const _compactName: string = compact.name;

    const explicit = await c.createTask("p", { name: "x" }, { compact: false });
    const _explicitName: string = explicit.name; // still QuireTask
    void _fullName;
    void _compactOid;
    void _explicitName;
  });
});

describe("getRateLimit hits the hyphenated path (May 22 2026)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkClient(): QuireClient {
    return new QuireClient({ tokens: mkTokens(), apiServer });
  }

  it("calls /rate-limit/{orgOid}, not the deprecated /rate_limit form", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ minute: {}, hour: {} }));
    await mkClient().getRateLimit("oid-org");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://quire.io/api/rate-limit/oid-org",
    );
  });
});

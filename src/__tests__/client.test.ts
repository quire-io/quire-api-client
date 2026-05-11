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

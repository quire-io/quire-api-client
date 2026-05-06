import { describe, it, expect } from "vitest";
import { formatQuireError } from "../errors.js";

describe("formatQuireError", () => {
  it("maps 469 to the quota / pricing hint", () => {
    expect(formatQuireError(469, "whatever", "application/json"))
      .toBe("Quire quota exceeded (469). See https://quire.io/pricing.");
  });

  // Quire wraps ecQuotaExceeded (code 469) inside HTTP 429 for at least
  // POST /insight/{projectOid} on a free-plan project — verified against a
  // local Quire dev server (see SUB7 in tests/quire_api/subscription.test.ts).
  // The generic 429 "rate limited — retry after Xs" message would mislead
  // the caller into telling the user to wait when waiting won't help.
  it("treats 429 with `code: 469` JSON body as quota exceeded, surfacing the body message", () => {
    const body = JSON.stringify({
      code: 469,
      message: "Unable to perform this action due to insight quota limitations. Please upgrade your subscription or contact us for more details.",
    });
    expect(
      formatQuireError(429, body, "application/json; charset=utf-8"),
    ).toBe(
      "Quire quota exceeded (469): Unable to perform this action due to insight quota limitations. Please upgrade your subscription or contact us for more details. See https://quire.io/pricing.",
    );
  });

  it("uses the body message when status 469 has a JSON `message` field", () => {
    const body = JSON.stringify({ code: 469, message: "Custom quota detail." });
    expect(formatQuireError(469, body, "application/json")).toBe(
      "Quire quota exceeded (469): Custom quota detail. See https://quire.io/pricing.",
    );
  });

  it("falls through to the rate-limit message for a 429 without `code: 469`", () => {
    expect(formatQuireError(429, "", "text/html", "/task/oid_x", "30"))
      .toBe("Quire API error 429 (rate limited — retry after 30s)");
  });

  it("falls through to the rate-limit message for a 429 with non-JSON body", () => {
    expect(formatQuireError(429, "<html>throttled</html>", "text/html"))
      .toBe("Quire API error 429 (rate limited — wait at least 60s before retrying; precise wait time unavailable)");
  });

  it("falls through to the rate-limit message for a 429 with JSON but no quota code", () => {
    expect(
      formatQuireError(429, JSON.stringify({ message: "slow down" }), "application/json"),
    ).toBe("Quire API error 429 (rate limited — wait at least 60s before retrying; precise wait time unavailable)");
  });

  it("uses the JSON `message` field when the body is JSON", () => {
    const body = JSON.stringify({ code: 400, message: "Invalid color for `color`: blue" });
    expect(formatQuireError(400, body, "application/json")).toBe(
      "Quire API error 400: Invalid color for `color`: blue",
    );
  });

  it("falls back to the status hint for HTML 404 bodies", () => {
    const body = "<!DOCTYPE html><html><body>Not Found</body></html>";
    expect(formatQuireError(404, body, "text/html; charset=utf-8"))
      .toBe("Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)");
  });

  it("falls back to the status hint for HTML 401 bodies", () => {
    expect(formatQuireError(401, "<!DOCTYPE html>...", "text/html"))
      .toBe("Quire API error 401 (unauthorized — token invalid or expired)");
  });

  it("falls back to the status hint for HTML 403 bodies", () => {
    expect(formatQuireError(403, "<!DOCTYPE html>...", "text/html"))
      .toBe("Quire API error 403 (forbidden — missing Authorization header or insufficient OAuth scope)");
  });

  it("flags a 403 on a paid-only path as plan-gated", () => {
    expect(
      formatQuireError(
        403,
        "<!DOCTYPE html>...",
        "text/html",
        "/task/search-organization/oid_abc123?text=foo",
      ),
    ).toBe(
      "Quire API error 403: this request requires a paid Quire plan. See https://quire.io/pricing.",
    );
  });

  it("flags a 403 on /task/search/ with limit=no as plan-gated", () => {
    expect(
      formatQuireError(
        403,
        "<!DOCTYPE html>...",
        "text/html",
        "/task/search/oid_proj?text=x&limit=no",
      ),
    ).toBe(
      "Quire API error 403: this request requires a paid Quire plan. See https://quire.io/pricing.",
    );
  });

  it("does not apply the plan-gated message to 403s on non-paid paths", () => {
    expect(
      formatQuireError(403, "<!DOCTYPE html>...", "text/html", "/task/oid_abc123"),
    ).toBe(
      "Quire API error 403 (forbidden — missing Authorization header or insufficient OAuth scope)",
    );
  });

  it("does not flag a regular /task/search/ 403 (no limit=no) as plan-gated", () => {
    expect(
      formatQuireError(
        403,
        "<!DOCTYPE html>...",
        "text/html",
        "/task/search/oid_proj?text=x&limit=10",
      ),
    ).toBe(
      "Quire API error 403 (forbidden — missing Authorization header or insufficient OAuth scope)",
    );
  });

  it("does not apply the plan-gated message to non-403 statuses on paid paths", () => {
    expect(
      formatQuireError(
        404,
        "<!DOCTYPE html>...",
        "text/html",
        "/task/search-organization/oid_abc123",
      ),
    ).toBe(
      "Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)",
    );
  });

  it("handles malformed JSON gracefully (treats as no-hint fallback)", () => {
    expect(formatQuireError(400, "{not-json", "application/json"))
      .toBe("Quire API error 400 (bad request)");
  });

  it("handles missing content-type", () => {
    expect(formatQuireError(500, "", null))
      .toBe("Quire API error 500");
  });

  it("formats a 429 with delta-seconds Retry-After under a minute", () => {
    expect(
      formatQuireError(429, "", "text/html", "/task/oid_x", "30"),
    ).toBe("Quire API error 429 (rate limited — retry after 30s)");
  });

  it("formats a 429 with delta-seconds Retry-After over a minute", () => {
    expect(
      formatQuireError(429, "", "text/html", "/task/oid_x", "125"),
    ).toBe("Quire API error 429 (rate limited — retry after 2m 5s)");
  });

  it("formats a 429 with delta-seconds Retry-After on a round minute", () => {
    expect(
      formatQuireError(429, "", "text/html", "/task/oid_x", "180"),
    ).toBe("Quire API error 429 (rate limited — retry after 3m)");
  });

  it("falls through to the raw value when Retry-After is an HTTP-date", () => {
    expect(
      formatQuireError(
        429,
        "",
        "text/html",
        "/task/oid_x",
        "Wed, 21 Oct 2026 07:28:00 GMT",
      ),
    ).toBe(
      "Quire API error 429 (rate limited — retry after Wed, 21 Oct 2026 07:28:00 GMT)",
    );
  });

  it("falls back to a 60s floor message when the Retry-After header is missing", () => {
    expect(formatQuireError(429, "", "text/html", "/task/oid_x"))
      .toBe("Quire API error 429 (rate limited — wait at least 60s before retrying; precise wait time unavailable)");
  });

  it("falls back to a 60s floor message when the Retry-After header is blank", () => {
    expect(formatQuireError(429, "", "text/html", "/task/oid_x", "   "))
      .toBe("Quire API error 429 (rate limited — wait at least 60s before retrying; precise wait time unavailable)");
  });

  // When a cached/stale task OID 404s and the user referenced the task by
  // numeric id (e.g. "#408"), steer the caller toward `getTaskByProjectAndId`
  // so they can recover without falling back to a text search.
  it("appends a get_task_by_id hint for 404 on /task/{oid}", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/oid_abc123"),
    ).toBe(
      'Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong). If the user referenced the task by its numeric id (e.g. "#408"), call `get_task_by_id(projectId, taskId)` to resolve a current OID.',
    );
  });

  it("appends the hint for 404 on /task/move/{oid}", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/move/oid_abc123?task=root"),
    ).toContain("call `get_task_by_id(projectId, taskId)`");
  });

  // /task/transfer 404s used to ride the same generic hint as /task/{oid},
  // which sent the caller hunting for a stale source OID even though the
  // source is almost never the culprit. Steer it at the destination
  // project / scope / direction instead.
  it("returns a transfer-specific 404 message instead of the get_task_by_id hint", () => {
    const msg = formatQuireError(
      404,
      "<!DOCTYPE html>...",
      "text/html",
      "/task/transfer/oid_abc123?project=Some_Project",
    );
    expect(msg).toContain("/task/transfer");
    expect(msg).toContain("destination");
    expect(msg).toContain("project→Inbox");
    expect(msg).not.toContain("call `get_task_by_id");
  });

  it("appends the hint for 404 on /task/undo-remove/{oid}", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/undo-remove/oid_abc123"),
    ).toContain("call `get_task_by_id(projectId, taskId)`");
  });

  it("does NOT append the hint when the 404 comes from the id form itself", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/id/Proj_X/408"),
    ).toBe(
      "Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)",
    );
  });

  it("does NOT append the hint for 404 on search paths that take project/org OIDs", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/search/oid_proj?text=x"),
    ).toBe(
      "Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)",
    );
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/task/search-organization/oid_org"),
    ).toBe(
      "Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)",
    );
  });

  it("does NOT append the hint for 404 on non-task paths", () => {
    expect(
      formatQuireError(404, "<!DOCTYPE html>...", "text/html", "/tag/oid_abc"),
    ).toBe(
      "Quire API error 404 (not found — resource may have been deleted or the OID/ID is wrong)",
    );
  });
});

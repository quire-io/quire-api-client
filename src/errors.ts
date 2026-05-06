/**
 * Format a Quire API error into a short user-facing message.
 *
 * Quire's error response shapes vary by status code:
 *   - 400 validation → JSON `{ code, message }` (e.g. "Invalid color for …")
 *   - 469 ecQuotaExceeded → JSON `{ code: 469, message }` (legacy shape)
 *   - 429 with JSON `{ code: 469, message }` → quota exceeded *wrapped* in
 *     429. Observed for `POST /insight/{projectOid}` on a free-plan project
 *     against a Quire dev server: HTTP 429, body `{"code":469,"message":
 *     "Unable to perform this action due to insight quota limitations…"}`.
 *     We treat any 4xx with `code: 469` in the body as quota-exceeded.
 *   - 429 (rate limit, no JSON body) → throttling, retry after wait
 *   - 401 / 403 / 404 → a full HTML error page
 *
 * Dropping raw HTML from thrown Errors keeps consumer-facing failures
 * readable — otherwise the caller surfaces an entire <!DOCTYPE html>
 * document.
 */

const STATUS_HINTS: Readonly<Record<number, string>> = Object.freeze({
  400: "bad request",
  401: "unauthorized — token invalid or expired",
  403: "forbidden — missing Authorization header or insufficient OAuth scope",
  404: "not found — resource may have been deleted or the OID/ID is wrong",
  409: "conflict",
  429: "rate limited",
});

// Quire plan-gates a handful of requests with a bare HTML 403 — no JSON
// code, no distinguishing body. Verified via tests/quire_api/subscription.test.ts.
// Two shapes of gating:
//   - Whole-endpoint gate (SUB3): /task/search-organization/ is paid-only
//     as a whole. Only include paths where the plan check fires BEFORE
//     the resource lookup, so a 403 can be attributed to the plan and not
//     to a missing resource. /task/search-folder/ resource-checks first
//     (SUB5 → 404 on bogus oid), so we can't tell plan-gated apart from
//     not-found there; intentionally excluded.
//   - Query-param gate (SUB6): `limit=no` on /task/search/ requires the
//     paid `qoApiSearchLimit` quota. The endpoint itself is not paid-only,
//     so we only flag 403s where the offending param is present — a
//     regular /task/search/ 403 from scope/membership falls through to
//     the generic hint.
const PAID_ONLY_PATH_PREFIXES: readonly string[] = Object.freeze([
  "/task/search-organization/",
]);

function isPaidOnlyPath(path: string | undefined): boolean {
  if (!path) return false;
  if (PAID_ONLY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (
    path.startsWith("/task/search/") &&
    /[?&]limit=no(?:&|$)/.test(path)
  ) {
    return true;
  }
  return false;
}

// A 404 on a task OID path (e.g. /task/{oid}, /task/move/{oid},
// /task/undo-remove/{oid}) usually means the cached OID is stale — the task
// may have been recreated or the earlier OID was never correct. When the
// user referenced the task by its numeric id (e.g. "#408"), the caller can
// recover via `getTaskByProjectAndId(projectId, taskId)`. Steer it there.
// Excludes /task/id/... (already the resolved form — hinting back at
// get_task_by_id would loop), /task/search* (those take project/org/
// folder OIDs, not task OIDs), and /task/transfer/ (the source task is
// rarely the culprit there — see isTaskTransferPath below).
const TASK_OID_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\/task\/[^/?]+(?:$|\?)/,
  /^\/task\/(?:move|undo-remove|list)\/[^/?]+(?:$|\?)/,
]);

function isTaskOidPath(path: string | undefined): boolean {
  if (!path) return false;
  if (path.startsWith("/task/id/")) return false;
  return TASK_OID_PATH_PATTERNS.some((re) => re.test(path));
}

// Issue #16 — `/task/transfer/{oid}?project=<dest>` 404s misread as a
// stale source OID under the generic hint. In practice the source task is
// almost never the culprit: the destination `project` slug is wrong, the
// caller lacks membership there, or the transfer is project→Inbox (Quire
// only allows the reverse). Branch the message before the generic hint
// fires so the caller debugs the destination, not the source.
const TASK_TRANSFER_PATH_PATTERN = /^\/task\/transfer\/[^/?]+(?:$|\?)/;

function isTaskTransferPath(path: string | undefined): boolean {
  return path !== undefined && TASK_TRANSFER_PATH_PATTERN.test(path);
}

export function formatQuireError(
  status: number,
  body: string,
  contentType: string | null,
  path?: string,
  retryAfter?: string | null,
): string {
  // Quota-exceeded check runs BEFORE the generic 429 branch — Quire
  // wraps `ecQuotaExceeded` (code 469) inside HTTP 429 for some endpoints
  // (e.g. POST /insight/{projectOid} on free plan), and the generic 429
  // path would mis-tell the caller to wait and retry when retrying won't help.
  const quotaMessage = extractQuotaMessage(body, contentType);
  if (status === 469 || quotaMessage !== null) {
    return quotaMessage
      ? `Quire quota exceeded (469): ${quotaMessage} See https://quire.io/pricing.`
      : "Quire quota exceeded (469). See https://quire.io/pricing.";
  }

  if (status === 403 && isPaidOnlyPath(path)) {
    return "Quire API error 403: this request requires a paid Quire plan. See https://quire.io/pricing.";
  }

  if (status === 429) {
    const wait = formatRetryAfter(retryAfter);
    return wait
      ? `Quire API error 429 (rate limited — retry after ${wait})`
      // No Retry-After header on the response. Quire's rate limits are
      // minute-bucketed (qrlMin* / qrlHr* — see boeneo's RateLimit code),
      // so 60s is the safe floor: if the bucket is one-minute, waiting a
      // full minute clears it; if it's hour-bucket, the caller will get
      // another 429 at 60s and can back off further.
      : "Quire API error 429 (rate limited — wait at least 60s before retrying; precise wait time unavailable)";
  }

  if (contentType && contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        return `Quire API error ${status}: ${parsed.message}`;
      }
    } catch {
      // fall through to the short-hint path
    }
  }

  const hint = STATUS_HINTS[status];
  const base = hint
    ? `Quire API error ${status} (${hint})`
    : `Quire API error ${status}`;

  if (status === 404 && isTaskTransferPath(path)) {
    return `${base}. On /task/transfer this is most likely the destination \`project\` id (wrong slug, no membership, or a project→Inbox transfer — which Quire forbids). The source task OID is rarely the cause here; verify \`project\` and your destination access before re-resolving the task.`;
  }
  if (status === 404 && isTaskOidPath(path)) {
    return `${base}. If the user referenced the task by its numeric id (e.g. "#408"), call \`get_task_by_id(projectId, taskId)\` to resolve a current OID.`;
  }
  return base;
}

// Returns the body's `message` when the JSON body has `code: 469`
// (ecQuotaExceeded) — used to detect quota errors regardless of HTTP
// status (Quire wraps quota in 429 on at least one endpoint).
function extractQuotaMessage(
  body: string,
  contentType: string | null,
): string | null {
  if (!contentType || !contentType.includes("application/json")) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (parsed.code === 469
        && typeof parsed.message === "string"
        && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // not JSON — fall through to null
  }
  return null;
}

// Parse the Retry-After header into a short human string. Accepts the
// delta-seconds form (RFC 7231 §7.1.3 — "120") that Quire uses in
// practice; falls back to the raw value for HTTP-date or unparseable
// inputs so the wait time still surfaces rather than getting dropped.
function formatRetryAfter(retryAfter: string | null | undefined): string | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return trimmed;

  const secs = Number.parseInt(trimmed, 10);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Thrown by QuireClient when the user's Quire OAuth grant is gone — either
// revoked by the user / admin, or expired past the refresh window. The
// message is user-facing: it surfaces through CLI output / UI as-is, so
// the consumer can tell the user exactly what to do. Consumers may pass a
// custom message tailored to their UX (e.g. "run `quire login` again").
export class QuireAuthRevokedError extends Error {
  constructor(
    message = "Quire authorization has been revoked or expired. Please reauthorize.",
  ) {
    super(message);
    this.name = "QuireAuthRevokedError";
  }
}

// Thrown by the package's `refreshTokens` helper, and by any consumer-
// supplied `refreshTokens` callback, when Quire's `/oauth/token` endpoint
// rejects the request. Typed so callers can tell "tokens are dead" (4xx)
// apart from a transient outage (5xx / network) — `QuireClient` uses the
// distinction to decide whether to wipe the user's stored tokens.
export class QuireTokenRefreshError extends Error {
  constructor(public readonly status: number) {
    super(`Quire token refresh failed: ${status}`);
    this.name = "QuireTokenRefreshError";
  }
}

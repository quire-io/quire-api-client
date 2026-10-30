/**
 * Authenticated Quire API client.
 *
 * Constructor injects `apiServer` (the Quire host) and a `refreshTokens`
 * callback the consumer wires up — the package itself is multi-tenant-
 * agnostic. Confidential clients pass a closure that signs refresh
 * requests with their `client_secret`; public PKCE clients pass one that
 * forwards just the `client_id`.
 */

import {
  QuireAuthRevokedError,
  QuireTokenRefreshError,
  formatQuireError,
} from "./errors.js";
import { looksLikeOid } from "./id-shape.js";
import type {
  QuireApproval,
  QuireApprovalCategory,
  QuireAttachment,
  QuireComment,
  QuireCompactRef,
  QuireFieldAccess,
  QuireFieldDefinition,
  QuireFieldOptionUpdate,
  QuireInsight,
  QuireOrganization,
  QuirePartner,
  QuireProject,
  QuireRateLimit,
  QuireRecurrence,
  QuireReminder,
  QuireReminderLead,
  QuireReminderOwnerType,
  QuireStatus,
  QuireSublist,
  QuireTag,
  QuireTask,
  QuireTaskNode,
  QuireTimelog,
  QuireChat,
  QuireDashboard,
  QuireDashboardOwnerType,
  QuireInsightOwnerType,
  QuireDocument,
  QuireTokens,
  QuireUser,
} from "./types.js";

export type RefreshTokensFn = (refreshToken: string) => Promise<QuireTokens>;
export type OnTokenRefresh = (tokens: QuireTokens) => Promise<void>;
export type OnAuthRevoked = () => Promise<void>;

// Structural logger interface. Pass `console` directly, a structured
// logger (winston / pino / your own shim) — anything with `error` and
// `info` methods works. `debug` / `warn` are optional.
export interface QuireLogger {
  error: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  debug?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
}

const noopLogger: QuireLogger = {
  error: () => {},
  info: () => {},
};

export interface QuireClientOptions {
  /** Initial access + refresh tokens. */
  tokens: QuireTokens;
  /** Quire host, e.g. `https://quire.io`. No trailing slash. */
  apiServer: string;
  /**
   * Refresh callback the consumer wires up. Receives the current refresh
   * token, returns the new token bundle. Should throw `QuireTokenRefreshError`
   * (with the HTTP status) on failure so the client can distinguish dead
   * grants (4xx → `QuireAuthRevokedError`) from transient outages (5xx).
   *
   * If omitted, the client never auto-refreshes — useful for short-lived
   * scripts that don't need rotation.
   */
  refreshTokens?: RefreshTokensFn;
  /** Persist rotated tokens. Called whenever `refreshTokens` succeeds. */
  onTokenRefresh?: OnTokenRefresh;
  /** Wipe local state. Called when the refresh token is dead (4xx). */
  onAuthRevoked?: OnAuthRevoked;
  /** Optional structured logger. Defaults to silent. */
  logger?: QuireLogger;
  /** Extra HTTP headers merged into every request (e.g. `User-Agent`). Per-request headers take precedence. */
  headers?: Record<string, string>;
}

// Query params accepted by /task/search, /task/search-organization, and
// /task/search-folder. The last two reject `sublist` and custom fields —
// Quire returns "Unsupported query parameter" on either — so those two
// fields are project-scope only.
export interface QuireTaskSearchParams {
  text?: string;
  name?: string;
  description?: string;
  /**
   * "completed" | "active" | one status value 0–100, where 100 matches every
   * completed status, like "completed". Anything else is 400.
   */
  status?: string | number;
  scheduled?: boolean;
  mine?: boolean;
  /** Interval like "7d" / "3h" / "30m" (default 7d); `false` to skip. */
  modified?: string | boolean;
  commented?: string | boolean;
  /**
   * A key of `sourceRef`: matches the tasks whose `sourceRef` has it,
   * whatever its value. Sent as `?source-ref=`.
   */
  sourceRef?: string;
  /** Integer or "no" for unlimited. Free-plan max is 30. */
  limit?: number | string;
  /**
   * Apr 27 2026 cursor pagination — token from the previous page's
   * last-item `cursor` field. Pair with the same `limit` and any other
   * filter on subsequent calls. Reaches at most 1,000,000 rows deep; a
   * deeper one is 400, so narrow the search with filters instead.
   * Cannot combine with `sublist=` (400) — and since Oct 15 2026 a
   * `sublist=` search returns no cursor to pass back: ask for a `limit` big
   * enough, or `"no"`, to get every match.
   */
  cursor?: string;
  /** Project-scope only: filter to tasks in one sublist by its OID. */
  sublist?: string;
  /**
   * Project-scope only: custom-field filters keyed by the field's display
   * name. Per-type matching (server-side):
   *   - Number / Money / Duration: bare numeric (`100`) or `op:value` grammar
   *     accepted — `ge:` / `gt:` / `le:` / `lt:` / `eq:` / `ne:` /
   *     `between:v1,v2` (inclusive) / `notBetween:v1,v2` / `isNull` /
   *     `isNotNull` (case-insensitive). Duration values follow the same
   *     `8h` / `30m` shape as `modified`. (May 27 2026)
   *   - Email / Hyperlink: exact match; `~` / `~*` prefix for regex.
   *   - Checkbox: `"true"` or `"false"`.
   *   - Select / User / Task: exact value match (user accepts OID or id).
   *   - Text custom fields are not searchable here — use the top-level
   *     `text` parameter for full-text search.
   */
  customFields?: Record<string, unknown>;
  // ---- User-ref filters (Apr 24 2026) --------------------------------------
  // Values are user OID / id / email. Boolean grammar: `,` (AND), `|` (OR),
  // `!` (NOT). Grammar strings pass through verbatim — the server parses.
  assignee?: string;
  assignor?: string;
  follower?: string;
  // ---- Tag filter (Apr 24 2026) --------------------------------------------
  // Tag OID or name; same boolean grammar as user refs. Quote names with
  // special chars: `"In Progress"`. Tag-name scope: project search matches
  // the project's tags + the org's global tags; org/folder search matches
  // any tag in the org.
  tag?: string;
  // ---- Date-column filters (Apr 24 2026) -----------------------------------
  // Keyword ops: past / yesterday / today / tomorrow / upcoming / last7d /
  // next7d / lastWeek / thisWeek / nextWeek (timezone is the caller's).
  // Value ops (token:value): ge / gt / le / lt / eq / ne / between /
  // notBetween — operand is an ISO 8601 timestamp. between / notBetween
  // are inclusive on both ends. Null ops (nullable fields only):
  // isNull / isNotNull. start / due additionally accept a date-only
  // operand (`YYYY-MM-DD`) that expands to a whole-day window.
  created?: string;
  edited?: string;
  archived?: string;
  unarchived?: string;
  toggled?: string;
  start?: string;
  due?: string;
  // ---- Apr 27 2026 filters -----------------------------------------------
  // All four use the same `,` (AND) / `|` (OR) / `!` (NOT) grammar as the
  // user-ref / tag filters above. Forwarded verbatim — the server parses.
  /** Integer (-1 Low / 0 Medium / 1 High / 2 Urgent) or label (low / medium / high / urgent). No "none" — unset tasks default to 0 / medium. */
  priority?: string | number;
  /** normal | task | section | milestone (alias `task` = `normal`). */
  type?: string;
  /** User OID, id, or email. Sent as `?created-by=`. */
  createdBy?: string;
  /** `true` (only recurring) / `false` (only non-recurring). */
  recurring?: boolean | string;
}

/**
 * Scope selector for {@link QuireClient.getMyTasks}. Exactly one variant
 * must be passed:
 *
 * - `project` — restrict to one project (free plan). Pass `"-"` for the
 *   user's private Inbox; the method skips forcing `mine=true` on that
 *   path (every Inbox task is the user's by definition, and forcing the
 *   predicate would drop self-created tasks that aren't also self-assigned).
 * - `organization` — restrict to one organization (paid plan; same quota
 *   as `searchTasksInOrganization`).
 * - `allOrganizations: true` — fan out across every organization the
 *   authenticated user belongs to (one `/task/search-organization` call
 *   per org) and merge with dedupe-by-OID. Inbox is included by default;
 *   pass `inbox: false` to skip it.
 */
export type QuireMyTasksScope =
  | { project: string }
  | { organization: string }
  | { allOrganizations: true; inbox?: boolean };

/**
 * Filter forwarded to the underlying `/task/search*` call(s) by
 * {@link QuireClient.getMyTasks}. Excludes the fields that would conflict
 * with the My Tasks predicate: `mine` is forced by the method, and
 * `assignee` / `assignor` / `follower` / `createdBy` already collapse to
 * the current user under that predicate.
 */
export type QuireMyTasksFilter = Omit<
  QuireTaskSearchParams,
  "mine" | "assignee" | "assignor" | "follower" | "createdBy"
>;

// The search parameters whose wire name differs from the property name.
// The API doc gives the hyphenated names since Oct 30 2026; the server still
// takes the camelCase ones.
const SEARCH_PARAM_NAMES: ReadonlyMap<string, string> = new Map([
  ["createdBy", "created-by"],
  ["sourceRef", "source-ref"],
]);

function toSearchQueryString(params: QuireTaskSearchParams): string {
  const parts: string[] = [];
  const push = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  };
  for (const [k, v] of Object.entries(params)) {
    // Custom fields flatten to top-level query params keyed by display name —
    // that's how Quire's /task/search endpoint consumes them.
    if (k === "customFields") {
      if (v && typeof v === "object") {
        for (const [ck, cv] of Object.entries(v as Record<string, unknown>))
          push(ck, cv);
      }
      continue;
    }
    push(SEARCH_PARAM_NAMES.get(k) ?? k, v);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// Quire expects custom-field values as TOP-LEVEL body keys (one per display
// name), not nested under a `customFields` property. Every task write path
// accepts the same flattened shape — this helper gives the tool-layer
// ergonomic `{ customFields: {...} }` shape and rewrites it before send.
// Verified live by T18 (PUT) and TC1 (POST) in tests/quire_api/task.test.ts.
function flattenCustomFields<T extends { customFields?: Record<string, unknown> }>(
  body: T,
): Omit<T, "customFields"> & Record<string, unknown> {
  const { customFields, ...rest } = body;
  return { ...(customFields ?? {}), ...rest };
}

// Oct 23 2026: the update / rename / move / remove field endpoints, of a
// project or an insight, take the field's name in the query (`?name=`, and
// rename's `&new-name=`) instead of the path, so a name may contain `/`
// (zkoss/boeneo#26048). URLSearchParams sends a space as `+` and a `+` as
// `%2B`, as the server reads them. The path form still works but is
// deprecated, and sending both is `400`.
function fieldNameQuery(
  fieldName: string,
  more: Record<string, string> = {},
): string {
  return `?${new URLSearchParams({ name: fieldName, ...more }).toString()}`;
}

// Apr 27 2026: /task/list and /task/search gained opt-in cursor pagination
// via `?limit=N` and `?cursor=<token>`. With more pages to come, the LAST
// item in the response carries `"cursor": "<token>"`; passing it back as
// `?cursor=…` (with the same `?limit=`) fetches the next page. End of
// stream is signalled by the absence of `cursor` on the final item. The
// previous unbounded /task/list 200-cap fail-loud workaround (issue #83)
// is retired — callers paginate explicitly via `limit` / `cursor`.
// `?status=` composes with both and filters before paging.

export interface QuireTaskListOptions {
  /**
   * `"active"` or `"completed"`, or one status value (0..100). Omit for
   * every task. Applied before paging, so a page still holds `limit` tasks
   * while that many match. 100 matches every completed status, like
   * `"completed"`. Since Oct 30 2026 a value outside 0..100 is 400; before,
   * 101 matched only that status and -1 matched nothing.
   */
  status?: "active" | "completed" | number;
  /** Page size, 1..1000, or `"no"` for every task in one array. */
  limit?: number | "no";
  /** The previous page's last-item `cursor`, passed back verbatim. */
  cursor?: string;
}

function listPagingQuery(options: QuireTaskListOptions): string {
  const parts: string[] = [];
  if (options.status !== undefined) parts.push(`status=${options.status}`);
  if (options.limit !== undefined) parts.push(`limit=${options.limit}`);
  if (options.cursor !== undefined)
    parts.push(`cursor=${encodeURIComponent(options.cursor)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export interface QuireExportOptions {
  /** Export only the active or the completed tasks. Omitted, `"all"`. */
  status?: "active" | "completed" | "all";
}

export interface QuireExportCsvOptions extends QuireExportOptions {
  /** Merge the values of a repeated header, such as every tag, into one column. Default false. */
  merge?: boolean;
}

function exportQuery(options: QuireExportCsvOptions): string {
  const parts: string[] = [];
  if (options.status !== undefined) parts.push(`status=${options.status}`);
  if (options.merge !== undefined) parts.push(`merge=${options.merge}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// The `{emojis}` path segment of /comment/{add|remove}-emoji: each emoji
// percent-encoded on its own, joined with a literal comma. Blank items are
// dropped (the server ignores them anyway); a list with nothing left throws
// here, since the bare `/comment/add-emoji/{oid}/` would only come back as a
// 400 about the path.
function encodeCommentEmojis(
  method: string,
  emojis: readonly string[],
): string {
  const items = emojis.map((e) => e.trim()).filter((e) => e !== "");
  if (items.length === 0) throw new Error(`${method}: no emoji given`);
  return items.map(encodeURIComponent).join(",");
}

export class QuireClient {
  private tokens: QuireTokens;
  private readonly apiServer: string;
  private readonly logger: QuireLogger;
  private readonly refreshTokensFn?: RefreshTokensFn;
  private onTokenRefresh?: OnTokenRefresh;
  private onAuthRevoked?: OnAuthRevoked;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: QuireClientOptions) {
    this.tokens = options.tokens;
    this.apiServer = options.apiServer.replace(/\/+$/, "");
    this.logger = options.logger ?? noopLogger;
    this.refreshTokensFn = options.refreshTokens;
    this.onTokenRefresh = options.onTokenRefresh;
    this.onAuthRevoked = options.onAuthRevoked;
    this.extraHeaders = options.headers ?? {};
  }

  /** Snapshot the current tokens (e.g. after an external rotation event). */
  getTokens(): QuireTokens {
    return { ...this.tokens };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  // Refresh with revocation awareness: a 4xx from Quire's /oauth/token
  // means the refresh token is dead (user revoked the app, admin
  // disconnected, etc.), so wipe local state via onAuthRevoked and surface
  // a user-facing reconnect error. 5xx / network failures are transient —
  // rethrow without wiping so a retry can recover.
  private async tryRefresh(): Promise<void> {
    if (!this.refreshTokensFn) {
      // No refresh wired up — surface as revoked so the caller prompts a
      // re-login rather than retrying the same dead access token forever.
      await this.onAuthRevoked?.();
      throw new QuireAuthRevokedError();
    }
    try {
      this.tokens = await this.refreshTokensFn(this.tokens.refreshToken);
      await this.onTokenRefresh?.(this.tokens);
    } catch (err) {
      if (
        err instanceof QuireTokenRefreshError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        await this.onAuthRevoked?.();
        throw new QuireAuthRevokedError();
      }
      throw err;
    }
  }

  private async getAccessToken(): Promise<string> {
    // Refresh 5 minutes before expiry to avoid mid-request failures
    if (Date.now() > this.tokens.expiresAt - 5 * 60 * 1000) {
      await this.tryRefresh();
    }
    return this.tokens.accessToken;
  }

  private async rawFetch(
    path: string,
    options: RequestInit,
    token: string,
  ): Promise<Response> {
    const url = `${this.apiServer}/api${path}`;
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
        ...(options.headers as Record<string, string> | undefined),
      },
    });
  }

  // Shared request core: handles auth, the 401-refresh-retry dance, and
  // error formatting. Returns the raw Response so callers can choose how
  // to read the body — `fetch()` parses JSON, `fetchText()` returns the
  // string body (used by the project export endpoints, which don't share
  // the structured-object response shape every other endpoint has).
  private async requestRaw(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    let res = await this.rawFetch(path, options, await this.getAccessToken());

    // 401 despite a non-expired access token means Quire invalidated it
    // out-of-band. Try one refresh + retry — tryRefresh throws
    // QuireAuthRevokedError if the refresh token is also dead. If the
    // refresh "succeeds" but Quire still 401s the retry, treat as revoked.
    if (res.status === 401) {
      await this.tryRefresh();
      res = await this.rawFetch(path, options, this.tokens.accessToken);
      if (res.status === 401) {
        await this.onAuthRevoked?.();
        throw new QuireAuthRevokedError();
      }
    }

    if (!res.ok) {
      // Quire's 4xx bodies are HTML (401/403/404) *except* for validation
      // errors, which are JSON `{ code, message }`. Log the raw body for
      // debugging, but throw a short, human-friendly message — otherwise
      // consumer-facing errors dump a whole HTML page.
      const body = await res.text();
      const contentType = res.headers.get("content-type");
      const retryAfter = res.headers.get("retry-after");
      this.logger.error("quire api error", { status: res.status, path, body });
      throw new Error(
        formatQuireError(res.status, body, contentType, path, retryAfter),
      );
    }

    return res;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await this.requestRaw(path, options);

    // 204 No Content — DELETE endpoints (and some PUTs) have no body.
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  // Read the response as a raw string. Used by endpoints that return a
  // non-JSON payload (e.g. /project/export-csv); preserves byte fidelity so
  // callers can write the result straight to disk without a JSON re-stringify
  // round-trip.
  private async fetchText(
    path: string,
    options: RequestInit = {},
  ): Promise<string> {
    const res = await this.requestRaw(path, options);
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return "";
    }
    return res.text();
  }

  // -----------------------------------------------------------------------
  // User
  // -----------------------------------------------------------------------

  async getMe(): Promise<QuireUser> {
    return this.fetch("/user/id/me");
  }

  async getUserById(userId: string): Promise<QuireUser> {
    return this.fetch<QuireUser>(`/user/id/${encodeURIComponent(userId)}`);
  }

  async getUser(userOid: string): Promise<QuireUser> {
    return this.fetch<QuireUser>(`/user/${userOid}`);
  }

  // -----------------------------------------------------------------------
  // Organizations
  // -----------------------------------------------------------------------

  async listOrganizations(): Promise<QuireOrganization[]> {
    return this.fetch<QuireOrganization[]>("/organization/list");
  }

  async getOrganizationById(orgId: string): Promise<QuireOrganization> {
    return this.fetch<QuireOrganization>(`/organization/id/${encodeURIComponent(orgId)}`);
  }

  async getOrganization(orgOid: string): Promise<QuireOrganization> {
    return this.fetch<QuireOrganization>(`/organization/${orgOid}`);
  }

  // Polymorphic: input may be an OID (direct lookup) or a slug (one
  // extra /organization/id/{slug} call to resolve to the OID). Used by
  // write tools that only expose OID-based endpoints.
  async resolveOrgOid(input: string): Promise<string> {
    if (looksLikeOid(input)) return input;
    return (await this.getOrganizationById(input)).oid;
  }

  // Apr 22 2026. Returns per-hour and per-minute API usage buckets for
  // the org; the endpoint itself is free — calling it does not count
  // against either bucket (server invokes skipAppAccessLimit).
  //
  // May 22 2026: server renamed the path from `/rate_limit` to
  // `/rate-limit`. The old underscore form was accepted for a while; it is
  // `400 Invalid path` now.
  async getRateLimit(orgOid: string): Promise<QuireRateLimit> {
    return this.fetch<QuireRateLimit>(`/rate-limit/${orgOid}`);
  }

  // PUT /organization accepts `name`, `description`, and the follower
  // fields (full-replace `followers` plus the deltas, Apr 22 2026).
  // Response now includes `editedAt`. See O4 and O5 in
  // tests/quire_api/organization.test.ts.
  async updateOrganization(
    orgOid: string,
    body: {
      name?: string;
      description?: string;
      // Replaces the whole follower list; the delta forms edit in place.
      followers?: string[];
      addFollowers?: string[];
      removeFollowers?: string[];
    },
  ): Promise<QuireOrganization> {
    return this.fetch<QuireOrganization>(`/organization/${orgOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  async listProjects(): Promise<QuireProject[]> {
    return this.fetch<QuireProject[]>("/project/list");
  }

  async listProjectsByOrg(orgOid: string): Promise<QuireProject[]> {
    return this.fetch<QuireProject[]>(`/project/list/${orgOid}`);
  }

  async getProject(projectOid: string): Promise<QuireProject> {
    return this.fetch<QuireProject>(`/project/${projectOid}`);
  }

  async getProjectById(projectId: string): Promise<QuireProject> {
    return this.fetch<QuireProject>(`/project/id/${encodeURIComponent(projectId)}`);
  }

  // Polymorphic: input may be an OID (direct lookup) or a slug (one
  // extra /project/id/{slug} call to resolve to the OID). Used by
  // write tools that only expose OID-based endpoints.
  async resolveProjectOid(input: string): Promise<string> {
    if (looksLikeOid(input)) return input;
    return (await this.getProjectById(input)).oid;
  }

  async searchProjects(name: string): Promise<QuireProject[]> {
    const all = await this.listProjects();
    const q = name.toLowerCase();
    return all.filter((p) => p.name.toLowerCase().includes(q));
  }

  async listProjectMembers(projectOid: string): Promise<QuireUser[]> {
    return this.fetch<QuireUser[]>(`/user/list/project/${projectOid}`);
  }

  // PUT /project accepts `name`, `description`, `start`, `due`,
  // `archived` (bool toggle), `public` (bool toggle), and the follower
  // fields (full-replace `followers` plus the deltas, Apr 22 2026).
  // Pass null on `start` / `due` to clear the existing
  // date. Response now includes `start`, `due`, `archivedAt`, `publicAt`,
  // and the `fields` custom-field map. See P7, P10, P11, P12 in
  // tests/quire_api/project.test.ts.
  //
  // Since Oct 30 2026: `start` / `due` take a project admin, and a date
  // only — a time of day is 400, where it was stored. `public: true` on a
  // plan without public projects is 402 with body `code` 469.
  async updateProject(
    projectOid: string,
    body: {
      name?: string;
      description?: string;
      start?: string | null;
      due?: string | null;
      archived?: boolean;
      public?: boolean;
      // Replaces the whole follower list, so it takes edit access even as
      // `["me"]`; the delta forms edit in place. With read access only,
      // they may name only yourself (`"me"`, or `"app"` for the app on
      // your behalf): anyone else is 403, even along with yourself.
      followers?: string[];
      addFollowers?: string[];
      removeFollowers?: string[];
    },
  ): Promise<QuireProject> {
    return this.fetch<QuireProject>(`/project/${projectOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  // -----------------------------------------------------------------------
  // Project export
  //
  // Returns the project dump as a raw string body — caller decides whether
  // to write it to disk or parse. The export endpoints don't share the
  // structured-object response shape every other endpoint has (CSV is text,
  // JSON is a file payload), so they bypass the JSON parser via fetchText.
  //
  // `status` exports only the active or completed tasks (default `all`);
  // CSV's `merge` puts the values of a repeated header, such as every tag,
  // in one column. Professional plan and above: a lower plan is 402 with
  // body `code` 469, which since Oct 30 2026 costs 1 unit, not an export's.
  // -----------------------------------------------------------------------

  async exportProjectCsv(
    projectOid: string,
    options: QuireExportCsvOptions = {},
  ): Promise<string> {
    return this.fetchText(
      `/project/export-csv/${projectOid}${exportQuery(options)}`,
    );
  }

  async exportProjectCsvById(
    projectId: string,
    options: QuireExportCsvOptions = {},
  ): Promise<string> {
    return this.fetchText(
      `/project/export-csv/id/${encodeURIComponent(projectId)}${exportQuery(options)}`,
    );
  }

  async exportProjectJson(
    projectOid: string,
    options: QuireExportOptions = {},
  ): Promise<string> {
    return this.fetchText(
      `/project/export-json/${projectOid}${exportQuery(options)}`,
    );
  }

  async exportProjectJsonById(
    projectId: string,
    options: QuireExportOptions = {},
  ): Promise<string> {
    return this.fetchText(
      `/project/export-json/id/${encodeURIComponent(projectId)}${exportQuery(options)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Project custom-field definitions — Apr 22 2026
  //
  // Each operation addresses a definition by the project OID + the field's
  // display name, sent as `?name=` (see fieldNameQuery). Response shape
  // mirrors `FieldDefinition` in the Quire API reference; the project's GET
  // response embeds the same shape under `fields` keyed by name.
  //
  // Since Oct 23 2026: update / rename / move on a missing field, or with a
  // missing `before` field, are `404`; add, or a rename to a name already
  // taken, is `409`; remove of a missing field stays `204`. A caller who
  // isn't an admin gets `403` before any of these, so a 404 or 409 never
  // reveals a field name. Before, the path form didn't decode the name, so
  // any name needing encoding (`Billable Amount`) was never found and the
  // call reported success without changing anything.
  // -----------------------------------------------------------------------

  // `QuireFieldAccess` (Oct 15 2026) types who can view and edit the values;
  // everything else type-specific stays in the catch-all.
  async addProjectField(
    projectOid: string,
    body: { name: string; type: string; [key: string]: unknown } & QuireFieldAccess,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(`/project/add-field/${projectOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Omitted body keys preserve their current value server-side per the
  // changelog. Caller should send only the keys they want to change.
  //
  // A select field's `options` replaces the whole set (Oct 30 2026):
  //   - `from` renames that current option to `name`, and the tasks set to
  //     it keep their value under the new name. Without `from` nothing is
  //     taken as a rename: a current option no entry names, in `name` or
  //     `from`, is removed, and its tasks lose the value.
  //   - An entry without `color` keeps the color of the option it matches.
  //   - `[]` removes every option, as `conditionFormat: []` removes every
  //     rule; both used to be ignored.
  //   - An unknown `from`, two entries matching one option, or a duplicate
  //     name is 400.
  async updateProjectField(
    projectOid: string,
    fieldName: string,
    body: QuireFieldAccess & {
      options?: QuireFieldOptionUpdate[];
      conditionFormat?: unknown[];
    } & Record<string, unknown>,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/project/update-field/${projectOid}${fieldNameQuery(fieldName)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async renameProjectField(
    projectOid: string,
    fieldName: string,
    newName: string,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/project/rename-field/${projectOid}${fieldNameQuery(fieldName, { "new-name": newName })}`,
      { method: "PUT" },
    );
  }

  // Passing `before` inserts the field immediately before the named sibling.
  // Omit (or pass null) to move to the end of the order.
  async moveProjectField(
    projectOid: string,
    fieldName: string,
    before?: string | null,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/project/move-field/${projectOid}${fieldNameQuery(fieldName, before ? { before } : {})}`,
      { method: "PUT" },
    );
  }

  async removeProjectField(
    projectOid: string,
    fieldName: string,
  ): Promise<void> {
    await this.fetch<void>(
      `/project/remove-field/${projectOid}${fieldNameQuery(fieldName)}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // Project approval categories — Apr 24 2026
  //
  // Each operation addresses a category by the project OID + caller-supplied
  // id. The id is part of the POST body (not URL-derived like field names).
  // Response shape: QuireApprovalCategory; claimers / approvers keys are
  // omitted when the roster is "anyone" (internal null).
  // -----------------------------------------------------------------------

  // An `id` already in use is 409 since Oct 30 2026; it was 200 with the
  // existing category, unchanged.
  async addProjectApprovalCategory(
    projectOid: string,
    body: {
      id: string;
      name: string;
      claimers?: string[] | null;
      approvers?: string[] | null;
    },
  ): Promise<QuireApprovalCategory> {
    return this.fetch<QuireApprovalCategory>(
      `/project/add-appv-cat/${projectOid}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  // Partial update — server requires at least one of name / claimers /
  // approvers and preserves any omitted key's current value.
  async updateProjectApprovalCategory(
    projectOid: string,
    categoryId: string,
    body: {
      name?: string;
      claimers?: string[] | null;
      approvers?: string[] | null;
    },
  ): Promise<QuireApprovalCategory> {
    return this.fetch<QuireApprovalCategory>(
      `/project/update-appv-cat/${projectOid}/${encodeURIComponent(categoryId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async removeProjectApprovalCategory(
    projectOid: string,
    categoryId: string,
  ): Promise<void> {
    await this.fetch<void>(
      `/project/remove-appv-cat/${projectOid}/${encodeURIComponent(categoryId)}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------

  // /task/list with opt-in cursor pagination (Apr 27 2026). Pass `limit`
  // (positive int or "no" for unlimited) plus optional `cursor` from the
  // previous page's last item to walk multi-page result sets. Without
  // either param, the response is the full bare array as before. `status`
  // narrows it to active, completed, or one status value.
  async listTasks(
    projectOid: string,
    options: QuireTaskListOptions = {},
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/list/${projectOid}${listPagingQuery(options)}`,
    );
  }

  async listSubtasks(
    taskOid: string,
    options: QuireTaskListOptions = {},
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/list/${taskOid}${listPagingQuery(options)}`,
    );
  }

  // Subtree fetch (Apr 27 2026). `?depth=N` walks N levels of children;
  // `?depth=full` walks every level (bounded by the plan-tier total-nodes
  // cap: Free → 402, Pro 500, Premium 2000, Enterprise unbounded). The
  // anchor (`taskOid`) is required; the API rejects whole-project subtree
  // fetch (`/task/list/{projectOid}?depth>1` → 400). When the cap is hit,
  // the last sibling at the cropped level carries `cropped: true` —
  // callers drill in via a follow-up listSubtasks/listTaskTree on that
  // node. See TT1–TT5 in tests/quire_api/task.test.ts.
  async listTaskTree(
    taskOid: string,
    options: {
      depth: number | "full";
      status?: "active" | "completed" | number;
      return?: "compact";
    },
  ): Promise<QuireTaskNode[]> {
    const qs = new URLSearchParams({ depth: String(options.depth) });
    if (options.status !== undefined) qs.set("status", String(options.status));
    if (options.return) qs.set("return", options.return);
    return this.fetch<QuireTaskNode[]>(
      `/task/list/${taskOid}?${qs.toString()}`,
    );
  }

  async getTask(taskOid: string): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/${taskOid}`);
  }

  async getTaskByProjectAndId(
    projectId: string,
    taskId: string | number,
  ): Promise<QuireTask> {
    return this.fetch<QuireTask>(
      `/task/id/${encodeURIComponent(projectId)}/${encodeURIComponent(String(taskId))}`,
    );
  }

  // -----------------------------------------------------------------------
  // Task search
  //
  // Three scoped variants share the same QuireTaskSearchParams surface;
  // org- and folder-scope reject `sublist=` and per-project custom-field
  // filters (those are project-scope only — see QuireTaskSearchParams).
  // -----------------------------------------------------------------------

  async searchTasks(
    projectOid: string,
    params: QuireTaskSearchParams,
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/search/${projectOid}${toSearchQueryString(params)}`,
    );
  }

  // Org- and folder-scoped search share the full /task/search-* param
  // surface defined in boeneo/server/lib/src/api/search_task_api.dart. Each
  // field maps 1:1 to a query-string parameter; omitted fields are dropped.
  // At least one field must be provided — Quire returns
  // `queryParamMissingError` on an empty query string.
  async searchTasksInOrganization(
    orgOid: string,
    params: QuireTaskSearchParams,
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/search-organization/${orgOid}${toSearchQueryString(params)}`,
    );
  }

  async searchTasksInFolder(
    folderOid: string,
    params: QuireTaskSearchParams,
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/search-folder/${folderOid}${toSearchQueryString(params)}`,
    );
  }

  // Composite helper that returns the "My Tasks" view defined in
  // quire-platform-docs/product/features/view.md#my-tasks. Implements the
  // spec by leaning on the server-side `mine=true` predicate (which already
  // encodes the project-member + partner-member rules and the stateful-type
  // requirement), not by re-deriving the rules client-side. Three scopes:
  //
  //   - project: searchTasks(project, mine=true). `project === "-"` targets
  //     the user's Inbox and intentionally OMITS `mine=true`. The server
  //     accepts the query but resolves `-` to a project OID before the
  //     searcher runs (task_api.dart `getTaskScope`), then `mine`'s switch
  //     case calls `addSqlMyTasksCond(..., inbox: null)` (search_task_api.dart
  //     ~L163). With `inbox: null` the "always-include-Inbox" branch in
  //     my_tasks_util.dart is skipped and the Inbox project falls through
  //     the project-member predicate — which requires self-created tasks
  //     to have start or due set. That silently drops every undated Inbox
  //     capture, so we leave `mine` off on this path.
  //   - organization: searchTasksInOrganization(org, mine=true).
  //   - allOrganizations: listOrganizations + per-org search-organization
  //     fan-out with mine=true, deduped by oid. Inbox included by default
  //     (set `inbox: false` to skip). Cursor is stripped — cursors are
  //     per-search-call and don't compose with a fan-out.
  //
  // The Inbox query path goes through /task/search/-, which the server
  // requires to carry at least one filter param. The caller's `filter` is
  // forwarded as-is; if it's empty AND `mine` isn't being added (inbox
  // path), the server returns its usual `queryParamMissingError`.
  async getMyTasks(
    scope: QuireMyTasksScope,
    filter: QuireMyTasksFilter = {},
  ): Promise<QuireTask[]> {
    if ("project" in scope) {
      const params: QuireTaskSearchParams =
        scope.project === "-" ? { ...filter } : { ...filter, mine: true };
      return this.searchTasks(scope.project, params);
    }
    if ("organization" in scope) {
      return this.searchTasksInOrganization(scope.organization, {
        ...filter,
        mine: true,
      });
    }

    const fanOutFilter: QuireTaskSearchParams = { ...filter, mine: true };
    delete fanOutFilter.cursor;

    const orgs = await this.listOrganizations();
    const seen = new Set<string>();
    const merged: QuireTask[] = [];
    for (const org of orgs) {
      const tasks = await this.searchTasksInOrganization(org.oid, fanOutFilter);
      for (const t of tasks) {
        if (!seen.has(t.oid)) {
          seen.add(t.oid);
          merged.push(t);
        }
      }
    }

    if (scope.inbox !== false) {
      const inboxFilter: QuireTaskSearchParams = { ...filter };
      delete inboxFilter.cursor;
      const inboxTasks = await this.searchTasks("-", inboxFilter);
      for (const t of inboxTasks) {
        if (!seen.has(t.oid)) {
          seen.add(t.oid);
          merged.push(t);
        }
      }
    }
    return merged;
  }

  // -----------------------------------------------------------------------
  // Tasks (create, update, move, transfer)
  // -----------------------------------------------------------------------

  // `?return=compact` (May 22 2026) skips the server's post-write reload +
  // render and returns just `{oid, id}` — meaningful network + CPU win for
  // agents that only need the id to chain a follow-up call. The const-
  // generic lets TS narrow the return type from the literal `compact: true`
  // / `compact: false` at the call site without overloads.
  async createTask<const Compact extends boolean = false>(
    projectOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      // Task followers (OID, ID, or email). Special values: `"me"` (current
      // user), `"inherit"` (the parent task's followers), and `"app"` (with
      // the `app|team` / `app|team|channel` / `app|/path` syntaxes). Only
      // these users, plus anyone @mentioned in `description`, follow the
      // new task; since Oct 29 2026 the current user isn't added, so pass
      // `"me"` to follow it.
      followers?: string[];
      // Built-in Estimate field. Wire name is `etc` (non-negative integer
      // seconds). NOT a custom field — Quire 400s if sent under `customFields`.
      etc?: number;
      // Pass `milestone: true` or `section: true` to create that task type
      // directly. Safe at creation time — no side effects.
      milestone?: boolean;
      section?: boolean;
      // Recurrence spec — see docs/quire-recurring.md for the wire shape.
      recurrence?: QuireRecurrence;
      // The external team to share the task with: the name or OID of one of
      // the project's external teams. Its members then get the task and its
      // subtasks. Takes the right to assign tasks (403); a value matching
      // none of the project's teams is 400 (Oct 30 2026).
      partner?: string;
      // A JSON object the app stores with the task and reads back as is.
      // `text` (a Markdown string) is shown as the task's source line; put
      // the app's own data under a key named after the app, e.g.
      // `{ text: "Source: [issue 42](…)", github: { repo, issue } }`, and
      // find those tasks with searchTasks' `sourceRef: "github"`. At most
      // about 2,048 characters in all; 400 otherwise.
      sourceRef?: Record<string, unknown>;
      // Custom-field values (Apr 24 2026 confirmed by TC1). Flattened into
      // top-level body keys by flattenCustomFields — same shape as updateTask.
      customFields?: Record<string, unknown>;
    },
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(`/task/${projectOid}${qs}`, {
      method: "POST",
      body: JSON.stringify(flattenCustomFields(body)),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  async createSubtask<const Compact extends boolean = false>(
    parentTaskOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      // Task followers (OID, ID, or email). Special values: `"me"` (current
      // user), `"inherit"` (the parent task's followers), and `"app"` (with
      // the `app|team` / `app|team|channel` / `app|/path` syntaxes). Only
      // these users, plus anyone @mentioned in `description`, follow the
      // new task; since Oct 29 2026 the current user isn't added, so pass
      // `"me"` to follow it.
      followers?: string[];
      etc?: number;
      milestone?: boolean;
      section?: boolean;
      recurrence?: QuireRecurrence;
      // See createTask.
      partner?: string;
      sourceRef?: Record<string, unknown>;
      customFields?: Record<string, unknown>;
    },
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(`/task/${parentTaskOid}${qs}`, {
      method: "POST",
      body: JSON.stringify(flattenCustomFields(body)),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  // Create a task positioned relative to an existing sibling. Quire derives
  // the container (project for root tasks, parent task for subtasks) from
  // the sibling OID, so this single endpoint covers both root siblings and
  // subtask siblings. Verified against TPos1-TPos3 in
  // tests/quire_api/task.test.ts.
  async createTaskRelative<const Compact extends boolean = false>(
    siblingTaskOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      // Task followers (OID, ID, or email). Special values: `"me"` (current
      // user), `"inherit"` (the parent task's followers), and `"app"` (with
      // the `app|team` / `app|team|channel` / `app|/path` syntaxes). Only
      // these users, plus anyone @mentioned in `description`, follow the
      // new task; since Oct 29 2026 the current user isn't added, so pass
      // `"me"` to follow it.
      followers?: string[];
      etc?: number;
      milestone?: boolean;
      section?: boolean;
      recurrence?: QuireRecurrence;
      // See createTask.
      partner?: string;
      sourceRef?: Record<string, unknown>;
      customFields?: Record<string, unknown>;
    },
    position: "before" | "after",
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const qs = new URLSearchParams({ position });
    if (options?.compact) qs.set("return", "compact");
    return this.fetch(
      `/task/${siblingTaskOid}?${qs.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(flattenCustomFields(body)),
      },
    ) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  async updateTask<const Compact extends boolean = false>(
    taskOid: string,
    body: {
      name?: string;
      description?: string;
      // Pass null to CLEAR an existing date. Empty string is rejected by
      // Quire with "Invalid time for `due`: " — callers should normalize
      // "" to null before reaching here.
      due?: string | null;
      start?: string | null;
      priority?: string;
      status?: number;
      tags?: string[];
      assignees?: string[];
      // Replaces the whole follower list. Same value grammar as the delta
      // forms below — see addFollowers.
      followers?: string[];
      // Incremental tag/assignee edits; passed straight through to Quire,
      // which accepts these alongside the replace-mode `tags` / `assignees`.
      addTags?: string[];
      removeTags?: string[];
      addAssignees?: string[];
      removeAssignees?: string[];
      // Follower deltas (OID, ID, or email). Special values: `"me"` (current
      // user), `"app"` (the app itself, with the `app|team` /
      // `app|team|channel` / `app|/path` syntaxes), and `"inherit"` — which
      // on add pulls in the parent task's followers and on remove drops the
      // ones inherited from the parent.
      //
      // With read access only, the deltas may name only yourself (`"me"`,
      // or `"app"` for the app on your behalf): anyone else is 403, even
      // along with yourself, and `followers` takes edit access even as
      // `["me"]` (Oct 30 2026). Only following or unfollowing doesn't
      // change `editedAt`.
      addFollowers?: string[];
      removeFollowers?: string[];
      // Task dependencies. The source task's `successors` list is the only
      // editable side — `predecessors` is computed server-side by reverse
      // lookup. Each element: task OID, or "#<numeric-id>" (see
      // coerceSuccessors in api_util.dart). `removeSuccessors: ["*"]` clears
      // every successor in one call — confirmed via T23 in
      // tests/quire_api/task.test.ts.
      addSuccessors?: string[];
      removeSuccessors?: string[];
      // Built-in Estimate field — see createTask. null clears it (Oct 30
      // 2026; it was 400).
      etc?: number | null;
      // Task-type flags. `section: true` wipes assignees/tags/start/due/
      // priority/etc as a side effect (stateless type); `milestone: true`
      // wipes `start` only. Converting back does NOT restore cleared
      // fields. The `update_task` tool handles the confirmation dance —
      // pass through verbatim here.
      milestone?: boolean;
      section?: boolean;
      // Peekaboo (temporary hide). `true` = archive indefinitely;
      // positive integer = ms-since-epoch reshow timestamp (the server
      // passes it straight through as the reshowAt param of scArchiveTask).
      // `false` (unarchive) is currently broken server-side — tracked in
      // zkoss/boeneo#24491 — so we deliberately don't support it here.
      peekaboo?: boolean | number;
      // Recurrence spec — pass a full rule to set/replace (Quire replaces, it
      // does NOT merge), pass `null` to clear an existing recurrence. See
      // docs/quire-recurring.md and TR8 / TR9 in tests/quire_api/task.test.ts.
      recurrence?: QuireRecurrence | null;
      // See createTask. The API can't take a task off its team: null is 400.
      partner?: string;
      // See createTask. Replaces the stored object as a whole, so keys left
      // out are removed — another app's included; read the task first to
      // keep them. null removes it.
      sourceRef?: Record<string, unknown> | null;
      // Custom-field values keyed by display name. flattenCustomFields
      // rewrites this into top-level body keys before send — that's Quire's
      // wire format. See https://quire.io/dev/api/ → Update task.
      customFields?: Record<string, unknown>;
    },
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(`/task/${taskOid}${qs}`, {
      method: "PUT",
      body: JSON.stringify(flattenCustomFields(body)),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  // Reparent a task within its project. Quire's PUT /task/move/{oid} takes
  // the target via `?task=<oid>` query string — passing a JSON body is
  // silently ignored and returns 400. Omit `parentOid` (or pass "root")
  // to move the task to the project root. Cross-project moves use the
  // separate /task/transfer endpoint (Phase 10.4).
  //
  // Apr 27 2026: optional `position` extends the move grammar with the
  // same `parent | before | after` vocabulary used by relative-create
  // (`POST /task/{siblingOid}?position=…`). With `before` / `after` the
  // task becomes a SIBLING of the reference (under its parent); without
  // `position` (or `position: "parent"`) the task becomes a CHILD —
  // matches the pre-Apr-27 behavior. `before` / `after` require a real
  // task in `parentOid` (not "root", not omitted). See TMP1–TMP4 in
  // tests/quire_api/task.test.ts.
  async moveTask<const Compact extends boolean = false>(
    taskOid: string,
    parentOid?: string,
    position?: "parent" | "before" | "after",
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const target = parentOid && parentOid.length > 0 ? parentOid : "root";
    const qs: string[] = [`task=${encodeURIComponent(target)}`];
    if (position) qs.push(`position=${position}`);
    if (options?.compact) qs.push("return=compact");
    return this.fetch(
      `/task/move/${taskOid}?${qs.join("&")}`,
      { method: "PUT" },
    ) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  // Cross-project move. All params are query-string, not body — see TT1 in
  // tests/quire_api/task.test.ts. `project` is required (target project OID
  // or ID, or "-" for the user's Inbox). Optional flags default to true on
  // the server; pass `false` to strip tags, status, custom fields, or the
  // auto-follow / auto-invite behavior on the destination side. The API's
  // query-string key is `custom-field` (with a hyphen), not camelCase.
  //
  // Apr 27 2026: optional `position` works the same as on /task/move —
  // `before` / `after` make the transferred task a sibling of `task=`
  // (under its parent in the target project). See TMP4 in
  // tests/quire_api/task.test.ts.
  //
  // Since Oct 30 2026, going over the target's task or storage limit, or
  // bringing reminders into a plan without them, is 402 with body `code`
  // 469, where it was 400; a caller who can't move the task gets 403 first.
  async transferTask<const Compact extends boolean = false>(
    taskOid: string,
    params: {
      project: string;
      task?: string;
      position?: "parent" | "before" | "after";
      invite?: boolean;
      tag?: boolean;
      status?: boolean;
      customField?: boolean;
      compact?: Compact;
    },
  ): Promise<Compact extends true ? QuireCompactRef : QuireTask> {
    const qs: string[] = [`project=${encodeURIComponent(params.project)}`];
    if (params.task !== undefined) qs.push(`task=${encodeURIComponent(params.task)}`);
    if (params.position) qs.push(`position=${params.position}`);
    if (params.invite !== undefined) qs.push(`invite=${params.invite ? "true" : "false"}`);
    if (params.tag !== undefined) qs.push(`tag=${params.tag ? "true" : "false"}`);
    if (params.status !== undefined) qs.push(`status=${params.status ? "true" : "false"}`);
    if (params.customField !== undefined) qs.push(`custom-field=${params.customField ? "true" : "false"}`);
    if (params.compact) qs.push("return=compact");
    return this.fetch(`/task/transfer/${taskOid}?${qs.join("&")}`, {
      method: "PUT",
    }) as Promise<Compact extends true ? QuireCompactRef : QuireTask>;
  }

  async completeTask(taskOid: string): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/${taskOid}`, {
      method: "PUT",
      body: JSON.stringify({ status: 100 }),
    });
  }

  // -----------------------------------------------------------------------
  // Bulk task endpoints (Apr 27 2026)
  //
  // All bulk endpoints share an atomic-with-skip-not-found contract:
  //   - Body is a top-level JSON array of 1..300 items, and no more than
  //     the plan's per-minute rate limit (Oct 16 2026): e.g. 50 on the
  //     Free plan, or 25 in a personal project on the Free plan. Over the
  //     plan's cap is `402` with body `code` `469`, like a quota, but
  //     upgrading isn't the only way out: split the batch. Over 300 is
  //     `400`. The client doesn't split; it can't know the plan.
  //   - Response is a same-length array. `bulk-update` / `bulk-remove`
  //     return null in any slot whose target task could not be found
  //     (already-removed, never existed, cascade-removed by an earlier
  //     item in the same batch); the rest of the batch proceeds.
  //   - Any per-item validation / permission / DB error rolls back the
  //     whole batch and returns `{code, message}` with `items[i]:`
  //     prefixed so the caller can pinpoint the offending row.
  //   - Per-item rate-limit cost: each call costs N units (= the number
  //     of submitted items; for `bulk-add`, every task created, nested
  //     `tasks` included); charged upfront before any item runs.
  //   - Optional `?return=compact` renders `{oid, id}` (or `null`) per
  //     slot — strongly recommended for large batches to keep the
  //     response payload small. Wired here as the default for
  //     destructive-but-quiet ops (remove, move) and as opt-in for ops
  //     where the caller may want to confirm the resulting record (add,
  //     update, transfer, approve).
  //   - Optional `?dry-run=true` (May 22 2026) runs the full operation
  //     inside a transaction and rolls back before responding. Validation,
  //     permission checks, and business rules still execute; the response
  //     matches the real call's shape so callers can preview what *would*
  //     happen. A successful dry-run signals that resubmitting without
  //     `dry-run` is likely to succeed (race conditions and quota
  //     consumption between calls are not pre-checked).
  //
  // See TBA1 / TBA2 / TBU1 / TBM1 / TBP1 / TBD1 in
  // tests/quire_api/task.test.ts. bulk-transfer relies on the existing
  // single-task transfer wire-shape coverage (TT1 + TMP4) — the cross-
  // project setup needed for a live bulk-transfer test isn't easy to
  // prepare per CLAUDE.md.
  // -----------------------------------------------------------------------

  // POST /task/bulk-add/{projectOid} — N root tasks. Items can include
  // nested `tasks` to create subtrees in the same call (only the root of
  // each item is echoed in the response). Since Oct 16 2026 each nested
  // task costs a rate-limit unit and counts toward the batch cap, so a
  // 10-item batch with 5 subtasks each is 60 tasks: over the Free plan's 50.
  async bulkCreateTasks(
    projectOid: string,
    items: Array<Record<string, unknown>>,
    options: { return?: "compact"; dryRun?: boolean } = {},
  ): Promise<Array<QuireTask>> {
    const params = new URLSearchParams();
    if (options.return) params.set("return", options.return);
    if (options.dryRun) params.set("dry-run", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.fetch<Array<QuireTask>>(
      `/task/bulk-add/${projectOid}${qs}`,
      { method: "POST", body: JSON.stringify(items) },
    );
  }

  // POST /task/bulk-add/{taskOid} — same endpoint, anchor is a task. The
  // server uses sliding-chain insert internally so submitted-order is
  // preserved regardless of `?position=`.
  async bulkCreateSubtasks(
    parentOid: string,
    items: Array<Record<string, unknown>>,
    options: {
      position?: "parent" | "before" | "after";
      return?: "compact";
      dryRun?: boolean;
    } = {},
  ): Promise<Array<QuireTask>> {
    const qs = new URLSearchParams();
    if (options.position) qs.set("position", options.position);
    if (options.return) qs.set("return", options.return);
    if (options.dryRun) qs.set("dry-run", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.fetch<Array<QuireTask>>(
      `/task/bulk-add/${parentOid}${suffix}`,
      { method: "POST", body: JSON.stringify(items) },
    );
  }

  // PUT /task/bulk-update/{projectOid} — body items each carry exactly
  // one of `oid` / `id` plus `UpdateTaskBody`-shape fields. Skip-not-found
  // returns null in the matching slot.
  async bulkUpdateTasks(
    projectOid: string,
    items: Array<Record<string, unknown>>,
    options: { return?: "compact"; dryRun?: boolean } = {},
  ): Promise<Array<QuireTask | null>> {
    const params = new URLSearchParams();
    if (options.return) params.set("return", options.return);
    if (options.dryRun) params.set("dry-run", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.fetch<Array<QuireTask | null>>(
      `/task/bulk-update/${projectOid}${qs}`,
      { method: "PUT", body: JSON.stringify(items) },
    );
  }

  // DELETE /task/bulk-remove/{projectOid} — body is an array of task
  // refs (OID, integer id, or `"#<id>"`). Skip-not-found returns null
  // in the matching slot. Defaults to ?return=compact since the caller
  // doesn't need full records on a delete.
  async bulkRemoveTasks(
    projectOid: string,
    refs: Array<string | number>,
    options: { return?: "compact" | "full"; dryRun?: boolean } = {},
  ): Promise<Array<{ oid: string; id?: number } | QuireTask | null>> {
    const ret = options.return ?? "compact";
    const params = new URLSearchParams();
    if (ret !== "full") params.set("return", ret);
    if (options.dryRun) params.set("dry-run", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(
      `/task/bulk-remove/${projectOid}${qs}`,
      { method: "DELETE", body: JSON.stringify(refs) },
    );
  }

  // PUT /task/bulk-move/{projectOid}?task=<ref>&position=… — refs is an
  // array of task references in the body. Defaults to ?return=compact.
  async bulkMoveTasks(
    projectOid: string,
    refs: Array<string | number>,
    options: {
      task: string | "root";
      position?: "parent" | "before" | "after";
      return?: "compact" | "full";
      dryRun?: boolean;
    },
  ): Promise<Array<{ oid: string; id?: number } | QuireTask>> {
    const ret = options.return ?? "compact";
    const qs = new URLSearchParams({ task: String(options.task) });
    if (options.position) qs.set("position", options.position);
    if (ret !== "full") qs.set("return", ret);
    if (options.dryRun) qs.set("dry-run", "true");
    return this.fetch(
      `/task/bulk-move/${projectOid}?${qs.toString()}`,
      { method: "PUT", body: JSON.stringify(refs) },
    );
  }

  // PUT /task/bulk-transfer/{sourceProjectOid}?project=<target>&… — same
  // per-aspect remap flags as single-task transfer; refs in the body.
  async bulkTransferTasks(
    sourceProjectOid: string,
    refs: Array<string | number>,
    options: {
      project: string;
      task?: string;
      position?: "parent" | "before" | "after";
      invite?: boolean;
      tag?: boolean;
      status?: boolean;
      customField?: boolean;
      return?: "compact" | "full";
      dryRun?: boolean;
    },
  ): Promise<Array<{ oid: string; id?: number } | QuireTask>> {
    const ret = options.return ?? "compact";
    const qs = new URLSearchParams({ project: options.project });
    if (options.task !== undefined) qs.set("task", options.task);
    if (options.position) qs.set("position", options.position);
    if (options.invite !== undefined) qs.set("invite", options.invite ? "true" : "false");
    if (options.tag !== undefined) qs.set("tag", options.tag ? "true" : "false");
    if (options.status !== undefined) qs.set("status", options.status ? "true" : "false");
    if (options.customField !== undefined) qs.set("custom-field", options.customField ? "true" : "false");
    if (ret !== "full") qs.set("return", ret);
    if (options.dryRun) qs.set("dry-run", "true");
    return this.fetch(
      `/task/bulk-transfer/${sourceProjectOid}?${qs.toString()}`,
      { method: "PUT", body: JSON.stringify(refs) },
    );
  }

  // POST /task/bulk-approve/{projectOid}?state=<state>&category=<cat> —
  // refs in the body. Reuses the single-task approve grammar (state token
  // selects `request` / `approve` / `reject` / `change`). Like
  // `approveTask` without a comment, `approve` / `reject` / `change` log a
  // header-only comment on each task, and `request` logs none; there is
  // no comment text to send.
  async bulkApproveTasks(
    projectOid: string,
    refs: Array<string | number>,
    options: {
      state: "request" | "approve" | "reject" | "change";
      /** The approval category's ID, not its name. Omitted, the project's default category (ID `""`). */
      category?: string;
      return?: "compact" | "full";
      dryRun?: boolean;
    },
  ): Promise<Array<{ oid: string; id?: number } | QuireApproval>> {
    const qs = new URLSearchParams({ state: options.state });
    if (options.category !== undefined) qs.set("category", options.category);
    if (options.return) qs.set("return", options.return);
    if (options.dryRun) qs.set("dry-run", "true");
    return this.fetch(
      `/task/bulk-approve/${projectOid}?${qs.toString()}`,
      { method: "POST", body: JSON.stringify(refs) },
    );
  }

  // -----------------------------------------------------------------------
  // Task time logs (Apr 27 2026)
  //
  // Three endpoints share the (user, start, end) identity triple. Sub-
  // second precision is truncated to whole seconds server-side; the
  // response always echoes `.000Z`-form timestamps. All three return the
  // task's full timelogs array (empty when no logs remain). See TL1–TL5
  // in tests/quire_api/task.test.ts.
  //
  // Since Oct 30 2026 a caller who can't see the project's time logs (a
  // guest, when the project hides them) gets `[]` back, as GET /task gives
  // them none; it used to be everyone's logs. A caller without permission
  // gets 403 before a 404 or 409 could tell whether a log exists.
  //
  // The wire form is `add-timelog` / `update-timelog` / `remove-timelog`
  // (with the `-timelog` suffix), not `add_timelog`. We expose the
  // by-OID URL form here; the by-id form is documented in the API but
  // routes through the same handler server-side.
  // -----------------------------------------------------------------------

  async addTaskTimelog(
    taskOid: string,
    body: {
      start: string;
      end: string;
      user?: string;
      billable?: boolean;
      note?: string;
    },
  ): Promise<QuireTimelog[]> {
    return this.fetch<QuireTimelog[]>(`/task/add-timelog/${taskOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Update an existing log identified by (user, start, end). The query
  // params name the target; the body carries the new values. Omitted (or
  // null) body fields preserve existing values; an empty string for
  // `note` clears it. 404 on no-match.
  async updateTaskTimelog(
    taskOid: string,
    target: { start: string; end: string; user?: string },
    body: {
      start?: string;
      end?: string;
      user?: string;
      billable?: boolean | null;
      note?: string | null;
    },
  ): Promise<QuireTimelog[]> {
    const qs = new URLSearchParams({
      start: target.start,
      end: target.end,
    });
    if (target.user !== undefined) qs.set("user", target.user);
    return this.fetch<QuireTimelog[]>(
      `/task/update-timelog/${taskOid}?${qs.toString()}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async removeTaskTimelog(
    taskOid: string,
    target: { start: string; end: string; user?: string },
  ): Promise<QuireTimelog[]> {
    const qs = new URLSearchParams({
      start: target.start,
      end: target.end,
    });
    if (target.user !== undefined) qs.set("user", target.user);
    return this.fetch<QuireTimelog[]>(
      `/task/remove-timelog/${taskOid}?${qs.toString()}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // Tasks (continued) — delete, attachments, undo
  // -----------------------------------------------------------------------

  async deleteTask(taskOid: string): Promise<void> {
    await this.fetch<void>(`/task/${taskOid}`, { method: "DELETE" });
  }

  // POST /task/attach/{taskOid}/{filename} — raw bytes in the request body,
  // not multipart, not JSON. The server forwards Content-Type to S3 and uses
  // Content-Length for quota gating; both are derived from the Uint8Array
  // by the runtime. Filename in the URL is path-segment-encoded, and the
  // server decodes it (since Oct 23 2026; before, `My Report.md` was saved
  // as `My%20Report.md`). It rejects names containing `/` or `\`. Verified
  // by A1/A2 in
  // tests/quire_api/attachment.test.ts. Server response is the freshly-
  // attached entry — its `url` is absolute on this endpoint.
  async attachTaskFile(
    taskOid: string,
    filename: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<QuireAttachment> {
    return this.fetch<QuireAttachment>(
      `/task/attach/${taskOid}/${encodeURIComponent(filename)}`,
      {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": contentType },
      },
    );
  }

  // POST /comment/attach/{commentOid}/{filename} — same wire as task-attach
  // (raw bytes, filename in URL, server forwards Content-Type to S3) just
  // rooted at /comment instead of /task. Works for both task-comments and
  // chat-comments — comments are the same entity regardless of host. The
  // byId form is explicitly rejected by the server (comment_api.dart:93),
  // so this method is OID-only. Verified by A3/A4 in
  // tests/quire_api/attachment.test.ts.
  async attachCommentFile(
    commentOid: string,
    filename: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<QuireAttachment> {
    return this.fetch<QuireAttachment>(
      `/comment/attach/${commentOid}/${encodeURIComponent(filename)}`,
      {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": contentType },
      },
    );
  }

  // Undo-remove is idempotent and restores the previously-deleted task
  // (including subtasks — verified by T17c in tests/quire_api/task.test.ts).
  // Counts against the per-plan task limit: beyond it, 402 with body `code`
  // 469 since Oct 30 2026, where it was 200 with the task still removed.
  async undoRemoveTask(taskOid: string): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/undo-remove/${taskOid}`, {
      method: "PUT",
    });
  }

  // -----------------------------------------------------------------------
  // Task approval workflow — Apr 24 2026 (contract refined Apr 27 2026)
  //
  // POST /task/approve handles every state transition — the `state` query
  // param selects the action (`request`, `approve`, `reject`, `change`).
  // Apr 27 moved state/category from the request body to the query string
  // so the grammar matches the bulk-approve endpoint. `approve` / `reject` /
  // `change` log a comment on the task holding a plain `<category>:
  // <status>` header line, as the apps do; `request` logs none. May 27
  // 2026 reused the request body for an optional companion comment: its
  // `description` follows the header after a blank line, and with it
  // `request` logs a comment too. Don't parse the header: the category
  // name is left out for the default category, and the status is in the
  // authorizing user's language (`Approved` in English) (TA7, TA8). The
  // approval response shape is unchanged — fetch the created comment via
  // `/comment/list/{taskOid}` if needed.
  // Response is the Approval object only (not the full task). DELETE
  // /task/revoke-approval returns 204 with no body in all three cases:
  // rolling back approved/rejected → awaiting, clearing awaiting/changes
  // → no-approval, and idempotent no-op on a task with no active
  // approval. See TA1–TA6 in tests/quire_api/task.test.ts.
  // -----------------------------------------------------------------------

  // `?return=compact` here returns `{oid, id}` of the **task** (not the
  // approval) — the server uses this shape to short-circuit the post-write
  // approval reload + render. Verified against approval_api.dart: compact
  // path returns `compactResponse(oidTask, task.id)`.
  async approveTask<const Compact extends boolean = false>(
    taskOid: string,
    body: {
      state: "request" | "approve" | "reject" | "change";
      /** The approval category's ID, not its name. Omitted, the project's default category (ID `""`). */
      category?: string;
      compact?: Compact;
      /**
       * Optional text for the comment the approval logs on the task (May 27
       * 2026). `description` is required when supplied; the server puts a
       * plain `<category>: <status>` header line and a blank line before it.
       * The header's wording follows the authorizing user's language, so
       * don't parse it. Without `comment`, `approve` / `reject` / `change`
       * still log a header-only comment and `request` logs none. The
       * created comment is not part of the approval response — fetch it
       * via `getTaskComments` afterward. `asUser: true` posts it as the app
       * (since the Oct 19 2026 server release); the approval stays the
       * user's (TA9).
       */
      comment?: {
        description: string;
        pinned?: boolean;
        asUser?: boolean;
      };
    },
  ): Promise<Compact extends true ? QuireCompactRef : QuireApproval> {
    const qs = new URLSearchParams({ state: body.state });
    if (body.category !== undefined) qs.set("category", body.category);
    if (body.compact) qs.set("return", "compact");
    return this.fetch(
      `/task/approve/${taskOid}?${qs.toString()}`,
      {
        method: "POST",
        ...(body.comment ? { body: JSON.stringify(body.comment) } : {}),
      },
    ) as Promise<Compact extends true ? QuireCompactRef : QuireApproval>;
  }

  async revokeTaskApproval(taskOid: string): Promise<void> {
    await this.fetch<void>(`/task/revoke-approval/${taskOid}`, {
      method: "DELETE",
    });
  }

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  async listTags(projectOid: string): Promise<QuireTag[]> {
    return this.fetch<QuireTag[]>(`/tag/list/${projectOid}`);
  }

  async getTag(tagOid: string): Promise<QuireTag> {
    return this.fetch<QuireTag>(`/tag/${tagOid}`);
  }

  async updateTag(
    tagOid: string,
    body: { name?: string; color?: string },
  ): Promise<QuireTag> {
    return this.fetch<QuireTag>(`/tag/${tagOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async createTag(
    projectOid: string,
    body: { name: string; color?: string },
  ): Promise<QuireTag> {
    return this.fetch<QuireTag>(`/tag/${projectOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async deleteTag(tagOid: string): Promise<void> {
    await this.fetch<void>(`/tag/${tagOid}`, { method: "DELETE" });
  }

  // -----------------------------------------------------------------------
  // Sublists
  // -----------------------------------------------------------------------

  async listSublists(
    ownerType: string,
    ownerOid: string,
  ): Promise<QuireSublist[]> {
    return this.fetch<QuireSublist[]>(`/sublist/list/${ownerType}/${ownerOid}`);
  }

  async getSublist(sublistOid: string): Promise<QuireSublist> {
    return this.fetch<QuireSublist>(`/sublist/${sublistOid}`);
  }

  async createSublist(
    ownerType: string,
    ownerOid: string,
    body: {
      name: string;
      description?: string;
      // Dates only, e.g. `2026-11-02`; a time of day is 400.
      start?: string;
      due?: string;
      // Task OIDs to put in the new sublist; each brings all its
      // descendants along. Change membership later with
      // updateSublistMembership.
      includes?: string[];
      // `true` puts every task of the owner in the sublist; leave tasks out
      // afterwards with updateSublistMembership's `exclude`. Default false:
      // only the `includes`. Can't be changed after creation.
      all?: boolean;
      // Who can see this record (Sep 21 2026). Omit or pass null for every
      // member of the owner; `[]` for the owner's admins only; a list of
      // users (OID, ID, email, or `"me"`) for just those. Every listed user
      // must be a member of the owner AND the list must include you —
      // otherwise `400`, rather than the silent drop `assignees` does.
      // Cannot be combined with `partner` (`400`). Create-only: there is no
      // way to change it afterwards.
      members?: string[];
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireSublist> {
    return this.fetch<QuireSublist>(`/sublist/${ownerType}/${ownerOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateSublist(
    sublistOid: string,
    body: {
      name?: string;
      description?: string;
      // Dates only, e.g. `2026-11-02`; a time of day is 400.
      start?: string;
      due?: string;
      archived?: boolean;
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireSublist> {
    return this.fetch<QuireSublist>(`/sublist/${sublistOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteSublist(sublistOid: string): Promise<void> {
    await this.fetch<void>(`/sublist/${sublistOid}`, { method: "DELETE" });
  }

  async undoRemoveSublist(sublistOid: string): Promise<QuireSublist> {
    return this.fetch<QuireSublist>(`/sublist/undo-remove/${sublistOid}`, {
      method: "PUT",
    });
  }

  // Add or remove tasks from a sublist. Each change is
  // `{ task, exclude?, single? }`, applied in order: omitting `exclude` (or
  // `false`) adds the task; `exclude: true` removes it. By default the
  // task's descendants follow it, and earlier changes to them are cleared;
  // `single: true` changes the task alone. A task that doesn't exist, isn't
  // under the sublist's owner, or isn't shared with the sublist's external
  // team is skipped. This is the only path for sublist
  // membership — `/task/move` only reparents within the task tree and
  // returns a generic 400 when handed a sublist OID. See:
  //   boeneo/server/lib/src/api/sublist_api.dart
  async updateSublistMembership(
    sublistOid: string,
    changes: { task: string; exclude?: boolean; single?: boolean }[],
  ): Promise<QuireSublist> {
    return this.fetch<QuireSublist>(`/sublist/${sublistOid}`, {
      method: "PUT",
      body: JSON.stringify({ changes }),
    });
  }

  // -----------------------------------------------------------------------
  // Comments
  // -----------------------------------------------------------------------

  async getTaskComments(taskOid: string): Promise<QuireComment[]> {
    return this.fetch<QuireComment[]>(`/comment/list/${taskOid}`);
  }

  async getComment(commentOid: string): Promise<QuireComment> {
    return this.fetch<QuireComment>(`/comment/${commentOid}`);
  }

  // `pinned` pins the comment as it is created. `asUser: true` posts it as
  // the app instead of the authorizing user — `createdBy` is then the app,
  // whose `id` is `ap|<app ID>`.
  async addComment<const Compact extends boolean = false>(
    taskOid: string,
    text: string,
    options?: { compact?: Compact; pinned?: boolean; asUser?: boolean },
  ): Promise<Compact extends true ? QuireCompactRef : QuireComment> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(`/comment/${taskOid}${qs}`, {
      method: "POST",
      body: JSON.stringify({
        description: text,
        pinned: options?.pinned,
        asUser: options?.asUser,
      }),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireComment>;
  }

  async addChatComment<const Compact extends boolean = false>(
    chatOid: string,
    body: {
      description: string;
      pinned?: boolean;
      asUser?: boolean;
      compact?: Compact;
    },
  ): Promise<Compact extends true ? QuireCompactRef : QuireComment> {
    const { compact, ...wire } = body;
    const qs = compact ? "?return=compact" : "";
    return this.fetch(`/comment/chat/${chatOid}${qs}`, {
      method: "POST",
      body: JSON.stringify(wire),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireComment>;
  }

  // `asUser: true` records the app, not the authorizing user, as the one
  // who made the change: `editedBy` when `description` changes, `pinBy`
  // when the comment is pinned.
  async updateComment<const Compact extends boolean = false>(
    commentOid: string,
    body: {
      description?: string;
      pinned?: boolean;
      asUser?: boolean;
      compact?: Compact;
    },
  ): Promise<Compact extends true ? QuireCompactRef : QuireComment> {
    const { compact, ...wire } = body;
    const qs = compact ? "?return=compact" : "";
    return this.fetch(`/comment/${commentOid}${qs}`, {
      method: "PUT",
      body: JSON.stringify(wire),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireComment>;
  }

  async deleteComment(commentOid: string): Promise<void> {
    await this.fetch<void>(`/comment/${commentOid}`, { method: "DELETE" });
  }

  // Comment undo-remove is the only variant NOT subject to a per-type
  // creation quota per the Apr 22 2026 changelog.
  async undoRemoveComment(commentOid: string): Promise<QuireComment> {
    return this.fetch<QuireComment>(`/comment/undo-remove/${commentOid}`, {
      method: "PUT",
    });
  }

  // Emoji reactions (Oct 15 2026). The emojis ride in the URL path as one
  // comma list, each the emoji itself or its GitHub / Slack shortcode (`+1`,
  // `:tada:`, any case). Both are all-or-nothing (one bad emoji → 400,
  // nothing written), take at most 20 distinct emojis, act for the
  // authorizing user only, and return 204 — read the comment for the result.
  // Add accepts only the 20 emojis Quire's reaction picker offers; remove
  // accepts any non-empty value so a legacy reaction can still go. No
  // client-side validation beyond an empty list: the server's 400 names the
  // emoji it rejected. Verified by CE1-CE16 in
  // tests/live/comment-emoji.live.test.ts.
  async addCommentEmojis(
    commentOid: string,
    emojis: readonly string[],
  ): Promise<void> {
    const emojiList = encodeCommentEmojis("addCommentEmojis", emojis);
    await this.fetch<void>(`/comment/add-emoji/${commentOid}/${emojiList}`, {
      method: "POST",
    });
  }

  // Unlike add, a missing or deleted comment is a 204 no-op rather than a
  // 404 — the same as every DELETE (CE11 / CE12).
  async removeCommentEmojis(
    commentOid: string,
    emojis: readonly string[],
  ): Promise<void> {
    const emojiList = encodeCommentEmojis("removeCommentEmojis", emojis);
    await this.fetch<void>(`/comment/remove-emoji/${commentOid}/${emojiList}`, {
      method: "DELETE",
    });
  }

  // -----------------------------------------------------------------------
  // Statuses
  //
  // Quire exposes both OID and id-based variants for every status endpoint
  // (`/status/list/{oid}` vs `/status/list/id/{projectId}`, etc.). Accepting
  // a slug directly here — instead of going through resolveProjectOid — saves
  // a round-trip on the id-shape branch. Verified by S7 and S8 in
  // tests/quire_api/status.test.ts.
  // -----------------------------------------------------------------------

  async listStatuses(projectIdOrOid: string): Promise<QuireStatus[]> {
    const path = looksLikeOid(projectIdOrOid)
      ? `/status/list/${projectIdOrOid}`
      : `/status/list/id/${encodeURIComponent(projectIdOrOid)}`;
    return this.fetch<QuireStatus[]>(path);
  }

  async getStatus(projectIdOrOid: string, value: number): Promise<QuireStatus> {
    const path = looksLikeOid(projectIdOrOid)
      ? `/status/${projectIdOrOid}/${value}`
      : `/status/id/${encodeURIComponent(projectIdOrOid)}/${value}`;
    return this.fetch<QuireStatus>(path);
  }

  // A `value` already in use is 409 since Oct 30 2026, on create and on
  // update: create used to be 400, and update 200 with nothing changed.
  // The value of `0` (the initial status) and `100` (completed) can't
  // change.
  async createStatus(
    projectIdOrOid: string,
    body: { name: string; color: string; value: number },
  ): Promise<QuireStatus> {
    const path = looksLikeOid(projectIdOrOid)
      ? `/status/${projectIdOrOid}`
      : `/status/id/${encodeURIComponent(projectIdOrOid)}`;
    return this.fetch<QuireStatus>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateStatus(
    projectIdOrOid: string,
    value: number,
    body: { name?: string; color?: string; value?: number },
  ): Promise<QuireStatus> {
    const path = looksLikeOid(projectIdOrOid)
      ? `/status/${projectIdOrOid}/${value}`
      : `/status/id/${encodeURIComponent(projectIdOrOid)}/${value}`;
    return this.fetch<QuireStatus>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteStatus(projectIdOrOid: string, value: number): Promise<void> {
    const path = looksLikeOid(projectIdOrOid)
      ? `/status/${projectIdOrOid}/${value}`
      : `/status/id/${encodeURIComponent(projectIdOrOid)}/${value}`;
    await this.fetch<void>(path, { method: "DELETE" });
  }

  // -----------------------------------------------------------------------
  // Partners (external teams)
  // -----------------------------------------------------------------------

  async listPartners(projectOid: string): Promise<QuirePartner[]> {
    return this.fetch<QuirePartner[]>(`/partner/list/${projectOid}`);
  }

  async getPartner(partnerOid: string): Promise<QuirePartner> {
    return this.fetch<QuirePartner>(`/partner/${partnerOid}`);
  }

  // -----------------------------------------------------------------------
  // Documents
  // -----------------------------------------------------------------------

  async listDocuments(ownerType: string, ownerOid: string): Promise<QuireDocument[]> {
    return this.fetch<QuireDocument[]>(`/doc/list/${ownerType}/${ownerOid}`);
  }

  async getDocument(docOid: string): Promise<QuireDocument> {
    return this.fetch<QuireDocument>(`/doc/${docOid}`);
  }

  async getDocumentByProjectAndId(
    projectId: string,
    docId: string,
  ): Promise<QuireDocument> {
    return this.fetch<QuireDocument>(
      `/doc/id/project/${encodeURIComponent(projectId)}/${encodeURIComponent(docId)}`,
    );
  }

  async createDocument(
    ownerType: string,
    ownerOid: string,
    body: {
      name: string;
      description?: string;
      // Jun 4 2026 — only valid when the owner is a project; other owner
      // types return 400. Same value grammar as createChat's `followers`.
      // Only these users, plus anyone @mentioned in `description`, follow
      // the new doc; pass `"me"` to follow it (Oct 29 2026).
      followers?: string[];
      // Who can see this record (Sep 21 2026). Omit or pass null for every
      // member of the owner; `[]` for the owner's admins only; a list of
      // users (OID, ID, email, or `"me"`) for just those. Every listed user
      // must be a member of the owner AND the list must include you —
      // otherwise `400`, rather than the silent drop `assignees` does.
      // Cannot be combined with `partner` (`400`). Create-only: there is no
      // way to change it afterwards.
      members?: string[];
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireDocument> {
    return this.fetch<QuireDocument>(`/doc/${ownerType}/${ownerOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateDocument(
    docOid: string,
    body: {
      name?: string;
      description?: string;
      archived?: boolean;
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
      // Jun 4 2026 — only valid on project-owned documents (400 otherwise).
      // `followers` replaces the whole list; the delta forms add/remove.
      // Same read-access rule as updateTask's (Oct 30 2026).
      followers?: string[];
      addFollowers?: string[];
      removeFollowers?: string[];
    },
  ): Promise<QuireDocument> {
    return this.fetch<QuireDocument>(`/doc/${docOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteDocument(docOid: string): Promise<void> {
    await this.fetch<void>(`/doc/${docOid}`, { method: "DELETE" });
  }

  async undoRemoveDocument(docOid: string): Promise<QuireDocument> {
    return this.fetch<QuireDocument>(`/doc/undo-remove/${docOid}`, {
      method: "PUT",
    });
  }

  // -----------------------------------------------------------------------
  // Chats
  // -----------------------------------------------------------------------

  async listChats(ownerType: string, ownerOid: string): Promise<QuireChat[]> {
    return this.fetch<QuireChat[]>(`/chat/list/${ownerType}/${ownerOid}`);
  }

  async getChat(chatOid: string): Promise<QuireChat> {
    return this.fetch<QuireChat>(`/chat/${chatOid}`);
  }

  async createChat(
    ownerType: string,
    ownerOid: string,
    body: {
      name: string;
      description?: string;
      partner?: string;
      // Jun 4 2026 — user OID, ID, or email; also `"me"` / `"app"` (with the
      // `app|team` / `app|/path` syntaxes). Only these users follow the new
      // chat; since Oct 29 2026 the current user isn't added, so pass `"me"`
      // to follow it.
      followers?: string[];
      // Who can see this record (Sep 21 2026). Omit or pass null for every
      // member of the owner; `[]` for the owner's admins only; a list of
      // users (OID, ID, email, or `"me"`) for just those. Every listed user
      // must be a member of the owner AND the list must include you —
      // otherwise `400`, rather than the silent drop `assignees` does.
      // Cannot be combined with `partner` (`400`). Create-only: there is no
      // way to change it afterwards.
      members?: string[];
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireChat> {
    return this.fetch<QuireChat>(`/chat/${ownerType}/${ownerOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getChatByProjectAndId(
    projectId: string,
    chatId: string,
  ): Promise<QuireChat> {
    return this.fetch<QuireChat>(
      `/chat/id/project/${encodeURIComponent(projectId)}/${encodeURIComponent(chatId)}`,
    );
  }

  async updateChat(
    chatOid: string,
    body: {
      name?: string;
      description?: string;
      archived?: boolean;
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
      // `followers` replaces the whole list (Jun 4 2026); the delta forms
      // add/remove without touching the rest. Same read-access rule as
      // updateTask's (Oct 30 2026).
      followers?: string[];
      addFollowers?: string[];
      removeFollowers?: string[];
    },
  ): Promise<QuireChat> {
    return this.fetch<QuireChat>(`/chat/${chatOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async listChatComments(chatOid: string): Promise<QuireComment[]> {
    return this.fetch<QuireComment[]>(`/comment/list/chat/${chatOid}`);
  }

  async deleteChat(chatOid: string): Promise<void> {
    await this.fetch<void>(`/chat/${chatOid}`, { method: "DELETE" });
  }

  async undoRemoveChat(chatOid: string): Promise<QuireChat> {
    return this.fetch<QuireChat>(`/chat/undo-remove/${chatOid}`, {
      method: "PUT",
    });
  }

  // -----------------------------------------------------------------------
  // Insight views — Apr 22 2026
  //
  // Mirrors the Sublist / Doc / Chat shape: owned by a project,
  // organization, folder or smart folder. When the owner type is left out
  // of the URL it is `project` — the server does NOT route an organization
  // OID there by entity type (`/insight/list/{orgOid}` is 404).
  // -----------------------------------------------------------------------

  // One argument is a project OID, as before; pass the owner type first to
  // list another owner's.
  listInsights(projectOid: string): Promise<QuireInsight[]>;
  listInsights(
    ownerType: QuireInsightOwnerType,
    ownerOid: string,
  ): Promise<QuireInsight[]>;
  async listInsights(
    ownerTypeOrOid: string,
    ownerOid?: string,
  ): Promise<QuireInsight[]> {
    if (ownerOid === undefined) {
      const projectOid = ownerTypeOrOid;
      return this.fetch<QuireInsight[]>(`/insight/list/${projectOid}`);
    }
    const ownerType = ownerTypeOrOid;
    return this.fetch<QuireInsight[]>(`/insight/list/${ownerType}/${ownerOid}`);
  }

  async getInsight(insightOid: string): Promise<QuireInsight> {
    return this.fetch<QuireInsight>(`/insight/${insightOid}`);
  }

  async createInsight(
    ownerType: QuireInsightOwnerType,
    ownerOid: string,
    body: {
      name: string;
      description?: string;
      image?: string;
      iconColor?: string;
      id?: string;
      // OID of an external team to share this insight with.
      partner?: string;
      // Who can see this record (Sep 21 2026). Omit or pass null for every
      // member of the owner; `[]` for the owner's admins only; a list of
      // users (OID, ID, email, or `"me"`) for just those. Every listed user
      // must be a member of the owner AND the list must include you —
      // otherwise `400`, rather than the silent drop `assignees` does.
      // Cannot be combined with `partner` (`400`). Create-only: there is no
      // way to change it afterwards.
      members?: string[];
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireInsight> {
    return this.fetch<QuireInsight>(`/insight/${ownerType}/${ownerOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateInsight(
    insightOid: string,
    body: {
      name?: string;
      description?: string;
      image?: string;
      iconColor?: string;
      archived?: boolean;
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireInsight> {
    return this.fetch<QuireInsight>(`/insight/${insightOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteInsight(insightOid: string): Promise<void> {
    await this.fetch<void>(`/insight/${insightOid}`, { method: "DELETE" });
  }

  // Counts against the insight creation quota per the Apr 22 2026
  // changelog; may return 469 ecQuotaExceeded.
  async undoRemoveInsight(insightOid: string): Promise<QuireInsight> {
    return this.fetch<QuireInsight>(`/insight/undo-remove/${insightOid}`, {
      method: "PUT",
    });
  }

  // GET /insight/run/{insightOid} (May 27 2026) — runs the insight and
  // returns the aggregated result as a JSON 2D array: row 0 is headers,
  // subsequent rows are one aggregated row per group. Project-scoped
  // insights only; org-scoped insights return 400. Rate-limit: standard
  // 1-unit grantLoad + soft post-charge of `ceil(tasksLoaded / 250) - 1`
  // for very large result sets.
  async runInsight(
    insightOid: string,
    options?: { groupBy?: "member" | "section"; status?: "active" | "completed" | "all" },
  ): Promise<unknown[][]> {
    const qs = new URLSearchParams();
    if (options?.groupBy !== undefined) qs.set("group-by", options.groupBy);
    if (options?.status !== undefined) qs.set("status", options.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.fetch<unknown[][]>(`/insight/run/${insightOid}${suffix}`);
  }

  // -----------------------------------------------------------------------
  // Insight custom-field definitions — Apr 22 2026
  //
  // 1:1 mirror of the project-field surface above. Insights accept only
  // `formula` and `lookup` types — project-only types like `number`,
  // `money`, `date`, `text` return 400 (verified against the canonical Dart
  // test suite at ../boeneo/web/test/api/insight_test.dart).
  // -----------------------------------------------------------------------

  async addInsightField(
    insightOid: string,
    body: { name: string; type: string; [key: string]: unknown } & QuireFieldAccess,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(`/insight/add-field/${insightOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateInsightField(
    insightOid: string,
    fieldName: string,
    body: QuireFieldAccess & Record<string, unknown>,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/insight/update-field/${insightOid}${fieldNameQuery(fieldName)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async renameInsightField(
    insightOid: string,
    fieldName: string,
    newName: string,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/insight/rename-field/${insightOid}${fieldNameQuery(fieldName, { "new-name": newName })}`,
      { method: "PUT" },
    );
  }

  async moveInsightField(
    insightOid: string,
    fieldName: string,
    before?: string | null,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/insight/move-field/${insightOid}${fieldNameQuery(fieldName, before ? { before } : {})}`,
      { method: "PUT" },
    );
  }

  async removeInsightField(
    insightOid: string,
    fieldName: string,
  ): Promise<void> {
    await this.fetch<void>(
      `/insight/remove-field/${insightOid}${fieldNameQuery(fieldName)}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // Dashboards — Jul 20 2026
  //
  // Widget collections owned by a project, organization, folder, or
  // smart-folder. The API manages the dashboard container only (name,
  // description, icon, archive state) — widget definitions are not part of
  // the public API yet. Create / undo-remove count against a per-owner
  // quota and return 402 when the plan limit is reached.
  // -----------------------------------------------------------------------

  async listDashboards(
    ownerType: QuireDashboardOwnerType,
    ownerOid: string,
  ): Promise<QuireDashboard[]> {
    return this.fetch<QuireDashboard[]>(
      `/dashboard/list/${ownerType}/${ownerOid}`,
    );
  }

  async getDashboard(dashboardOid: string): Promise<QuireDashboard> {
    return this.fetch<QuireDashboard>(`/dashboard/${dashboardOid}`);
  }

  // By-ID form: owner ID (e.g. project slug) + dashboard ID.
  async getDashboardById(
    ownerType: QuireDashboardOwnerType,
    ownerId: string,
    dashboardId: string,
  ): Promise<QuireDashboard> {
    return this.fetch<QuireDashboard>(
      `/dashboard/id/${ownerType}/${encodeURIComponent(ownerId)}/${encodeURIComponent(dashboardId)}`,
    );
  }

  async createDashboard(
    ownerType: QuireDashboardOwnerType,
    ownerOid: string,
    body: {
      name: string;
      id?: string;
      description?: string;
      iconColor?: string;
      image?: string;
      partner?: string;
      // Who can see this record (Sep 21 2026). Omit or pass null for every
      // member of the owner; `[]` for the owner's admins only; a list of
      // users (OID, ID, email, or `"me"`) for just those. Every listed user
      // must be a member of the owner AND the list must include you —
      // otherwise `400`, rather than the silent drop `assignees` does.
      // Cannot be combined with `partner` (`400`). Create-only: there is no
      // way to change it afterwards.
      members?: string[];
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireDashboard> {
    return this.fetch<QuireDashboard>(`/dashboard/${ownerType}/${ownerOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Set `archived: true` / `false` to archive or unarchive. A dashboard has
  // no `start` / `due` — only a sublist does — and sending either is 400.
  async updateDashboard(
    dashboardOid: string,
    body: {
      id?: string;
      name?: string;
      description?: string;
      iconColor?: string;
      image?: string;
      archived?: boolean;
      // Hide this record from guests and from the visitors of a public
      // project or of a share link (Oct 15 2026). A choice only while
      // `members` and `partner` are both null (default false); with either
      // set it is always hidden, so `false` is `400` and `true` a no-op.
      private?: boolean;
    },
  ): Promise<QuireDashboard> {
    return this.fetch<QuireDashboard>(`/dashboard/${dashboardOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteDashboard(dashboardOid: string): Promise<void> {
    await this.fetch<void>(`/dashboard/${dashboardOid}`, { method: "DELETE" });
  }

  // Idempotent; subject to the same per-owner quota as create (402 when
  // the plan limit is reached).
  async undoRemoveDashboard(dashboardOid: string): Promise<QuireDashboard> {
    return this.fetch<QuireDashboard>(
      `/dashboard/undo-remove/${dashboardOid}`,
      { method: "PUT" },
    );
  }

  // -----------------------------------------------------------------------
  // Notifications
  //
  // POST /notification fires an in-app notification. Without `recipients`,
  // the message goes to the *current* user (the one whose access token is
  // making the call). With `recipients`, the message fans out to colleagues
  // visible to the app — each entry is a user OID, ID, or email matching
  // `GET /user/list`. Special value `["*"]` (sole entry) broadcasts to every
  // visible user; mixing `*` with other entries returns 400. Unknown or
  // invisible recipients return 404 with an identical response for every
  // case (the endpoint cannot be used to probe user existence). Rate-limit
  // cost: every 10 delivered recipients counts as 1 unit (rounded up,
  // minimum 1) — over-budget calls return 429 with no partial delivery.
  // Requires the `share` scope (`arNotification` server-side); calls
  // without it return 403. No response body.
  //
  // `url`: a `javascript:` URL is 400 (Oct 30 2026). Without a scheme, such
  // as `example.com/sync`, `https://` is assumed; a path starting with `/`
  // points into Quire.
  // -----------------------------------------------------------------------

  async sendNotification(body: {
    message: string;
    url?: string;
    recipients?: string[];
  }): Promise<void> {
    await this.fetch<void>(`/notification`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // -----------------------------------------------------------------------
  // Reminders (Sep 21 2026)
  //
  // A reminder notifies the people it names, either before a task's start
  // or due date or at a time of its own.
  //
  // `ownerType` is ALWAYS required — unlike sublist / doc / chat / insight /
  // dashboard, these endpoints have no implied `project`. Pass `"project"`
  // with an ownerOid of `"-"` for the caller's own inbox (a personal
  // reminder, visible to nobody else).
  //
  // What a reminder fires from depends on its task:
  //   - task WITH a start or due date → it fires from that date. Send
  //     `leads` alone; `when` / `recurrence` are rejected with 400 because
  //     they would be ignored.
  //   - no task, or a task with neither date → `when` is required.
  //
  // A task the caller can't see (an external-team member's view of a task
  // not shared with their team) is 404 on create and list, the same as a
  // missing task (Oct 30 2026); it used to be created or listed, with the
  // task's name.
  //
  // Delete is permanent: a reminder is not moved to the trash and cannot be
  // restored, so there is no undoRemoveReminder.
  // -----------------------------------------------------------------------

  async createReminder<const Compact extends boolean = false>(
    ownerType: QuireReminderOwnerType,
    ownerOid: string,
    body: QuireCreateReminderBody,
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireReminder> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(`/reminder/${ownerType}/${ownerOid}${qs}`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as Promise<Compact extends true ? QuireCompactRef : QuireReminder>;
  }

  // ID-form create. For a task use createTaskReminderById instead — a task
  // ID is unique only within its project, so it needs both segments.
  async createReminderById<const Compact extends boolean = false>(
    ownerType: Exclude<QuireReminderOwnerType, "task">,
    ownerId: string,
    body: QuireCreateReminderBody,
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireReminder> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(
      `/reminder/id/${ownerType}/${encodeURIComponent(ownerId)}${qs}`,
      { method: "POST", body: JSON.stringify(body) },
    ) as Promise<Compact extends true ? QuireCompactRef : QuireReminder>;
  }

  async createTaskReminderById<const Compact extends boolean = false>(
    projectId: string,
    taskId: string,
    body: QuireCreateReminderBody,
    options?: { compact?: Compact },
  ): Promise<Compact extends true ? QuireCompactRef : QuireReminder> {
    const qs = options?.compact ? "?return=compact" : "";
    return this.fetch(
      `/reminder/id/task/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}${qs}`,
      { method: "POST", body: JSON.stringify(body) },
    ) as Promise<Compact extends true ? QuireCompactRef : QuireReminder>;
  }

  async getReminder(reminderOid: string): Promise<QuireReminder> {
    return this.fetch<QuireReminder>(`/reminder/${reminderOid}`);
  }

  // A project's list includes the reminders on its tasks, not just the
  // standalone ones — pass ownerType `"task"` with a task OID to narrow it
  // to one task's. Reminders on a trashed task are left out (they come back
  // if it is restored, and stay reachable by OID meanwhile).
  //
  // Ordered by `oid`: stable, but NOT chronological — sort client-side on
  // the field you care about. `timing` / `status` filter server-side; see
  // `QuireReminderListOptions`.
  async listReminders(
    ownerType: QuireReminderOwnerType,
    ownerOid: string,
    options: QuireReminderListOptions = {},
  ): Promise<QuireReminder[]> {
    const qs = reminderListQuery(options);
    return this.fetch<QuireReminder[]>(
      `/reminder/list/${ownerType}/${ownerOid}${qs}`,
    );
  }

  async listRemindersById(
    ownerType: Exclude<QuireReminderOwnerType, "task">,
    ownerId: string,
    options: QuireReminderListOptions = {},
  ): Promise<QuireReminder[]> {
    const qs = reminderListQuery(options);
    return this.fetch<QuireReminder[]>(
      `/reminder/list/id/${ownerType}/${encodeURIComponent(ownerId)}${qs}`,
    );
  }

  async listTaskRemindersById(
    projectId: string,
    taskId: string,
    options: QuireReminderListOptions = {},
  ): Promise<QuireReminder[]> {
    const qs = reminderListQuery(options);
    return this.fetch<QuireReminder[]>(
      `/reminder/list/id/task/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}${qs}`,
    );
  }

  // Only `when`, `recurrence`, `leads` and `name` can be changed. `members`
  // and `partner` are create-only — recreate the reminder to change who can
  // see it.
  async updateReminder(
    reminderOid: string,
    body: {
      // Rejected with 400 on a reminder whose task has a start or due date
      // (it fires from the task's schedule), and when set to null on one
      // that has no other time to fire from.
      when?: string | null;
      // Pass null to stop it repeating. Same 400 rule as `when`.
      recurrence?: QuireRecurrence | null;
      // Replaces the current list.
      leads?: QuireReminderLead[];
      // Pass null to fall back to the default message.
      name?: string | null;
    },
  ): Promise<QuireReminder> {
    return this.fetch<QuireReminder>(`/reminder/${reminderOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  // Permanent — a reminder is not moved to the trash and cannot be restored.
  async deleteReminder(reminderOid: string): Promise<void> {
    await this.fetch<void>(`/reminder/${reminderOid}`, { method: "DELETE" });
  }

}

// ---------------------------------------------------------------------------
// Reminder helpers (Sep 21 2026)
// ---------------------------------------------------------------------------

/**
 * Body shared by the three reminder-create endpoints. `members` and
 * `partner` are create-only and mutually exclusive (400 together).
 */
export interface QuireCreateReminderBody {
  /**
   * When this reminder fires (UTC, ISO 8601). A plain instant — there is no
   * all-day reminder, so a bare date means midnight UTC.
   *
   * Required when the reminder has no task, or its task has neither a start
   * nor a due date. Rejected with 400 when the task HAS one of those dates:
   * the reminder fires from the task's own schedule then, so send `leads`
   * alone.
   */
  when?: string;
  /** Rejected with 400 on a reminder whose task has a start or due date. */
  recurrence?: QuireRecurrence;
  /**
   * When to notify before the fire time, one notification each. Omit for a
   * single notification at the fire time (the default, `[{minutes: 0}]`).
   */
  leads?: QuireReminderLead[];
  /** Text shown instead of the default message (Markdown supported). */
  name?: string;
  /**
   * OID of an external team to share this reminder with. Project reminders
   * only: one of the project's external teams, or on a task reminder the
   * team the task is shared with (its own `partner`, or its nearest
   * parent's); anything else is 400, where an unknown team used to be
   * dropped and the reminder sent to every member (Oct 30 2026). Cannot be
   * combined with `members`. An external-team member sharing with every
   * member must set it to one of their own teams.
   */
  partner?: string;
  /**
   * Who can see this reminder, and the only ones it notifies. Omit or pass
   * null for every member of the owner; `[]` for the owner's admins only; a
   * list of users (OID, ID, email, or `"me"`) for just those. A non-empty
   * list must include you, and every entry must be a member of the owner —
   * otherwise 400. On a task reminder, every listed user must also see the
   * task — an external-team member sees only the tasks shared with their
   * team — or it is 400 naming them (Oct 30 2026). A personal reminder
   * (owner `-`) is always yours alone, so nobody else can be named.
   */
  members?: string[];
}

export interface QuireReminderListOptions {
  /**
   * Page size, 1..1000, or `"no"` for every reminder in one array (the
   * default when omitted). With a numeric limit, the LAST item of the page
   * carries a `cursor` when more remain.
   */
  limit?: number | "no";
  /** The previous page's last-item `cursor`, passed back verbatim. */
  cursor?: string;
  /**
   * List only the reminders that fire (Sep 25 2026):
   *
   * - `"standalone"` — at their own `when`: no task, or a task with neither
   *   a start nor a due date.
   * - `"anchored"` — from their task's due date (or its start date when it
   *   has no due date). Their `when` is null.
   *
   * Omit for both. `{ timing: "standalone", status: "active" }` is the set
   * still to fire at a time of their own, e.g. to sync to a calendar.
   */
  timing?: "standalone" | "anchored";
  /**
   * `"active"` lists only the reminders with a notification still to come —
   * not one whose notifications are all past, nor one on a completed or
   * archived task. `"all"` (the default) lists every one. A page still holds
   * `limit` reminders while that many remain (Sep 25 2026).
   */
  status?: "active" | "all";
}

function reminderListQuery(options: QuireReminderListOptions): string {
  const parts: string[] = [];
  if (options.limit !== undefined) parts.push(`limit=${options.limit}`);
  if (options.cursor !== undefined)
    parts.push(`cursor=${encodeURIComponent(options.cursor)}`);
  if (options.timing !== undefined) parts.push(`timing=${options.timing}`);
  if (options.status !== undefined) parts.push(`status=${options.status}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

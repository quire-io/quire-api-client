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
  QuireFieldDefinition,
  QuireInsight,
  QuireOrganization,
  QuirePartner,
  QuireProject,
  QuireRateLimit,
  QuireRecurrence,
  QuireStatus,
  QuireSublist,
  QuireTag,
  QuireTask,
  QuireTaskNode,
  QuireTimelog,
  QuireChat,
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
}

// Query params accepted by /task/search, /task/search-organization, and
// /task/search-folder. The last two reject `sublist` and custom fields —
// Quire returns "Unsupported query parameter" on either — so those two
// fields are project-scope only.
export interface QuireTaskSearchParams {
  text?: string;
  name?: string;
  description?: string;
  /** "completed" | "active" | numeric 0–100. */
  status?: string | number;
  scheduled?: boolean;
  mine?: boolean;
  /** Interval like "7d" / "3h" / "30m" (default 7d); `false` to skip. */
  modified?: string | boolean;
  commented?: string | boolean;
  sourceRef?: string;
  /** Integer or "no" for unlimited. Free-plan max is 30. */
  limit?: number | string;
  /**
   * Apr 27 2026 cursor pagination — token from the previous page's
   * last-item `cursor` field. Cannot combine with `sublist=` (400). Pair
   * with the same `limit` and any other filter on subsequent calls.
   */
  cursor?: string;
  /** Project-scope only: filter to tasks in one sublist by its OID. */
  sublist?: string;
  /** Project-scope only: custom-field filters keyed by the field's display name. */
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
  /** User OID, id, or email. */
  createdBy?: string;
  /** `true` (only recurring) / `false` (only non-recurring). */
  recurring?: boolean | string;
}

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
    push(k, v);
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

// Apr 27 2026: /task/list and /task/search gained opt-in cursor pagination
// via `?limit=N` and `?cursor=<token>`. With more pages to come, the LAST
// item in the response carries `"cursor": "<token>"`; passing it back as
// `?cursor=…` (with the same `?limit=`) fetches the next page. End of
// stream is signalled by the absence of `cursor` on the final item. The
// previous unbounded /task/list 200-cap fail-loud workaround (issue #83)
// is retired — callers paginate explicitly via `limit` / `cursor`.

function listPagingQuery(options: {
  limit?: number | "no";
  cursor?: string;
}): string {
  const parts: string[] = [];
  if (options.limit !== undefined) parts.push(`limit=${options.limit}`);
  if (options.cursor !== undefined)
    parts.push(`cursor=${encodeURIComponent(options.cursor)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export class QuireClient {
  private tokens: QuireTokens;
  private readonly apiServer: string;
  private readonly logger: QuireLogger;
  private readonly refreshTokensFn?: RefreshTokensFn;
  private onTokenRefresh?: OnTokenRefresh;
  private onAuthRevoked?: OnAuthRevoked;

  constructor(options: QuireClientOptions) {
    this.tokens = options.tokens;
    this.apiServer = options.apiServer.replace(/\/+$/, "");
    this.logger = options.logger ?? noopLogger;
    this.refreshTokensFn = options.refreshTokens;
    this.onTokenRefresh = options.onTokenRefresh;
    this.onAuthRevoked = options.onAuthRevoked;
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
        ...(options.headers as Record<string, string> | undefined),
      },
    });
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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

    // 204 No Content — DELETE endpoints (and some PUTs) have no body.
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return res.json() as Promise<T>;
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
  async getRateLimit(orgOid: string): Promise<QuireRateLimit> {
    return this.fetch<QuireRateLimit>(`/rate_limit/${orgOid}`);
  }

  // PUT /organization accepts `name`, `description`, and follower deltas
  // (Apr 22 2026). Response now includes `editedAt`. See O4 and O5 in
  // tests/quire_api/organization.test.ts.
  async updateOrganization(
    orgOid: string,
    body: {
      name?: string;
      description?: string;
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
  // `archived` (bool toggle), `public` (bool toggle), and follower deltas
  // (Apr 22 2026). Pass null on `start` / `due` to clear the existing
  // date. Response now includes `start`, `due`, `archivedAt`, `publicAt`,
  // and the `fields` custom-field map. See P7, P10, P11, P12 in
  // tests/quire_api/project.test.ts.
  async updateProject(
    projectOid: string,
    body: {
      name?: string;
      description?: string;
      start?: string | null;
      due?: string | null;
      archived?: boolean;
      public?: boolean;
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
  // Project custom-field definitions — Apr 22 2026
  //
  // Each operation addresses a definition by the project OID + the field's
  // display name. Name is URL-encoded since display names can include
  // spaces and punctuation. Response shape mirrors `FieldDefinition` in the
  // Quire API reference; the project's GET response embeds the same shape
  // under `fields` keyed by name.
  // -----------------------------------------------------------------------

  async addProjectField(
    projectOid: string,
    body: { name: string; type: string; [key: string]: unknown },
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(`/project/add-field/${projectOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Omitted body keys preserve their current value server-side per the
  // changelog. Caller should send only the keys they want to change.
  async updateProjectField(
    projectOid: string,
    fieldName: string,
    body: Record<string, unknown>,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/project/update-field/${projectOid}/${encodeURIComponent(fieldName)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async renameProjectField(
    projectOid: string,
    fieldName: string,
    newName: string,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/project/rename-field/${projectOid}/${encodeURIComponent(fieldName)}/${encodeURIComponent(newName)}`,
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
    const qs = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.fetch<QuireFieldDefinition>(
      `/project/move-field/${projectOid}/${encodeURIComponent(fieldName)}${qs}`,
      { method: "PUT" },
    );
  }

  async removeProjectField(
    projectOid: string,
    fieldName: string,
  ): Promise<void> {
    await this.fetch<void>(
      `/project/remove-field/${projectOid}/${encodeURIComponent(fieldName)}`,
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
  // either param, the response is the full bare array as before.
  async listTasks(
    projectOid: string,
    options: { limit?: number | "no"; cursor?: string } = {},
  ): Promise<QuireTask[]> {
    return this.fetch<QuireTask[]>(
      `/task/list/${projectOid}${listPagingQuery(options)}`,
    );
  }

  async listSubtasks(
    taskOid: string,
    options: { limit?: number | "no"; cursor?: string } = {},
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

  // -----------------------------------------------------------------------
  // Tasks (create, update, move, transfer)
  // -----------------------------------------------------------------------

  async createTask(
    projectOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      // Built-in Estimate field. Wire name is `etc` (non-negative integer
      // seconds). NOT a custom field — Quire 400s if sent under `customFields`.
      etc?: number;
      // Pass `milestone: true` or `section: true` to create that task type
      // directly. Safe at creation time — no side effects.
      milestone?: boolean;
      section?: boolean;
      // Recurrence spec — see docs/quire-recurring.md for the wire shape.
      recurrence?: QuireRecurrence;
      // Custom-field values (Apr 24 2026 confirmed by TC1). Flattened into
      // top-level body keys by flattenCustomFields — same shape as updateTask.
      customFields?: Record<string, unknown>;
    },
  ): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/${projectOid}`, {
      method: "POST",
      body: JSON.stringify(flattenCustomFields(body)),
    });
  }

  async createSubtask(
    parentTaskOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      etc?: number;
      milestone?: boolean;
      section?: boolean;
      recurrence?: QuireRecurrence;
      customFields?: Record<string, unknown>;
    },
  ): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/${parentTaskOid}`, {
      method: "POST",
      body: JSON.stringify(flattenCustomFields(body)),
    });
  }

  // Create a task positioned relative to an existing sibling. Quire derives
  // the container (project for root tasks, parent task for subtasks) from
  // the sibling OID, so this single endpoint covers both root siblings and
  // subtask siblings. Verified against TPos1-TPos3 in
  // tests/quire_api/task.test.ts.
  async createTaskRelative(
    siblingTaskOid: string,
    body: {
      name: string;
      description?: string;
      due?: string;
      start?: string;
      priority?: string;
      tags?: string[];
      assignees?: string[];
      etc?: number;
      milestone?: boolean;
      section?: boolean;
      recurrence?: QuireRecurrence;
      customFields?: Record<string, unknown>;
    },
    position: "before" | "after",
  ): Promise<QuireTask> {
    return this.fetch<QuireTask>(
      `/task/${siblingTaskOid}?position=${encodeURIComponent(position)}`,
      {
        method: "POST",
        body: JSON.stringify(flattenCustomFields(body)),
      },
    );
  }

  async updateTask(
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
      // Incremental tag/assignee edits; passed straight through to Quire,
      // which accepts these alongside the replace-mode `tags` / `assignees`.
      addTags?: string[];
      removeTags?: string[];
      addAssignees?: string[];
      removeAssignees?: string[];
      // Task dependencies. The source task's `successors` list is the only
      // editable side — `predecessors` is computed server-side by reverse
      // lookup. Each element: task OID, or "#<numeric-id>" (see
      // coerceSuccessors in api_util.dart). `removeSuccessors: ["*"]` clears
      // every successor in one call — confirmed via T23 in
      // tests/quire_api/task.test.ts.
      addSuccessors?: string[];
      removeSuccessors?: string[];
      // Built-in Estimate field — see createTask.
      etc?: number;
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
      // Custom-field values keyed by display name. flattenCustomFields
      // rewrites this into top-level body keys before send — that's Quire's
      // wire format. See https://quire.io/dev/api/ → Update task.
      customFields?: Record<string, unknown>;
    },
  ): Promise<QuireTask> {
    return this.fetch<QuireTask>(`/task/${taskOid}`, {
      method: "PUT",
      body: JSON.stringify(flattenCustomFields(body)),
    });
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
  async moveTask(
    taskOid: string,
    parentOid?: string,
    position?: "parent" | "before" | "after",
  ): Promise<QuireTask> {
    const target = parentOid && parentOid.length > 0 ? parentOid : "root";
    const qs: string[] = [`task=${encodeURIComponent(target)}`];
    if (position) qs.push(`position=${position}`);
    return this.fetch<QuireTask>(
      `/task/move/${taskOid}?${qs.join("&")}`,
      { method: "PUT" },
    );
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
  async transferTask(
    taskOid: string,
    params: {
      project: string;
      task?: string;
      position?: "parent" | "before" | "after";
      invite?: boolean;
      tag?: boolean;
      status?: boolean;
      customField?: boolean;
    },
  ): Promise<QuireTask> {
    const qs: string[] = [`project=${encodeURIComponent(params.project)}`];
    if (params.task !== undefined) qs.push(`task=${encodeURIComponent(params.task)}`);
    if (params.position) qs.push(`position=${params.position}`);
    if (params.invite !== undefined) qs.push(`invite=${params.invite ? "true" : "false"}`);
    if (params.tag !== undefined) qs.push(`tag=${params.tag ? "true" : "false"}`);
    if (params.status !== undefined) qs.push(`status=${params.status ? "true" : "false"}`);
    if (params.customField !== undefined) qs.push(`custom-field=${params.customField ? "true" : "false"}`);
    return this.fetch<QuireTask>(`/task/transfer/${taskOid}?${qs.join("&")}`, {
      method: "PUT",
    });
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
  //   - Body is a top-level JSON array (1..300 items per call).
  //   - Response is a same-length array. `bulk-update` / `bulk-remove`
  //     return null in any slot whose target task could not be found
  //     (already-removed, never existed, cascade-removed by an earlier
  //     item in the same batch); the rest of the batch proceeds.
  //   - Any per-item validation / permission / DB error rolls back the
  //     whole batch and returns `{code, message}` with `items[i]:`
  //     prefixed so the caller can pinpoint the offending row.
  //   - Per-item rate-limit cost: each call costs N units (= the number
  //     of submitted items); charged upfront before any item runs.
  //   - Optional `?return=compact` renders `{oid, id}` (or `null`) per
  //     slot — strongly recommended for large batches to keep the
  //     response payload small. Wired here as the default for
  //     destructive-but-quiet ops (remove, move) and as opt-in for ops
  //     where the caller may want to confirm the resulting record (add,
  //     update, transfer, approve).
  //
  // See TBA1 / TBA2 / TBU1 / TBM1 / TBP1 / TBD1 in
  // tests/quire_api/task.test.ts. bulk-transfer relies on the existing
  // single-task transfer wire-shape coverage (TT1 + TMP4) — the cross-
  // project setup needed for a live bulk-transfer test isn't easy to
  // prepare per CLAUDE.md.
  // -----------------------------------------------------------------------

  // POST /task/bulk-add/{projectOid} — N root tasks. Items can include
  // nested `tasks` to create subtrees in the same call (only the root of
  // each item is echoed in the response).
  async bulkCreateTasks(
    projectOid: string,
    items: Array<Record<string, unknown>>,
    options: { return?: "compact" } = {},
  ): Promise<Array<QuireTask>> {
    const qs = options.return ? `?return=${options.return}` : "";
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
    } = {},
  ): Promise<Array<QuireTask>> {
    const qs = new URLSearchParams();
    if (options.position) qs.set("position", options.position);
    if (options.return) qs.set("return", options.return);
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
    options: { return?: "compact" } = {},
  ): Promise<Array<QuireTask | null>> {
    const qs = options.return ? `?return=${options.return}` : "";
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
    options: { return?: "compact" | "full" } = {},
  ): Promise<Array<{ oid: string; id?: number } | QuireTask | null>> {
    const ret = options.return ?? "compact";
    const qs = ret === "full" ? "" : `?return=${ret}`;
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
    },
  ): Promise<Array<{ oid: string; id?: number } | QuireTask>> {
    const ret = options.return ?? "compact";
    const qs = new URLSearchParams({ task: String(options.task) });
    if (options.position) qs.set("position", options.position);
    if (ret !== "full") qs.set("return", ret);
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
    return this.fetch(
      `/task/bulk-transfer/${sourceProjectOid}?${qs.toString()}`,
      { method: "PUT", body: JSON.stringify(refs) },
    );
  }

  // POST /task/bulk-approve/{projectOid}?state=<state>&category=<cat> —
  // refs in the body. Reuses the single-task approve grammar (state token
  // selects `request` / `approve` / `reject` / `change`).
  async bulkApproveTasks(
    projectOid: string,
    refs: Array<string | number>,
    options: {
      state: "request" | "approve" | "reject" | "change";
      category?: string;
      return?: "compact" | "full";
    },
  ): Promise<Array<{ oid: string; id?: number } | QuireApproval>> {
    const qs = new URLSearchParams({ state: options.state });
    if (options.category !== undefined) qs.set("category", options.category);
    if (options.return) qs.set("return", options.return);
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
  // by the runtime. Filename in the URL is path-segment-encoded; the server
  // rejects names containing `/`. Verified by A1/A2 in
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
  // Counts against the per-plan task creation quota, so the caller can
  // still surface a 469 to the user on a quota-exceeded restore.
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
  // (body is now unused) so the grammar matches the bulk-approve endpoint.
  // Response is the Approval object only (not the full task). DELETE
  // /task/revoke-approval returns 204 with no body in all three cases:
  // rolling back approved/rejected → awaiting, clearing awaiting/changes
  // → no-approval, and idempotent no-op on a task with no active
  // approval. See TA1–TA6 in tests/quire_api/task.test.ts.
  // -----------------------------------------------------------------------

  async approveTask(
    taskOid: string,
    body: {
      state: "request" | "approve" | "reject" | "change";
      category?: string;
    },
  ): Promise<QuireApproval> {
    const qs = new URLSearchParams({ state: body.state });
    if (body.category !== undefined) qs.set("category", body.category);
    return this.fetch<QuireApproval>(
      `/task/approve/${taskOid}?${qs.toString()}`,
      { method: "POST" },
    );
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
    body: { name: string; description?: string },
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
      start?: string;
      due?: string;
      archived?: boolean;
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
  // `{ task, exclude? }`: omitting `exclude` (or `false`) adds the task;
  // `exclude: true` removes it. This is the only path for sublist
  // membership — `/task/move` only reparents within the task tree and
  // returns a generic 400 when handed a sublist OID. See:
  //   boeneo/server/lib/src/api/sublist_api.dart
  async updateSublistMembership(
    sublistOid: string,
    changes: { task: string; exclude?: boolean }[],
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

  async addComment(taskOid: string, text: string): Promise<QuireComment> {
    return this.fetch<QuireComment>(`/comment/${taskOid}`, {
      method: "POST",
      body: JSON.stringify({ description: text }),
    });
  }

  async addChatComment(
    chatOid: string,
    body: { description: string; pinned?: boolean },
  ): Promise<QuireComment> {
    return this.fetch<QuireComment>(`/comment/chat/${chatOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateComment(
    commentOid: string,
    body: { description?: string; pinned?: boolean },
  ): Promise<QuireComment> {
    return this.fetch<QuireComment>(`/comment/${commentOid}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
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
    body: { name: string; description?: string; partner?: string },
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
  // Mirrors the Sublist / Doc / Chat shape. GET /insight/list/{ownerOid}
  // works for both project and organization OIDs — Quire routes by entity
  // type. POST uses `/insight/{projectOid}` for project-owned views and
  // `/insight/organization/{orgOid}` for org-owned — confirmed by
  // ../boeneo/web/test/api/insight_test.dart.
  // -----------------------------------------------------------------------

  async listInsights(ownerOid: string): Promise<QuireInsight[]> {
    return this.fetch<QuireInsight[]>(`/insight/list/${ownerOid}`);
  }

  async getInsight(insightOid: string): Promise<QuireInsight> {
    return this.fetch<QuireInsight>(`/insight/${insightOid}`);
  }

  async createInsight(
    ownerType: "project" | "organization",
    ownerOid: string,
    body: {
      name: string;
      description?: string;
      image?: string;
      iconColor?: string;
      id?: string;
    },
  ): Promise<QuireInsight> {
    const path = ownerType === "organization"
      ? `/insight/organization/${ownerOid}`
      : `/insight/${ownerOid}`;
    return this.fetch<QuireInsight>(path, {
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
    body: { name: string; type: string; [key: string]: unknown },
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(`/insight/add-field/${insightOid}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateInsightField(
    insightOid: string,
    fieldName: string,
    body: Record<string, unknown>,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/insight/update-field/${insightOid}/${encodeURIComponent(fieldName)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async renameInsightField(
    insightOid: string,
    fieldName: string,
    newName: string,
  ): Promise<QuireFieldDefinition> {
    return this.fetch<QuireFieldDefinition>(
      `/insight/rename-field/${insightOid}/${encodeURIComponent(fieldName)}/${encodeURIComponent(newName)}`,
      { method: "PUT" },
    );
  }

  async moveInsightField(
    insightOid: string,
    fieldName: string,
    before?: string | null,
  ): Promise<QuireFieldDefinition> {
    const qs = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.fetch<QuireFieldDefinition>(
      `/insight/move-field/${insightOid}/${encodeURIComponent(fieldName)}${qs}`,
      { method: "PUT" },
    );
  }

  async removeInsightField(
    insightOid: string,
    fieldName: string,
  ): Promise<void> {
    await this.fetch<void>(
      `/insight/remove-field/${insightOid}/${encodeURIComponent(fieldName)}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // Notifications
  //
  // POST /notification fires an in-app notification to the *current* user
  // (the one whose access token is making the call) — not to arbitrary
  // recipients. Requires the `share` scope (`arNotification` server-side);
  // calls without it return 403. No response body.
  // -----------------------------------------------------------------------

  async sendNotification(body: {
    message: string;
    url?: string;
  }): Promise<void> {
    await this.fetch<void>(`/notification`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

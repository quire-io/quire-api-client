/**
 * Quire API type definitions.
 *
 * Verified against https://quire.io/dev/api/ (April 2026).
 * Each interface includes typed fields for common/important properties
 * plus a [key: string]: unknown catch-all so untyped fields still pass
 * through at runtime (callers that JSON.stringify the full API response
 * surface every field verbatim).
 */

// ---------------------------------------------------------------------------
// Tokens (our internal shape, not a Quire API response)
// ---------------------------------------------------------------------------
export interface QuireTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * How Quire returns enum-like task fields (priority, status) on GET/POST
 * responses: a paired value + display name. Write paths still accept the
 * bare value or name — this shape only shows up on reads.
 */
export interface QuireEnumValue {
  value: number;
  name: string;
}

/**
 * The compact response shape returned by `?return=compact` on single-resource
 * write endpoints (create / update / move / transfer / approve, plus a few
 * extension endpoints). Identifiers only — `oid` always, plus `id` when the
 * entity has an integer id (tasks, projects, status values, …). Comments
 * have no integer id, so callers should treat `id` as optional.
 *
 * Opting into compact skips the server's post-write reload + render, which
 * is the real performance win on top of the smaller payload — useful for
 * agent / bulk workflows that only need the OID to chain follow-up calls.
 */
export interface QuireCompactRef {
  oid: string;
  id?: number;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export interface QuireUser {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  email?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  website?: string;
  // IETF BCP 47 language tag (e.g. "en", "zh-TW"). Added Oct 30 2025.
  locale?: string;
  // IANA tz database name (e.g. "Asia/Taipei"). Added Oct 30 2025.
  timeZone?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------
export interface QuireOrganization {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  email?: string;
  website?: string;
  // Free plan returns `{ plan: "Free" }` — `due` and `expired` only appear
  // on paid subscriptions. Verified via tests/quire_api/subscription.test.ts.
  subscription?: { plan: string; due?: string; expired?: boolean };
  followers?: { oid: string; id: string; name: string }[];
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  editedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------
export interface QuireProject {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  email?: string;
  website?: string;
  start?: string;
  due?: string;
  archivedAt?: string;
  publicAt?: string;
  // Map of custom-field definitions keyed by display name. Present since
  // the Apr 22 2026 release — empty object when no definitions are set.
  fields?: Record<string, QuireFieldDefinition>;
  // Approval categories configured on the project (Apr 24 2026). Includes an
  // implicit "Default" entry (id: "") alongside any caller-added categories.
  // Field is ABSENT (undefined) when no custom category has ever been added —
  // Quire doesn't materialize the Default until the first add-appv-cat call.
  approvalCategories?: QuireApprovalCategory[];
  followers?: { oid: string; id: string; name: string }[];
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Custom-field definition (project-level)
//
// Shape mirrors the add-field / update-field request bodies on
// `/project/*-field/…` (Apr 22 2026). Canonical keys are enumerated in
// boeneo/server/lib/src/api/field.dart around line 45 — we type the
// universal ones and keep a catch-all for type-specific config
// (`options`, `formula`, `resultType`, `lookupType`, etc.).
// ---------------------------------------------------------------------------
export interface QuireFieldDefinition {
  name: string;
  /** `text` | `number` | `money` | `date` | `duration` | `select` | `checkbox`
      | `user` | `task` | `hyperlink` | `email` | `formula` | `file` | `lookup` */
  type: string;
  hidden?: boolean;
  private?: boolean;
  percent?: boolean;
  clearOnDup?: boolean;
  multiple?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Approval — project-level categories + task-level state (Apr 24 2026).
//
// Shape verified live against the Apr 24 2026 release:
//   - AppvCat.claimers / approvers: semantic null = "anyone", [] = "admins
//     only", [oids] = explicit user list. Server OMITS the key entirely
//     when the roster semantic is "anyone" — do NOT infer the value from
//     the key's absence beyond "anyone."
//   - Approval.requester / approver are bare user-OID strings, not the
//     { oid, name, ... } user summaries used elsewhere in the task shape.
//   - After a full revoke (awaiting → cleared) the task response drops the
//     `approval` key entirely — callers should treat undefined as "no
//     active approval."
//
// May 1 2026 (boeneo #24609): {oid, id} companion fields ride alongside
// the bare-OID variants — claimerRefs / approverRefs / requesterRef /
// approverRef. The companion form preserves the same tri-state as its
// counterpart (omitted = anyone; [] = admins-only; list = explicit
// roster). Callers can project responses through the new fields to
// surface human-readable user ids instead of opaque OIDs; the bare-OID
// fields are kept in the type for the wire contract.
//
// See PAC1–PAC5 and TA1–TA5 in tests/quire_api/{project,task}.test.ts.
// ---------------------------------------------------------------------------
export interface QuireApprovalCategory {
  /** Caller-supplied id — must pass `isValidId`. "" is the implicit Default. */
  id: string;
  name: string;
  /** Absent = anyone; [] = admins only; [userOids] = explicit roster. */
  claimers?: string[];
  /** Absent = anyone; [] = admins only; [userOids] = explicit roster. */
  approvers?: string[];
  /** {oid, id} companion to claimers (May 1 2026). Same tri-state semantics. */
  claimerRefs?: { oid: string; id: string }[];
  /** {oid, id} companion to approvers (May 1 2026). Same tri-state semantics. */
  approverRefs?: { oid: string; id: string }[];
  createdBy?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface QuireApproval {
  /** Category id. "" resolves to the project's implicit Default category. */
  category: string;
  state: "awaiting" | "approved" | "rejected" | "changes";
  /** User OID of the original requester; preserved across state transitions. */
  requester: string;
  /** User OID of the last approver/rejecter; absent on pure "request" state. */
  approver?: string;
  /** {oid, id} companion to requester (May 1 2026). */
  requesterRef?: { oid: string; id: string };
  /** {oid, id} companion to approver (May 1 2026). Absent while state="awaiting". */
  approverRef?: { oid: string; id: string };
  toggledAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Attachment — file attached to a task (or comment, eventually). Verified by
// A1/A2 in tests/quire_api/attachment.test.ts.
//
// `url` form differs by source: POST /task/attach returns an absolute URL
// (`https://quire.io/att/...`), but the same entry inside `attachments[]` on
// GET /task/{oid} carries it relative (`/att/...`). Callers that want a
// clickable link should prepend QUIRE_API_SERVER when the value starts with
// `/`. Files are stored with `x-amz-acl: public-read` — the path segment is
// unguessable but the URL itself is not authenticated.
// ---------------------------------------------------------------------------
export interface QuireAttachment {
  name: string;
  url: string;
  length: number;
  /** Type discriminator — observed value 2 for ordinary file uploads. */
  type?: number;
  createdAt?: string;
  createdBy?: { oid: string; id: string; name: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Recurrence — see docs/quire-recurring.md for the full wire contract and
// TR1–TR9 in tests/quire_api/task.test.ts for live-API coverage.
//
// byweekday uses 0..6 = Mon..Sun. It's an array for weekly rules and a
// single int for monthly/yearly "nth-week" rules. byweekno pairs with
// byweekday for "nth week of the month" ("last" = last week). bydayno is
// mutually exclusive with byweekno. sincelatest is daily-only. until
// (ISO date) is the only end condition Quire supports. seriesId is
// server-assigned — omit on writes.
// ---------------------------------------------------------------------------
export interface QuireRecurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  byweekday?: number | number[];
  byweekno?: number | "last";
  bydayno?: number;
  bymonth?: number;
  until?: string;
  dupsubtasks?: boolean;
  sincelatest?: boolean;
  seriesId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Task — id is an integer (numeric ID within project), not a string
// ---------------------------------------------------------------------------
export interface QuireTask {
  oid: string;
  id: number;
  name: string;
  nameText?: string;
  nameHtml?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  url?: string;
  // Quire returns status and priority as a { value, name } pair on GET
  // responses (e.g. `{ value: 100, name: "Completed" }`, `{ value: 1, name:
  // "High" }`) even though PUT/POST bodies accept the numeric value or the
  // capitalized name directly. Keep read and write shapes distinct.
  status?: QuireEnumValue;
  complete?: boolean;
  priority?: QuireEnumValue;
  due?: string;
  start?: string;
  // Built-in Estimate field. Non-negative integer seconds. Not a custom field.
  etc?: number;
  createdAt?: string;
  editedAt?: string;
  archivedAt?: string;
  // Last comment timestamp. Bumped by /comment POSTs; drives the `commented`
  // search filter on /task/search*.
  commentedAt?: string;
  // Free-form external identifier echoed by Quire (used with the `sourceRef`
  // search filter). Write path is exposed on create_task / create_subtask.
  sourceRef?: string;
  // Peekaboo (archived) state. `reshowAt` is the auto-reshow timestamp (null
  // means "never auto-reshow"); `peekaboo` is a derived `true` set whenever
  // archivedAt is non-null. See tests/quire_api/task.test.ts TP1–TP3.
  reshowAt?: string | null;
  peekaboo?: boolean;
  // Recurrence spec — see QuireRecurrence above and docs/quire-recurring.md.
  // Null when the task has no active recurrence (or field absent on read).
  recurrence?: QuireRecurrence | null;
  timelogs?: QuireTimelog[];
  // Task dependencies round-trip as `"#<numeric-id>"` strings, not { oid }
  // objects. Quire edits only the `successors` side via PUT /task/{oid};
  // `predecessors` is computed server-side and is read-only.
  successors?: string[];
  predecessors?: string[];
  // Approval state (Apr 24 2026). Absent when no approval has been requested
  // or after a full revoke. Managed via POST /task/approve and DELETE
  // /task/revoke-approval — not via PUT /task/{oid}.
  approval?: QuireApproval;
  // Quire marks organizational containers with `section: true` and timeline
  // markers with `milestone: true`. Normal tasks have neither set.
  section?: boolean;
  milestone?: boolean;
  parent?: { oid: string; id: number; name?: string };
  project?: { oid: string; id: string; name?: string };
  sublist?: { oid: string; name?: string };
  assignees?: { oid: string; id: string; name: string }[];
  followers?: { oid: string; id: string; name: string }[];
  tags?: { oid: string; id: string; name: string }[];
  customFields?: Record<string, unknown>;
  attachments?: QuireAttachment[];
  comments?: unknown[];
  externalLinks?: unknown[];
  effort?: unknown;
  createdBy?: { oid: string; id: string; name: string };
  editedBy?: { oid: string; id: string; name: string };
  [key: string]: unknown;
}

// /task/list ?depth= subtree fetch (Apr 27 2026). Each task carries a
// nested `tasks` field for its walked children. When the plan-tier cap is
// hit, the last sibling at the cropped level carries `cropped: true` and
// the caller drills into that level via a follow-up /task/list call. The
// type is recursive and reuses the QuireTask catch-all so it works in both
// default mode (full task records) and `?return=compact` mode
// (`{oid, id, tasks?, cropped?}` — the stripped fields just stay
// `undefined` in the typed view).
export type QuireTaskNode = QuireTask & {
  tasks?: QuireTaskNode[];
  cropped?: boolean;
};

// Time-log entry on a task (Apr 27 2026 add/update/remove endpoints).
// Identity is the (user, start, end) triple; sub-second precision is
// truncated to whole seconds server-side. The server response only emits
// `billable` when its value is true (false is implicit absence) — see
// boeneo/web/test/api/src/timelog_test.dart.
export interface QuireTimelog {
  start: string;
  end: string;
  user: { oid: string; id?: string; name?: string };
  note?: string;
  billable?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------
export interface QuireTag {
  oid: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  color?: string;
  url?: string;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sublist
// ---------------------------------------------------------------------------
export interface QuireSublist {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  due?: string;
  start?: string;
  archivedAt?: string;
  owner?: unknown;
  partner?: unknown;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export interface QuireStatus {
  oid?: string;
  value: number;
  name: string;
  color?: string;
  projectOid?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Chat channel
// ---------------------------------------------------------------------------
export interface QuireChat {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  owner?: unknown;
  partner?: unknown;
  start?: string;
  due?: string;
  archivedAt?: string;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
export interface QuireDocument {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  owner?: unknown;
  partner?: unknown;
  start?: string;
  due?: string;
  archivedAt?: string;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Rate limit — Apr 22 2026
//
// GET /rate_limit/{orgOid} returns per-hour and per-minute API-usage
// buckets for an organization. `limit: -1` on either bucket means
// unlimited. `reset` is a Unix timestamp in seconds. The endpoint itself
// is free (doesn't count against the quota) — see
// ../boeneo/server/lib/src/api/rate_limit_api.dart.
// ---------------------------------------------------------------------------
export interface QuireRateLimitBucket {
  limit: number;
  used: number;
  remaining: number;
  reset: number;
}

export interface QuireRateLimit {
  organization: string;
  plan: string;
  hour: QuireRateLimitBucket;
  minute: QuireRateLimitBucket;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Insight view (custom project/org view) — Apr 22 2026
// ---------------------------------------------------------------------------
export interface QuireInsight {
  oid: string;
  id: string;
  name: string;
  nameText?: string;
  nameHtml?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  url?: string;
  image?: string;
  iconColor?: string;
  color?: string;
  owner?: { oid: string; id?: string; type?: string };
  archivedAt?: string;
  // Insight-level custom-field definitions (Apr 22 2026). Same shape as
  // QuireProject.fields, but insights accept only the `formula` and
  // `lookup` types — `number` / `money` / `date` / `text` / etc. return 400.
  fields?: Record<string, QuireFieldDefinition>;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  editedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Partner — external team attached to a project
// ---------------------------------------------------------------------------
export interface QuirePartner {
  oid: string;
  name: string;
  color?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Comment — has NO `id` field (only `oid`)
// ---------------------------------------------------------------------------
export interface QuireComment {
  oid: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  url?: string;
  attachments?: QuireAttachment[];
  pinAt?: string;
  pinBy?: { oid: string; id: string; name: string };
  owner?: unknown;
  createdBy?: { oid: string; id: string; name: string };
  createdAt?: string;
  editedBy?: { oid: string; id: string; name: string };
  editedAt?: string;
  [key: string]: unknown;
}

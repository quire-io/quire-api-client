# Changelog

## Unreleased

Covers the **Oct 15 2026** server release.

- **Comment emoji reactions** (zkoss/boeneo#26000) — `addCommentEmojis(commentOid, emojis)` and `removeCommentEmojis(commentOid, emojis)` wrap `POST /comment/add-emoji/{commentOid}/{emojis}` and `DELETE /comment/remove-emoji/{commentOid}/{emojis}`. `QuireComment.emojis` (new exported type `QuireCommentEmoji`) carries a comment's reactions on every read — get, list, create, update and undo-remove — and is omitted when there are none.
    - An emoji can be the emoji itself or its GitHub / Slack shortcode (`+1`, `:tada:`, any case); the client percent-encodes each and joins them with commas. Responses always return the emoji itself.
    - All or nothing: an add with any emoji outside the 20 Quire's reaction picker offers is rejected with `400` and writes nothing. At most 20 distinct emojis per call. Both resolve to `undefined` (`204`) — read the comment for the result. An empty list throws before any request; nothing else is validated client-side.
    - `removeCommentEmojis` on a missing or deleted comment is a `204` no-op like every delete, not the `404` the API doc listed (quire-api/quire-api#78). Covered by CE1-CE16 in `tests/live/comment-emoji.live.test.ts`.

## 1.0.0 — 2026-09-22

First stable release. The client has tracked the Quire REST API through twelve 0.1.x releases without a shape change to `QuireClient`, so the public surface is now committed to under semver.

**Breaking:** `members` is returned as a list of user objects (`{oid, id, name}`) where the server previously returned a list of OID strings — see the entry below. The change is server-side (Sep 21 2026), so it reaches callers on 0.1.12 too; this release declares the new shape in the types.

The first four entries below cover the **Sep 21 2026** server release (zkoss/boeneo#25825); the task-follower and live-test entries after them are independent of it.

- **Reminder API** — nine new endpoints wrapped: `createReminder(ownerType, ownerOid, body)`, `createReminderById`, `createTaskReminderById(projectId, taskId, body)`, `getReminder(oid)`, `listReminders(ownerType, ownerOid, {limit, cursor})`, `listRemindersById`, `listTaskRemindersById`, `updateReminder(oid, body)`, `deleteReminder(oid)`. New exported types `QuireReminder`, `QuireReminderLead`, `QuireReminderOwnerType`, `QuireCreateReminderBody`, `QuireReminderListOptions`.
    - `ownerType` is **always required** — unlike sublist / doc / chat / insight / dashboard, these endpoints have no implied `project`. Pass `"project"` with ownerOid `"-"` for the caller's own inbox.
    - What a reminder fires from depends on its task: one **with** a start or due date supplies the time, so `when` / `recurrence` are rejected with `400`; with no task, or a task with neither date, `when` is required.
    - `leads` entries name exactly one of `minutes` (absolute offset) or `days` (calendar days, keeping wall-clock time across a DST change), with an optional `at` (`"HH:mm"`, `days` only). Omitting it means one notification at the fire time.
    - `deleteReminder` is permanent — reminders don't go to the trash, so there is deliberately no `undoRemoveReminder`.
    - Lists are ordered by `oid`: stable but **not** chronological. Covered by RM1-RM8 in `tests/live/reminder.live.test.ts`.
- **`members` on create** — `createSublist`, `createDocument`, `createChat`, `createInsight` and `createDashboard` accept an optional `members?: string[]` (user OID, ID, email, or `"me"`), so a record can be created visible only to chosen users. Tri-state: omit or pass null for every member of the owner, `[]` for the owner's admins only, a list for just those users. Create-only — it cannot be changed afterwards. A listed non-member is rejected with `400` (not silently dropped the way a task's `assignees` are), a non-empty list must include the caller, and combining it with `partner` is `400`. Covered by SL5-SL8 in `tests/live/sublist.live.test.ts`.
- **`members` in responses** — `QuireSublist`, `QuireChat`, `QuireDocument`, `QuireDashboard`, `QuireInsight` and `QuireReminder` now declare `members` as `{oid, id, name}[] | null`, matching `followers` / `mutes`. **Breaking on the wire**: the server previously returned a list of OID strings here. All three states are returned explicitly, so `null` (everyone) and `[]` (admins only) can be told apart.
- **Error taxonomy** — `formatQuireError` follows the release's status split, which moved plan limits off `429`:
    - `402` + body `code` `469` → plan limit / quota. Previously `429`, which invited a back-off-and-retry that could never clear it.
    - `402` + `470` → **expired subscription**, checked before 469 so it isn't reported as a plan limit — only resubscribing helps.
    - `403` + `471` → temporarily blocked account, kept clear of the generic 403 hint about OAuth scopes.
    - `429` now means the API rate limit and nothing else; validation errors carry `code: 400` where they used to carry `469`.
    - The body-`code` checks are status-independent, so the legacy bare-`469` and `429`-wrapped-`469` shapes still resolve to the quota message against an older server. SUB7 accepts either status and pins the body code.

- **Task follower management** — `createTask` / `createSubtask` / `createTaskRelative` accept an optional `followers?: string[]`; `updateTask` gains full-replace `followers` plus `addFollowers` / `removeFollowers`. Values are user OID, ID, or email, plus `"me"`, `"app"` (with the `app|team` / `app|team|channel` / `app|/path` syntaxes), and the task-only `"inherit"` — on add it pulls in the parent task's followers, on remove it drops the ones inherited from the parent. `QuireTask.followers` was already declared, so reads are unchanged. Covered by TF1-TF3 in `tests/live/task.live.test.ts`.
- `updateProject` / `updateOrganization` gain the full-replace `followers` field to sit alongside the `addFollowers` / `removeFollowers` deltas they already had — `UpdateProjectBody` / `UpdateOrganizationBody` have accepted it since Apr 22 2026, the client just never exposed it.
- The bulk task endpoints (`bulkCreateTasks`, `bulkCreateSubtasks`, `bulkUpdateTasks`) needed no change — their items are pass-through `Record<string, unknown>`, so `BulkUpdateTaskItem`'s follower fields already worked.
- New README **Followers** section documents the shared value grammar (including the `app|…` hook-path forms) and which methods take which field shape.
- **Live-test bootstrap now works with public (PKCE) OAuth apps** — `scripts/prepare-test-tokens.ts` treats `QUIRE_CLIENT_SECRET` as optional: present keeps the confidential authorization-code flow, blank/absent switches to PKCE (S256 challenge on the authorize leg, `code_verifier` on the token leg). Needed because the Quire CLI app is a public client with no secret, so the old secret-only path 400s against it.
- The bootstrap's loopback server now binds an ephemeral port (`listen(0, "127.0.0.1")`) and derives `redirect_uri` from the bound port, matching what quire-cli does. Quire ignores the port on loopback redirects (RFC 8252 §7.3, documented under "Loopback redirect URIs" in the API reference), so a registration of `http://127.0.0.1/callback` covers every port. Removes the "free up port 8000 first" requirement; `QUIRE_OAUTH_PORT` pins a port if an app registration needs one.
- `tests/live/helpers.ts` no longer hard-requires `QUIRE_TEST_REFRESH_TOKEN` — a public app's code exchange may not return one. Without it the client trusts the recorded `expiresAt` instead of forcing a refresh on the first call, and a refresh attempt fails with a "re-run prepare" message. `oauth.live.test.ts` OA1 skips when there's no refresh token; OA2 still runs.

## 0.1.12 — 2026-08-21

- **Dashboard API** (server release Jul 20 2026, zkoss/boeneo#25387) — new `QuireDashboard` type plus seven methods: `listDashboards(ownerType, ownerOid)`, `getDashboard(oid)`, `getDashboardById(ownerType, ownerId, dashboardId)`, `createDashboard(ownerType, ownerOid, body)`, `updateDashboard(oid, body)` (set `archived: true`/`false` to archive/unarchive; pass `null` on `start`/`due` to clear), `deleteDashboard(oid)`, and `undoRemoveDashboard(oid)` (idempotent, `429` at the per-owner quota — same as create). Owner types: `project`, `organization`, `folder`, `smart-folder` (exported as `QuireDashboardOwnerType`). The API manages the dashboard container only — widget definitions aren't part of the public API yet.
- **Chat & Doc follower management** (server release Jun 4 2026) — `createChat` / `createDocument` accept an optional `followers?: string[]` (user OID, ID, or email; `"me"` / `"app"` with the `app|team` / `app|/path` syntaxes). `updateChat` gains full-replace `followers` alongside the existing `addFollowers` / `removeFollowers`; `updateDocument` gains all three. `QuireChat` / `QuireDocument` response types now declare `followers` and `mutes`. Note: documents are followable only when project-owned — sending follower fields for other owner types returns `400`.
- No client change needed for the Jul 31 2026 Comment API URL-form removals — the client already uses only the surviving forms (`/comment/{commentOid}`, `/comment/chat/{chatOid}`, `/comment/list/chat/{chatOid}`, OID-form undo-remove).

## 0.1.11 — 2026-05-28

- New `QuireClient.runInsight(insightOid, { groupBy?, status? })` — runs a project-scoped insight server-side and returns the aggregated 2D-array result (`[[headers...], [row...], ...]`). Wraps `GET /insight/run/{insightOid}` from the May 27 2026 server release (#24834). `groupBy` defaults to `member` and accepts `section`; `status` defaults to `active` and accepts `completed` / `all`. Status is applied at the SQL load layer so narrower queries cost less.
- `approveTask` body extends to accept an optional `comment?: { description, pinned?, asUser? }` — when supplied, the server posts a companion comment on the task as a side effect of the approval, auto-prefixed with `**<stream>: <status>**\n\n` (May 27 2026, #24855). The approval response shape is unchanged; fetch the created comment via `getTaskComments` if you need it. `bulk-approve` is intentionally not extended (server-side decision — its body is already a top-level task-ref array).
- `searchTasks` (project / org / folder) — Number, Money, and Duration custom-field filters now accept the same `op:value` grammar as date columns: `ge:` / `gt:` / `le:` / `lt:` / `eq:` / `ne:` / `between:v1,v2` (inclusive) / `notBetween:v1,v2` / `isNull` / `isNotNull` (case-insensitive). A bare value remains exact match (May 27 2026, #24851). No client shape change — `customFields: { Cost: "ge:100" }` just works now; README's **Numeric custom fields** subsection documents the grammar.

## 0.1.10 — 2026-05-22

- Single-resource write methods on the hot path accept an optional `compact?: boolean`. When true the client appends `?return=compact`; the server skips its post-write reload + render and returns just `{oid, id}` — meaningful network + CPU win for agent / bulk workflows that only need the OID to chain a follow-up call. Methods covered: `createTask`, `createSubtask`, `createTaskRelative`, `updateTask`, `moveTask`, `transferTask`, `approveTask`, `addComment`, `addChatComment`, `updateComment`.
- New exported type `QuireCompactRef` — `{ oid: string; id?: number }`. Return types use a `const Compact extends boolean = false` generic so call sites narrow from the literal: `client.createTask(...)` stays `Promise<QuireTask>`, `client.createTask(..., { compact: true })` becomes `Promise<QuireCompactRef>`. Existing callers are unaffected — the default preserves the pre-0.1.10 return type exactly.
- `approveTask` compact path returns a `QuireCompactRef` of the **task** (not the approval) — matches the server's `compactResponse(oidTask, task.id)` shape verified against approval_api.dart.

## 0.1.9 — 2026-05-22

- Bulk task endpoints accept a new `dryRun?: boolean` option — `bulkCreateTasks`, `bulkCreateSubtasks`, `bulkUpdateTasks`, `bulkRemoveTasks`, `bulkMoveTasks`, `bulkTransferTasks`, `bulkApproveTasks`. Forwarded as `?dry-run=true`. The server runs the full operation in a transaction (auth, permission, FK, business rules) and rolls back before responding, so the result payload mirrors the real call's shape — a successful dry-run signals that resubmitting without the flag is likely to succeed. Race conditions and quota consumption between calls aren't pre-checked. Per-item rate-limit cost still applies to dry-runs.
- `getRateLimit` now hits the renamed `/rate-limit/{orgOid}` path. The underscore form (`/rate_limit`) is deprecated server-side but still accepted, so older clients keep working — bump to 0.1.9 to track the canonical URL.
- No client change for the Storage API rate-limit retiering shipped the same day; Storage endpoints aren't part of this package.

## 0.1.8 — 2026-05-15

- `sendNotification` now accepts an optional `recipients?: string[]` field, matching the server change shipped 2026-05-15. Each entry is a user OID, ID, or email; the server's eligibility set is the authorizing user plus colleagues visible to the app (per `GET /user/list`). Special value `["*"]` (must be the sole entry) broadcasts to every visible user; mixing `*` with other entries returns 400. Unknown or invisible recipients return 404 with an identical response for every case, so the endpoint can't be used to probe user existence. Rate-limit cost: every 10 delivered recipients counts as 1 unit (rounded up, minimum 1 per call); over-budget calls get 429 with no partial delivery. Omitting `recipients` preserves the previous self-only behavior.
- No client change for the Storage API rate-limit retiering shipped the same day — Storage endpoints aren't part of this package, but be aware that storage-using callers now share their org's standard per-minute / per-hour bucket instead of a flat 200/min, 3000/hr per-OApp cap.

## 0.1.7 — 2026-05-11

- Export `QuireMyTasksScope` and `QuireMyTasksFilter` from the package barrel. 0.1.6 added the types to `src/client.ts` but forgot the `src/index.ts` re-export, so `import type { QuireMyTasksScope } from "@quire-io/api-client"` failed with TS2305. 0.1.7 is the first 0.1.x release on npm; 0.1.6 was tagged on GitHub but never published.

## 0.1.6 — 2026-05-11

- `QuireClient.getMyTasks(scope, filter?)` — composite helper that returns the [My Tasks view](https://github.com/quire-io/quire-platform-docs/blob/main/product/features/view.md#my-tasks) by leaning on the server's `mine=true` predicate. Three scopes: `{ project }` (free plan; pass `project: "-"` for the user's private Inbox), `{ organization }` (paid plan), or `{ allOrganizations: true, inbox? }` (fan out across every org the user belongs to, dedupe by OID, include Inbox by default). The Inbox path intentionally omits `mine=true` — the server resolves `-` to the inbox project then applies the project-member predicate, which drops undated self-created Inbox captures.
- New exported types `QuireMyTasksScope` (discriminated union of the three scopes) and `QuireMyTasksFilter` (`QuireTaskSearchParams` minus `mine` / `assignee` / `assignor` / `follower` / `createdBy` — fields that would conflict with the My Tasks predicate).

## 0.1.5 — 2026-05-09

- Formula evaluator: duration literals (`MM:SS`, `HH:MM:SS`), arithmetic (`dur + dur`, `dur * num`, `num * dur`, `dur / num`, `num / dur`, `dur - dur`, `date + dur`, `date - dur`, `date - date → dur`), and member access (`.days`, `.hours`, `.minutes`, `.seconds`).
- Formula evaluator: date member access (`.year`, `.month`, `.day`, `.hour`, `.minute`, `.second`).
- Formula evaluator: `<now>` date literal evaluates to current `Date`.
- Formula evaluator: `WORKDAYS(date1, date2[, mode])` function. Mode follows Excel WORKDAY.INTL conventions for two-day weekends (1–7) and Quire's shifted single-day weekend codes (9–15, where 9 = Sun-only).
- `SUM` / `AVG` / `MIN` / `MAX` accept duration arguments and return `QureDuration` when any input is a duration.
- New public class `QureDuration` (added to `FormulaValue` union).

## 0.1.4 — 2026-05-09

- Formula evaluation engine (`evaluateFormula`, `evaluateTaskFormulaFields`) — client-side evaluator for the Quire formula language: arithmetic, comparison, logical and string operators, ternary, `where`/`map`/`order by`/`limit`, and aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `SORT`, `DISTINCT`, `ISEMPTY`, `ISNOTEMPTY`, `WORKDAYS`). Full null-propagation semantics matching the server implementation.
- `flattenTaskTree(nodes)` — flatten a `QuireTaskNode[]` export tree into a `QuireTask[]` for formula evaluation.
- `parseExportJson(raw)` — parse the raw string returned by `exportProjectJson` and return a flat `QuireTask[]`.
- `loadProjectTasksForFormula(client, projectOid)` — tiered loader: tries the full export endpoint first (paid plan), falls back to the flat task-list endpoint on any error. Returns `{ tasks, via }` where `via` is `"export"` or `"list"`.
- `FormulaContext`, `FormulaValue`, `FormulaTasksResult` type exports.

## 0.1.3 — 2026-05-08

- `QuireClientOptions.headers` — optional `Record<string, string>` merged into every outgoing request before per-request headers. Callers use this to inject `User-Agent`, `X-Request-ID`, or other global headers without patching each call site.

## 0.1.2 — 2026-05-07

- `QuireClient.exportProjectCsv(projectOid)` / `exportProjectCsvById(projectId)` / `exportProjectJson(projectOid)` / `exportProjectJsonById(projectId)` — wrap `GET /api/project/export-csv/*` and `/api/project/export-json/*`. Each returns the raw response body as a string (CSV text or JSON dump) so callers can stream straight to disk; pass through `JSON.parse` if you want the parsed object.

## 0.1.1 — 2026-05-07

- `QuireClient.sendNotification({ message, url? })` — wraps `POST /api/notification`. Fires an in-app notification to the calling user. Requires the `share` OAuth scope.

## 0.1.0 — 2026-05-06

Initial release.

### Public API

- `QuireClient` — authenticated wrapper around the Quire REST API. Constructor takes a single opts object: `{ tokens, apiServer, logger?, refreshTokens?, onTokenRefresh?, onAuthRevoked? }`.
- `exchangeCode({ apiServer, clientId, clientSecret?, code, redirectUri, codeVerifier? })` — supports both confidential and public-PKCE OAuth grants.
- `refreshTokens({ apiServer, clientId, clientSecret?, refreshToken })` — same shape, for the refresh-token grant.
- `QuireAuthRevokedError`, `QuireTokenRefreshError`, `formatQuireError`.
- `parseQuireUrl`, `looksLikeOid`, `resolveColor`, `COLOR_TABLE`, `NAMED_COLORS`.
- Type definitions for every Quire resource (`QuireTask`, `QuireProject`, `QuireOrganization`, `QuireUser`, `QuireRecurrence`, etc.).

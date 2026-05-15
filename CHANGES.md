# Changelog

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

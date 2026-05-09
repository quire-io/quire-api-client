# Changelog

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

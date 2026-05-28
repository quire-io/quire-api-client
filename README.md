# @quire-io/api-client

A TypeScript client for the [Quire](https://quire.io) [REST API](https://quire.io/dev/api/).

Typed wrappers around `fetch`, OAuth helpers, and error-formatting utilities for the Quire API. Used by the [Quire CLI](https://github.com/quire-io/quire-cli) and other Node-based Quire integrations.

> **Status:** v0.1.x is the initial extraction. Expect minor breaking changes before 1.0.

## Install

```bash
npm install @quire-io/api-client
```

Requires Node.js 20+.

## What's in the box

| Module | Exports |
|---|---|
| `QuireClient` | Authenticated client covering tasks, projects, organizations, comments, chats, documents, insights, partners, sublists, statuses, tags, custom fields, attachments, timelogs, approvals, undo. Auto-refreshes tokens via a caller-supplied callback. See [COVERAGE.md](COVERAGE.md) for the full per-endpoint table. |
| `exchangeCode` / `refreshTokens` | Parametrized OAuth helpers. Supports both confidential clients (pass `clientSecret`) and public PKCE clients (pass `codeVerifier`). |
| `formatQuireError` | Maps an HTTP error response into a short, user-readable string. Knows about Quire's quota / rate-limit / paid-plan signals. |
| `QuireAuthRevokedError`, `QuireTokenRefreshError` | Typed errors thrown by `QuireClient` and the OAuth helpers. |
| `parseQuireUrl` | Parses a `quire.io` URL into a `{ kind, ... }` descriptor. |
| `looksLikeOid` | Distinguishes a 24-char Quire OID from a slug / numeric id. |
| `resolveColor`, `COLOR_TABLE`, `NAMED_COLORS` | Quire's fixed icon-color palette + friendly name lookup. |
| Type definitions | `QuireTask`, `QuireProject`, `QuireOrganization`, `QuireUser`, `QuireRecurrence`, etc. |

## Usage

Register an OAuth client and look up scopes / endpoints in the [Quire API docs](https://quire.io/dev/api/).

### Confidential client (e.g. server-side OAuth)

```ts
import {
  QuireClient,
  exchangeCode,
  refreshTokens,
} from "@quire-io/api-client";

const tokens = await exchangeCode({
  apiServer: "https://quire.io",
  clientId: process.env.QUIRE_CLIENT_ID!,
  clientSecret: process.env.QUIRE_CLIENT_SECRET!,
  code,
  redirectUri: "https://your.app/callback",
});

const client = new QuireClient({
  tokens,
  apiServer: "https://quire.io",
  refreshTokens: (refreshToken) =>
    refreshTokens({
      apiServer: "https://quire.io",
      clientId: process.env.QUIRE_CLIENT_ID!,
      clientSecret: process.env.QUIRE_CLIENT_SECRET!,
      refreshToken,
    }),
  onTokenRefresh: async (newTokens) => {
    await db.saveTokens(userId, newTokens);
  },
});

const me = await client.getMe();
```

### Public PKCE client (e.g. CLI / installed app)

```ts
import {
  QuireClient,
  exchangeCode,
  refreshTokens,
} from "@quire-io/api-client";

// During login: PKCE code_verifier is generated alongside code_challenge
// and stored in memory until the redirect comes back.
const tokens = await exchangeCode({
  apiServer: "https://quire.io",
  clientId: "your-cli-public-client-id",
  code,
  redirectUri: "http://127.0.0.1:54321/callback",
  codeVerifier,
});

const client = new QuireClient({
  tokens,
  apiServer: "https://quire.io",
  refreshTokens: (refreshToken) =>
    refreshTokens({
      apiServer: "https://quire.io",
      clientId: "your-cli-public-client-id",
      refreshToken,
    }),
  onTokenRefresh: async (newTokens) => {
    await fs.writeFile(credPath, JSON.stringify(newTokens), { mode: 0o600 });
  },
});
```

### Logger

`QuireClient` is silent by default. Pass a `logger` to surface API errors:

```ts
new QuireClient({
  tokens,
  apiServer: "https://quire.io",
  logger: {
    error: (msg, ctx) => console.error(msg, ctx),
    info: (msg, ctx) => console.log(msg, ctx),
  },
});
```

The logger interface is `{ error, info, debug?, warn? }` — any structural match works.

## Search filters

`searchTasks` (project), `searchTasksInOrganization`, and `searchTasksInFolder` all accept the same `QuireTaskSearchParams` shape. See the [interface in `src/client.ts`](src/client.ts#L90-L152) for the full field list and per-field JSDoc; this section covers the grammar shared across many fields.

### Boolean grammar (user / tag / priority / type / createdBy / recurring)

`assignee`, `assignor`, `follower`, `createdBy`, `tag`, `priority`, `type`, `recurring` all share the same grammar:

| Token | Meaning |
|---|---|
| `,` | AND |
| `\|` | OR |
| `!` | NOT |

Values pass through verbatim — the server parses. Quote names containing spaces or special characters: `tag: '"In Progress"'`.

### Date columns

`created`, `edited`, `archived`, `unarchived`, `toggled`, `start`, `due` accept three operand styles:

| Style | Example | Notes |
|---|---|---|
| Keyword | `due: "today"` | `past`, `yesterday`, `today`, `tomorrow`, `upcoming`, `last7d`, `next7d`, `lastWeek`, `thisWeek`, `nextWeek` — timezone is the caller's. |
| `op:value` | `created: "ge:2026-01-01T00:00:00Z"` | Ops: `ge`, `gt`, `le`, `lt`, `eq`, `ne`, `between`, `notBetween`. Operand is ISO 8601; `between` / `notBetween` are inclusive on both ends. |
| Null | `archived: "isNull"` | `isNull` / `isNotNull`, nullable fields only. |

`start` and `due` additionally accept a date-only operand (`YYYY-MM-DD`) that expands to a whole-day window in the caller's timezone.

### Numeric custom fields (May 27 2026)

Number / Money / Duration custom fields accept the **same `op:value` grammar** as date columns — `ge:` / `gt:` / `le:` / `lt:` / `eq:` / `ne:` / `between:v1,v2` (inclusive) / `notBetween:v1,v2` / `isNull` / `isNotNull` (case-insensitive). A bare value is exact match (equivalent to `eq:`). Duration operands use the same `8h` / `30m` shape as the `modified` interval.

```ts
await client.searchTasks(projectOid, {
  customFields: {
    Cost: "ge:100",                 // Money: ≥ 100
    Score: "between:50,150",         // Number: 50 ≤ x ≤ 150
    Effort: "between:8h,40h",        // Duration: 8h ≤ x ≤ 40h
  },
});
```

Other custom-field types are exact match — `Email` / `Hyperlink` also accept `~` / `~*` prefix for regex; `Text` custom fields aren't searchable here (use the top-level `text` parameter for full-text search).

### Scope restrictions

`sublist` and `customFields` are **project-scope only** — the org and folder endpoints reject them with `Unsupported query parameter`.

### Pagination

Pair `limit` (integer, or `"no"` for unlimited; free-plan cap is 30) with `cursor`. The last item of each page carries a `cursor` field; pass it as the next request's `cursor` (with the same `limit` and filters) to fetch the next page. The absence of `cursor` on the final item signals end of stream. `cursor` cannot combine with `sublist` (400).

### Examples

Mixed filters — boolean grammar, date range, pagination cap:

```ts
const tasks = await client.searchTasks(projectOid, {
  status: "active",
  tag: '"In Progress",urgent',         // (In Progress) AND urgent
  assignee: `${me.oid}|${teammate.oid}`, // me OR teammate
  due: "between:2026-05-01,2026-05-31",
  priority: "high|urgent",
  limit: 50,
});
```

Recently modified (any edit, comment, status flip, etc.) — use the `modified` interval, **not** a date column:

```ts
const recent = await client.searchTasks(projectOid, {
  modified: "7d",        // "24h" / "30m" also valid; default is "7d"
  status: "active",
  limit: 50,
});
```

`modified` defaults to `"7d"` if omitted; pass `modified: false` to search the full history. The response isn't sorted by modified time — sort client-side on `QuireTask.modified` if you need most-recent-first.

## Errors

| Class | Thrown when |
|---|---|
| `QuireAuthRevokedError` | The user's grant was revoked or expired past the refresh window. The caller should clear stored tokens and prompt the user to re-authorize. |
| `QuireTokenRefreshError` | A token refresh failed with a specific HTTP status. 4xx → grant is dead (the client converts these to `QuireAuthRevokedError` automatically); 5xx → transient, callers may retry. |
| `Error` (with formatted message) | Any other Quire API failure — body is run through `formatQuireError` so it stays compact and consumer-friendly. |

## Development

```bash
npm install
npm test            # offline / mocked unit tests (CI-default)
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm run gen-coverage  # regenerate COVERAGE.md from src/client.ts
```

### Live API tests

A separate, **opt-in** suite under [`tests/live/`](tests/live/) exercises
`QuireClient` against the real Quire API. It's gated on a configured env
file (see [tests/live/README.md](tests/live/README.md) for setup) and never
runs during `npm test`.

```bash
npm run test:live:prepare   # one-time OAuth bootstrap → writes tokens to ~/.config/quire/test-api.env
npm run test:live           # run the full live-API suite
```

## License

[MIT](LICENSE) © Potix Corporation

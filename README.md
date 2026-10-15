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
| `QuireClient` | Authenticated client covering tasks, projects, organizations, comments, chats, documents, insights, dashboards, reminders, partners, sublists, statuses, tags, custom fields, attachments, timelogs, approvals, undo. Auto-refreshes tokens via a caller-supplied callback. See [COVERAGE.md](COVERAGE.md) for the full per-endpoint table. |
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

## Followers

Follower fields share one value grammar everywhere they appear: a user **OID, ID, or email**, plus these special values:

| Value | Meaning |
|---|---|
| `"me"` | The authenticated user |
| `"app"` | The application itself (receives hook notifications) |
| `"app\|team"`, `"app\|team\|channel"` | App follower routed to a team / channel |
| `"app\|/path"` | Appended to the registered hook URL — hook `https://super.app/hooks/standard` + `"app\|/soc1/33456/a7"` → `https://super.app/hooks/standard/soc1/33456/a7` |
| `"inherit"` | **Tasks only.** On add: pull in the parent task's followers. On remove: drop the ones inherited from the parent. |

Three field shapes, all optional and independent:

- `followers` — replaces the entire list.
- `addFollowers` / `removeFollowers` — edit in place, leaving the rest alone.

| Method | `followers` | `addFollowers` / `removeFollowers` |
|---|---|---|
| `createTask` / `createSubtask` / `createTaskRelative` | ✅ | — (create has no list to diff) |
| `updateTask` | ✅ | ✅ |
| `bulkCreateTasks` / `bulkCreateSubtasks` / `bulkUpdateTasks` | ✅ | ✅ (update only — items are pass-through `Record<string, unknown>`) |
| `updateProject` | ✅ | ✅ |
| `updateOrganization` | ✅ | ✅ |
| `createChat` / `createDocument` | ✅ | — |
| `updateChat` / `updateDocument` | ✅ | ✅ |

```ts
// Follow a task as the current user, and route notifications to the app.
await client.updateTask(taskOid, { addFollowers: ["me", "app|eng|alerts"] });

// Stop following, but leave everyone else alone.
await client.updateTask(taskOid, { removeFollowers: ["me"] });

// Pin the list to exactly these two.
await client.updateTask(taskOid, { followers: [aliceOid, "bob@example.com"] });
```

Notes:

- The creating user is added as a follower automatically by `createTask` — passing `followers` at creation adds to that, it doesn't replace it.
- Responses carry followers back as objects (`{ oid, id, name }[]`) on `QuireTask.followers`, `QuireProject.followers`, `QuireOrganization.followers`, `QuireChat.followers`, `QuireDocument.followers` — not as the string refs you sent.
- Documents are followable only when **project-owned**; sending follower fields for other owner types returns `400`.
- `searchTasks` has a separate read-side `follower` filter — see [Search filters](#search-filters).

## Record visibility (`members`, `private`)

Sublists, documents, chat channels, insights, dashboards and reminders take an optional `members` list at creation, which decides who can see the record. It is a tri-state, and all three states come back explicitly so they can be told apart:

| Sent | Meaning | Returned as |
|---|---|---|
| omitted, or `null` | Every member of the owner (the default) | `null` |
| `[]` | The owner's admins only | `[]` |
| `["me", "bob@example.com"]` | Only those users | list of user objects |

```ts
const mine = await client.createSublist("project", projectOid, {
  name: "Q3 planning",
  members: ["me"],          // only you
});
```

Rules worth knowing before you send it:

- **Create-only.** There is no way to change `members` afterwards — recreate the record.
- Every listed user must already be a member of the owner, and a non-empty list **must include you**. A non-member is rejected with `400` rather than being dropped silently the way a task's `assignees` are.
- `members` cannot be combined with `partner` — that already shares the record with the whole project and the external team. The pair is `400`.
- Responses return `members` as user objects (`{ oid, id, name }`), matching `followers` and `mutes`. Before the Sep 21 2026 server release it was a list of OID strings.

### Hiding from guests and public visitors (`private`)

Sublists, documents, chat channels, insights and dashboards also take `private`, which hides the record from guests and from the visitors of a public project or of a share link — the same switch a custom field has. It is a choice only while every member can see the record (`members` is `null` and there is no `partner`):

```ts
await client.createDocument("project", projectOid, { name: "Salaries", private: true });
await client.updateDocument(docOid, { private: false });   // guests can see it again
```

- Defaults to `false`, and unlike `members` it **can be changed** afterwards with the `update*` methods.
- It is returned only while it is a choice. A record with `members` or a `partner` is always hidden from guests and visitors, so `private` is absent from its response, `true` is accepted as a no-op, and `false` is `400`.
- Reminders don't have it.

## Reminders

A reminder notifies the people it names, either before a task's start/due date or at a time of its own. Unlike every other work endpoint, **`ownerType` is always required** — there is no implied `project`.

```ts
// Standalone reminder on a project
await client.createReminder("project", projectOid, {
  when: "2027-01-15T09:00:00.000Z",
  leads: [{ minutes: 30 }, { days: 1, at: "09:00" }],
});

// Personal reminder in your own inbox
await client.createReminder("project", "-", { when: "2027-01-15T09:00:00.000Z" });

// On a task that already has a start or due date — send `leads` alone
await client.createReminder("task", taskOid, { leads: [{ days: 1 }] });
```

What it fires from depends on the task:

- Task **with** a start or due date → it fires from that date. Sending `when` or `recurrence` is rejected with `400`, because they would be ignored.
- No task, or a task with **neither** date → `when` is required.

`leads` says when to notify ahead of the fire time, one notification each. Each entry names exactly one of `minutes` (an absolute offset) or `days` (calendar days, so it keeps its wall-clock time across a daylight-saving change); `at` (`"HH:mm"`) is only valid with `days` and is read in the creating member's timezone. Omitting `leads` means a single notification at the fire time (`[{ minutes: 0 }]`). Max 30 leads, none negative or beyond 10,000 days.

Listing is by owner, and a project's list includes the reminders on its tasks — narrow it by passing `"task"`:

```ts
await client.listReminders("project", projectOid);        // project + its tasks'
await client.listReminders("task", taskOid);              // just this task's
await client.listReminders("project", projectOid, { limit: 100 });
```

Reminders are ordered by `oid` — stable, but **not** chronological, so sort client-side on the field you care about. With a numeric `limit`, the last item of a page carries a `cursor` when more remain.

`deleteReminder` is **permanent**: a reminder is not moved to the trash and cannot be restored, so there is no undo-remove for it.

## Comment reactions

A comment — on a task or in a chat — carries its emoji reactions as `emojis`: each an `emoji` and the `users` who reacted with it, in the order the apps show them. The field is omitted when there are none.

```ts
await client.addCommentEmojis(commentOid, ["+1", "tada"]);   // 👍 🎉
await client.removeCommentEmojis(commentOid, ["👍"]);

const { emojis } = await client.getComment(commentOid);
// [{ emoji: "🎉", users: [{ oid, id, name }] }]
```

- Give an emoji as itself or by its GitHub / Slack shortcode, with or without colons and in any case — `"+1"`, `":thumbsup:"` and `"👍"` are the same. Names are the safer choice from scripts: no look-alike characters or missing variation selectors. Responses always return the emoji itself. The full list is in Quire's [Emojis](https://quire.io/dev/api/#emojis) reference.
- **Add accepts only the 20 emojis Quire's reaction picker offers.** One invalid emoji rejects the whole call with `400` and nothing is written. Remove accepts any value, so a reaction with an emoji the picker no longer offers can still be removed.
- Both are idempotent and resolve to nothing — read the comment back for the result. At most 20 distinct emojis per call.
- A reaction always belongs to the authorizing user, never the app. The comment's author is notified of each one added.
- `addCommentEmojis` on a missing or deleted comment is `404`; `removeCommentEmojis` is a silent no-op, like every delete.
- The client doesn't validate emojis itself — the server's `400` names the one it rejected. It only refuses an empty list.

## Errors

| Class | Thrown when |
|---|---|
| `QuireAuthRevokedError` | The user's grant was revoked or expired past the refresh window. The caller should clear stored tokens and prompt the user to re-authorize. |
| `QuireTokenRefreshError` | A token refresh failed with a specific HTTP status. 4xx → grant is dead (the client converts these to `QuireAuthRevokedError` automatically); 5xx → transient, callers may retry. |
| `Error` (with formatted message) | Any other Quire API failure — body is run through `formatQuireError` so it stays compact and consumer-friendly. |

Since the Sep 21 2026 server release the HTTP status carries the category and the JSON body's `code` the specific cause. `formatQuireError` maps them to distinct messages, because the recovery differs:

| Status + body `code` | Meaning | What helps |
|---|---|---|
| `402` + `469` | Plan limit or quota (tasks, custom fields, dashboard, insight, sublist, chat, doc) | Upgrading. Retrying never does. |
| `402` + `470` | Subscription **expired** | Resubscribing — no in-plan upgrade clears it |
| `403` + `471` | Account temporarily blocked | Waiting, or contacting Quire |
| `429` | The per-minute / per-hour API rate limit, and only this | Backing off; always carries `Retry-After` |
| `400` + `400` | Validation (missing name, duplicate or reserved id) | Fixing the request |

Before that release, plan limits and expired subscriptions both came back as `429`, which invited callers to back off and retry a condition that only upgrading could clear. The body-`code` checks are status-independent, so a client pointed at an older server still gets the right message.

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

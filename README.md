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
| `QuireClient` | Authenticated client covering tasks, projects, organizations, comments, chats, documents, insights, partners, sublists, statuses, tags, custom fields, attachments, timelogs, approvals, undo. Auto-refreshes tokens via a caller-supplied callback. |
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

## Errors

| Class | Thrown when |
|---|---|
| `QuireAuthRevokedError` | The user's grant was revoked or expired past the refresh window. The caller should clear stored tokens and prompt the user to re-authorize. |
| `QuireTokenRefreshError` | A token refresh failed with a specific HTTP status. 4xx → grant is dead (the client converts these to `QuireAuthRevokedError` automatically); 5xx → transient, callers may retry. |
| `Error` (with formatted message) | Any other Quire API failure — body is run through `formatQuireError` so it stays compact and consumer-friendly. |

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
```

## License

[MIT](LICENSE) © Potix Corporation

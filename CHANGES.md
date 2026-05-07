# Changelog

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

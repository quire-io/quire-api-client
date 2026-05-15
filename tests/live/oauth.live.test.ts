/**
 * Live API tests for /oauth/token refresh (OA1, OA2).
 *
 * Quire refresh tokens are NOT rotated — the same one can be used
 * repeatedly. Re-running this suite back-to-back is safe.
 *
 * Uses the public `refreshTokens` helper (the same one production callers
 * pass into `QuireClient`) instead of going through helpers' rawApi —
 * exercises the OAuth helper too. For the bogus-token case the helper
 * throws `QuireTokenRefreshError`, which carries the HTTP status.
 */

import { describe, it, expect } from "vitest";
import {
  refreshTokens,
  QuireTokenRefreshError,
} from "../../src/index.js";
import { hasTokens, readEnv } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /oauth/token", () => {
  const apiServer = readEnv("QUIRE_API_SERVER");
  const clientId = readEnv("QUIRE_CLIENT_ID");
  const clientSecret = readEnv("QUIRE_CLIENT_SECRET");

  it("OA1 refreshTokens issues a fresh access token", async () => {
    const tokens = await refreshTokens({
      apiServer,
      clientId,
      clientSecret,
      refreshToken: readEnv("QUIRE_TEST_REFRESH_TOKEN"),
    });
    expect(typeof tokens.accessToken).toBe("string");
    expect(tokens.accessToken.length).toBeGreaterThan(0);
    expect(typeof tokens.refreshToken).toBe("string");
    expect(typeof tokens.expiresAt).toBe("number");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("OA2 refreshTokens rejects a bogus refresh_token with a 4xx", async () => {
    let caught: unknown;
    try {
      await refreshTokens({
        apiServer,
        clientId,
        clientSecret,
        refreshToken: "not-a-real-refresh-token",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuireTokenRefreshError);
    const e = caught as QuireTokenRefreshError;
    expect(e.status).toBeGreaterThanOrEqual(400);
    expect(e.status).toBeLessThan(500);
  });
});

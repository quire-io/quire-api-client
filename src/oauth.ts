/**
 * Quire OAuth helpers.
 *
 * Parametrized so the same two functions cover both confidential clients
 * (server-side, send `clientSecret`) and public PKCE clients (CLI /
 * installed apps, send `codeVerifier` and omit `clientSecret`). Pure
 * `fetch` calls — no env reads, no module-level state.
 */

import { QuireTokenRefreshError } from "./errors.js";
import type { QuireTokens } from "./types.js";

export interface ExchangeCodeOptions {
  /** Quire host, e.g. `https://quire.io`. No trailing slash. */
  apiServer: string;
  /** OAuth client_id. */
  clientId: string;
  /**
   * OAuth client_secret. Required for confidential clients; omit for
   * public PKCE clients (and pass `codeVerifier` instead).
   */
  clientSecret?: string;
  /** The `code` from the authorization redirect. */
  code: string;
  /** Must match the redirect_uri used in the authorization request. */
  redirectUri: string;
  /**
   * PKCE code_verifier (RFC 7636). Required for public clients; the
   * `code_challenge` sent in the authorize step is `base64url(sha256(code_verifier))`.
   */
  codeVerifier?: string;
}

export interface RefreshTokensOptions {
  apiServer: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

/**
 * Exchange an authorization code for Quire access + refresh tokens.
 * Throws on a non-2xx response (with the body included in the message
 * for diagnostics).
 */
export async function exchangeCode(
  options: ExchangeCodeOptions,
): Promise<QuireTokens> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
  };
  if (options.clientSecret !== undefined) {
    params.client_secret = options.clientSecret;
  }
  if (options.codeVerifier !== undefined) {
    params.code_verifier = options.codeVerifier;
  }

  const res = await fetch(
    `${options.apiServer.replace(/\/+$/, "")}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quire token exchange failed: ${res.status} ${body}`);
  }

  return parseTokenResponse(res);
}

/**
 * Refresh a Quire access token using a refresh token. Throws
 * `QuireTokenRefreshError` (with the HTTP status) on failure so callers
 * can distinguish dead grants (4xx) from transient outages (5xx).
 */
export async function refreshTokens(
  options: RefreshTokensOptions,
): Promise<QuireTokens> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  };
  if (options.clientSecret !== undefined) {
    params.client_secret = options.clientSecret;
  }

  const res = await fetch(
    `${options.apiServer.replace(/\/+$/, "")}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    },
  );

  if (!res.ok) {
    throw new QuireTokenRefreshError(res.status);
  }

  return parseTokenResponse(res);
}

async function parseTokenResponse(res: Response): Promise<QuireTokens> {
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

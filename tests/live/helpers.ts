/**
 * Plumbing for the live-API integration tests.
 *
 * Reads the test bearer token from a `.env` file directly (not `process.env`)
 * so vitest's own `test.env` mocking can't shadow real tokens.
 *
 * Resolution order:
 *   1. `tests/live/.env` inside the current checkout (local opt-out)
 *   2. `~/.config/quire/test-api.env` (canonical — shared across worktrees)
 *   3. `~/.config/quire-mcp/test-api.env` (transitional fallback)
 *
 * The file is gitignored. See tests/live/README.md for setup.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { QuireClient, refreshTokens } from "../../src/index.js";

const LOCAL_ENV = resolve("tests/live/.env");
const HOME_ENV_NEW = resolve(homedir(), ".config/quire/test-api.env");
const HOME_ENV_LEGACY = resolve(homedir(), ".config/quire-mcp/test-api.env");

function resolveEnvPath(): string {
  if (existsSync(LOCAL_ENV)) return LOCAL_ENV;
  if (existsSync(HOME_ENV_NEW)) return HOME_ENV_NEW;
  return HOME_ENV_LEGACY;
}

export const ENV_PATH = resolveEnvPath();

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

let envCache: Record<string, string> | null = null;
export function env(): Record<string, string> {
  if (envCache) return envCache;
  try {
    envCache = parseDotenv(readFileSync(ENV_PATH, "utf8"));
  } catch {
    envCache = {};
  }
  return envCache;
}

export const hasTokens = !!env().QUIRE_TEST_ACCESS_TOKEN;

export function readEnv(name: string): string {
  const v = env()[name];
  if (!v) {
    throw new Error(
      `Missing ${name} in ${ENV_PATH} — run: npm run test:live:prepare`,
    );
  }
  return v;
}

export function readEnvOptional(name: string): string | undefined {
  return env()[name] || undefined;
}

/**
 * Returns the access token QuireClient is currently using — post-refresh if
 * any client method has fired in this file, env-file value otherwise. Use
 * this for raw `fetch(...)` calls inside tests (e.g. RL1's burst probe) so
 * they don't read a token that the client has already rotated past.
 */
export function currentToken(): string {
  return currentAccessToken ?? env().QUIRE_TEST_ACCESS_TOKEN ?? "";
}

// Module-local cache of the latest access token. Starts from the env file;
// updated whenever QuireClient refreshes (its 5-min pre-emptive window or a
// 401 retry both rotate it). rawApi reads from this so it stays in sync with
// the client — otherwise rawApi would hit a 401 immediately after any
// client-driven refresh, because Quire invalidates the old token on rotate.
let currentAccessToken: string | undefined;

let cachedClient: QuireClient | undefined;

// Construct a QuireClient bound to the test tokens, with auto-refresh wired
// up. Access tokens expire in ~1 hour; refresh tokens are long-lived and
// don't rotate (Quire returns the same refresh_token on each refresh), so
// the same env file keeps working across many test runs without manual
// intervention. `expiresAt` is set to "now" so the client refreshes
// proactively on the first call — the access token in the env file may
// already be stale by the time we read it.
//
// Cached per-module so every describe in a test file shares one client and
// one refresh cycle — and so onTokenRefresh's update of currentAccessToken
// is visible to rawApi from anywhere in the file.
export function liveClient(): QuireClient {
  if (cachedClient) return cachedClient;

  const apiServer = readEnv("QUIRE_API_SERVER");
  const clientId = readEnv("QUIRE_CLIENT_ID");
  const clientSecret = readEnvOptional("QUIRE_CLIENT_SECRET");
  cachedClient = new QuireClient({
    apiServer,
    tokens: {
      accessToken: readEnv("QUIRE_TEST_ACCESS_TOKEN"),
      refreshToken: readEnv("QUIRE_TEST_REFRESH_TOKEN"),
      // Use the prepare-script's recorded expiry if available; default to
      // "now" so the client refreshes proactively on the first call.
      expiresAt: Number(readEnvOptional("QUIRE_TEST_EXPIRES_AT")) || Date.now(),
    },
    refreshTokens: (refreshToken) =>
      refreshTokens({ apiServer, clientId, clientSecret, refreshToken }),
    onTokenRefresh: async (tokens) => {
      currentAccessToken = tokens.accessToken;
    },
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Raw escape hatch for contract probes — anything QuireClient doesn't (or
// shouldn't) wrap: explicit error-status assertions, path-form variants the
// client deliberately doesn't expose, plan-gated 403 probes, etc.
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function rawRequest<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  token: string | undefined,
): Promise<ApiResult<T>> {
  const base = (env().QUIRE_API_SERVER ?? "").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Quire rate-limits aggressively when the full suite runs. Retry on 429
  // with exponential backoff, honouring Retry-After up to MAX_RETRY_WAIT_MS.
  // Beyond that ceiling the server is telling us "you've exhausted your
  // per-minute / per-hour budget"; sleeping through it is pointless.
  //
  // Quire also wraps `ecQuotaExceeded` (code 469) inside HTTP 429 for some
  // endpoints. That's not a rate-limit — surface the body immediately.
  const MAX_RETRY_WAIT_MS = 60_000;
  let lastStatus = 429;
  let lastData: T = undefined as T;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      data = text as unknown as T;
    }
    if (res.status !== 429) {
      return { status: res.status, data };
    }
    lastStatus = res.status;
    lastData = data;
    if ((data as { code?: unknown } | undefined)?.code === 469) {
      return { status: 429, data };
    }
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    if (retryAfter * 1000 > MAX_RETRY_WAIT_MS) {
      console.warn(
        `[429] ${method} ${path} retry-after=${retryAfter}s exceeds ${MAX_RETRY_WAIT_MS / 1000}s cap — quota-level throttle, not retrying`,
      );
      return { status: 429, data };
    }
    const wait = Math.max(retryAfter * 1000, 500 * Math.pow(2, attempt));
    console.warn(
      `[429] ${method} ${path} retry-after=${retryAfter || "absent"} wait=${wait}ms attempt=${attempt + 1}/8`,
    );
    await sleep(wait);
  }
  return { status: lastStatus, data: lastData };
}

// One-shot client warmup. QuireClient only refreshes its access token when
// one of its own methods is called (the pre-emptive window inside the
// wrapper, or a 401 retry). Tests that call `rawApi` BEFORE any client
// method would otherwise read the env-file token directly — and that token
// is stale by the next-day cadence the live suite typically runs at, so
// rawApi-first tests would 401 even when the refresh token is still valid.
//
// Vitest runs each test file in its own worker, so module state (including
// `cachedClient`) doesn't carry over between files. Files like
// errors.live.test.ts that import only `rawApi`/`rawApiAs` (no liveClient)
// still need their tokens warmed — so this helper lazily constructs a
// client via liveClient() when none exists yet, then triggers a refresh.
//
// Resolved as a shared promise so concurrent first-callers all await the
// same getMe() rather than racing to issue several.
let warmupPromise: Promise<void> | null = null;
async function ensureFreshToken(): Promise<void> {
  if (currentAccessToken) return;
  if (!warmupPromise) {
    const client = cachedClient ?? liveClient();
    warmupPromise = client.getMe().then(
      () => undefined,
      () => undefined,
    );
  }
  await warmupPromise;
}

/**
 * Raw REST call using the same access token QuireClient is currently using.
 *
 * Reads from `currentAccessToken` (set by liveClient's onTokenRefresh hook)
 * with a fallback to the env-file value for tests that haven't touched the
 * client yet. Once any test in the file calls `liveClient()`, every
 * subsequent `rawApi` automatically uses the post-refresh token — otherwise
 * a client-driven refresh would invalidate the env-file token mid-suite and
 * leave rawApi calls 401ing.
 */
export async function rawApi<T = unknown>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  await ensureFreshToken();
  const token = currentAccessToken ?? env().QUIRE_TEST_ACCESS_TOKEN;
  return rawRequest<T>(method, path, body, token);
}

/** Raw call with a caller-supplied (or absent) bearer token — for negative tests. */
export async function rawApiAs<T = unknown>(
  method: HttpMethod,
  path: string,
  body: unknown,
  token: string | undefined,
): Promise<ApiResult<T>> {
  return rawRequest<T>(method, path, body, token);
}

/** Form-encoded call for /oauth/token endpoints. */
export async function oauthTokenRequest(
  form: Record<string, string>,
): Promise<ApiResult<Record<string, unknown>>> {
  const base = (env().QUIRE_API_SERVER ?? "").replace(/\/$/, "");
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/** Raw-body upload — for endpoints whose bodies are file bytes, not JSON. */
export async function rawApiUpload<T = unknown>(
  path: string,
  body: Uint8Array,
  contentType: string,
): Promise<ApiResult<T>> {
  await ensureFreshToken();
  const base = (env().QUIRE_API_SERVER ?? "").replace(/\/$/, "");
  const token = currentAccessToken ?? env().QUIRE_TEST_ACCESS_TOKEN;
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : (undefined as T);
  } catch {
    data = text as unknown as T;
  }
  return { status: res.status, data };
}

/** Unique suffix for resource names so parallel runs don't collide. */
export const runTag = `live-test-${Date.now()}`;

// ---------------------------------------------------------------------------
// 429 retry wrapper for QuireClient methods.
//
// `rawApi` already retries 429s in-band with the server's Retry-After, but
// `QuireClient` throws on any non-2xx — including transient 429s when an
// adjacent test has just burned the minute bucket (e.g. SUB7 burns the free
// org's quota then O5 fires `client.updateOrganization` on the same org).
// Wrap such calls with `retryOn429(() => client.foo(...))` to ride out
// short-lived limiter pressure without polluting the production client with
// retry policy.
//
// Detection is by error-message prefix, not a typed error — QuireClient
// throws a plain Error whose `.message` is the human-formatted string from
// `formatQuireError` in src/errors.ts. Quota-exceeded (code 469) errors get
// a "Quire quota exceeded" prefix instead of "Quire API error 429", so this
// helper correctly skips retrying those.
// ---------------------------------------------------------------------------

function parseRetryAfterSeconds(msg: string): number {
  // formatRetryAfter emits "Ns" for <60s and "Nm" or "Nm Ks" for ≥60s.
  const minutesForm = msg.match(/retry after (\d+)m(?:\s+(\d+)s)?/);
  if (minutesForm) {
    return Number(minutesForm[1]) * 60 + Number(minutesForm[2] ?? 0);
  }
  const secondsForm = msg.match(/retry after (\d+)s/);
  if (secondsForm) return Number(secondsForm[1]);
  // "precise wait time unavailable" — Quire's minute-bucketed limiter
  // clears in ≤60s, but 10s is enough for typical adjacency cases.
  return 10;
}

/**
 * Retry a QuireClient call on 429 ("rate limited") with the server-suggested
 * wait, up to `attempts` times. Re-throws any non-429 error immediately,
 * and stops retrying when the suggested wait would exceed 60s (signals a
 * quota-tier throttle that retrying can't clear).
 */
export async function retryOn429<T>(
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith("Quire API error 429") || i === attempts - 1) {
        throw err;
      }
      const waitSeconds = parseRetryAfterSeconds(msg);
      if (waitSeconds > 60) throw err;
      const waitMs = waitSeconds * 1000;
      console.warn(
        `[retryOn429] 429 hit, waiting ${waitSeconds}s (attempt ${i + 1}/${attempts})`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Unreachable: the loop above either returns or throws on every path.
  throw new Error("retryOn429: exhausted without returning");
}

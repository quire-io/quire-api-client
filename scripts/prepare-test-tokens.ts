/**
 * One-shot OAuth bootstrap for the live-API integration tests.
 *
 *   npm run test:live:prepare
 *
 * Reads QUIRE_API_SERVER / QUIRE_CLIENT_ID / QUIRE_CLIENT_SECRET from the
 * test-api.env file (same file we write the resulting access/refresh tokens
 * to), runs the Quire OAuth authorization-code flow against the configured
 * OAuth app, then updates that same file with the new tokens.
 *
 * Works with either kind of OAuth app:
 *   - Confidential client — set QUIRE_CLIENT_SECRET; the code is exchanged
 *     with `client_secret`.
 *   - Public client (PKCE) — leave QUIRE_CLIENT_SECRET blank or omit it;
 *     the code is exchanged with a `code_verifier` instead (RFC 7636, S256).
 *     This is what the shipped Quire CLI app uses — it has no secret, so the
 *     confidential path 400s against it.
 *
 * Redirect URI: `http://127.0.0.1:<port>/callback`, where the port is
 * whatever the kernel hands us. Quire matches loopback redirects by prefix
 * and ignores the port (RFC 8252 §7.3) — the same thing quire-cli relies on
 * with its own ephemeral port. Set QUIRE_OAUTH_PORT to pin a fixed port if
 * your app registration demands one.
 *
 * Resolution order for the env file (read AND written in the same place):
 *   1. `tests/live/.env` inside the current checkout (local opt-out)
 *   2. `~/.config/quire/test-api.env` (canonical — shared across worktrees)
 *   3. `~/.config/quire-mcp/test-api.env` (transitional fallback)
 *
 * First-time setup: create the file at the canonical home-dir path with
 *   QUIRE_API_SERVER=...
 *   QUIRE_CLIENT_ID=...
 *   QUIRE_CLIENT_SECRET=...   # confidential apps only — omit for PKCE
 * before running this script. Tokens are then written alongside those creds.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// 0 = let the kernel pick a free port, which makes EADDRINUSE unreachable.
// Override only if the OAuth app registration pins a port.
const PORT = Number(process.env.QUIRE_OAUTH_PORT ?? 0);
const DEFAULT_TEST_PROJECT_ID = "Quire_API_Test_Project";

const LOCAL_ENV = path.resolve("tests/live/.env");
const HOME_ENV_NEW = path.resolve(os.homedir(), ".config/quire/test-api.env");
const HOME_ENV_LEGACY = path.resolve(
  os.homedir(),
  ".config/quire-mcp/test-api.env",
);

function resolveEnvPath(): string {
  if (existsSync(LOCAL_ENV)) return LOCAL_ENV;
  if (existsSync(HOME_ENV_NEW)) return HOME_ENV_NEW;
  if (existsSync(HOME_ENV_LEGACY)) return HOME_ENV_LEGACY;
  // No existing file — write to the canonical home path. Maintainer will see
  // the "missing creds" error below and know to seed it once.
  return HOME_ENV_NEW;
}

const ENV_PATH = resolveEnvPath();

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

async function readEnvFile(): Promise<Record<string, string>> {
  try {
    return parseDotenv(await fs.readFile(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

const envFile = await readEnvFile();

// Quire project ids are workspace-globally unique, so a fork can't reuse
// "Quire_API_Test_Project". Honor the env file's slug if set; otherwise fall
// back to the canonical default for first-time setup of the original repo.
const TEST_PROJECT_ID = envFile.QUIRE_TEST_PROJECT_ID || DEFAULT_TEST_PROJECT_ID;

function requireConfig(name: string): string {
  const v = envFile[name];
  if (!v) {
    console.error(
      `✗ Missing ${name} in ${ENV_PATH}.\n` +
        `  Seed the file with QUIRE_API_SERVER and QUIRE_CLIENT_ID from your\n` +
        `  OAuth app, then re-run. Add QUIRE_CLIENT_SECRET only if the app is\n` +
        `  a confidential client — public (PKCE) apps have no secret.`,
    );
    process.exit(1);
  }
  return v;
}

const QUIRE_API_SERVER = requireConfig("QUIRE_API_SERVER").replace(/\/$/, "");
const QUIRE_CLIENT_ID = requireConfig("QUIRE_CLIENT_ID");
// Optional: absent/blank means the app is a public client and we fall back
// to PKCE. requireConfig would hard-exit, so read it directly.
const QUIRE_CLIENT_SECRET = envFile.QUIRE_CLIENT_SECRET ?? "";
const USE_PKCE = !QUIRE_CLIENT_SECRET;

const state = randomBytes(16).toString("hex");
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

function buildAuthUrl(redirectUri: string): string {
  const url = new URL(`${QUIRE_API_SERVER}/oauth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", QUIRE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (USE_PKCE) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  // The redirect_uri here must be byte-identical to the one sent on the
  // authorize leg — that's why it's threaded through rather than rebuilt.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: QUIRE_CLIENT_ID,
    redirect_uri: redirectUri,
  });
  if (USE_PKCE) body.set("code_verifier", codeVerifier);
  else body.set("client_secret", QUIRE_CLIENT_SECRET);

  const res = await fetch(`${QUIRE_API_SERVER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

async function fetchProjectAnchors(
  accessToken: string,
): Promise<{ projectOid: string; orgOid: string }> {
  const res = await fetch(
    `${QUIRE_API_SERVER}/api/project/id/${encodeURIComponent(TEST_PROJECT_ID)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    console.warn(
      `⚠ could not fetch ${TEST_PROJECT_ID} (${res.status}). ` +
        `Fill QUIRE_TEST_PROJECT_OID / QUIRE_TEST_ORG_OID manually in ${ENV_PATH}.`,
    );
    return { projectOid: "", orgOid: "" };
  }
  const data = (await res.json()) as {
    oid?: string;
    organization?: { oid?: string };
  };
  return {
    projectOid: data.oid ?? "",
    orgOid: data.organization?.oid ?? "",
  };
}

async function writeEnvFile(params: {
  access: string;
  refresh: string;
  expiresAt: number;
  projectOid: string;
  orgOid: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(ENV_PATH), { recursive: true });
  const existing = await fs.readFile(ENV_PATH).catch(() => null);
  if (existing) await fs.writeFile(`${ENV_PATH}.bak`, existing);

  // Preserve any extra keys the maintainer added (e.g. FREE/PAID org anchors)
  // by merging on top of the parsed env, then re-emitting in a stable order.
  const merged: Record<string, string> = {
    ...envFile,
    QUIRE_API_SERVER,
    QUIRE_CLIENT_ID,
    QUIRE_CLIENT_SECRET,
    QUIRE_TEST_ACCESS_TOKEN: params.access,
    QUIRE_TEST_REFRESH_TOKEN: params.refresh,
    QUIRE_TEST_EXPIRES_AT: String(params.expiresAt),
    QUIRE_TEST_PROJECT_ID: TEST_PROJECT_ID,
    QUIRE_TEST_PROJECT_OID: params.projectOid,
    QUIRE_TEST_ORG_OID: params.orgOid,
  };
  if (!("QUIRE_TEST_TRANSFER_PROJECT_ID" in merged))
    merged.QUIRE_TEST_TRANSFER_PROJECT_ID = "";
  if (!("QUIRE_TEST_FOLDER_ID" in merged)) merged.QUIRE_TEST_FOLDER_ID = "";
  if (!("QUIRE_TEST_FREE_ORG_ID" in merged)) merged.QUIRE_TEST_FREE_ORG_ID = "";
  if (!("QUIRE_TEST_PAID_ORG_ID" in merged)) merged.QUIRE_TEST_PAID_ORG_ID = "";

  const ordered = [
    "QUIRE_API_SERVER",
    "QUIRE_CLIENT_ID",
    "QUIRE_CLIENT_SECRET",
    "QUIRE_TEST_ACCESS_TOKEN",
    "QUIRE_TEST_REFRESH_TOKEN",
    "QUIRE_TEST_EXPIRES_AT",
    "QUIRE_TEST_PROJECT_ID",
    "QUIRE_TEST_PROJECT_OID",
    "QUIRE_TEST_ORG_OID",
    "QUIRE_TEST_TRANSFER_PROJECT_ID",
    "QUIRE_TEST_FOLDER_ID",
    "QUIRE_TEST_FREE_ORG_ID",
    "QUIRE_TEST_PAID_ORG_ID",
  ];
  const extras = Object.keys(merged).filter((k) => !ordered.includes(k));

  const lines: string[] = [
    "# Generated by scripts/prepare-test-tokens.ts — DO NOT COMMIT.",
  ];
  for (const k of [...ordered, ...extras]) {
    lines.push(`${k}=${merged[k] ?? ""}`);
  }
  lines.push("");
  await fs.writeFile(ENV_PATH, lines.join("\n"));
}

interface Loopback {
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}

// Binds before the authorize URL is built, so an ephemeral port can be
// folded into the redirect_uri. Mirrors quire-cli's src/oauth/loopback.ts.
async function startLoopback(): Promise<Loopback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A listen() failure rejects both this promise and startLoopback's own.
  // main() only ever awaits one of them, so park a no-op handler here to
  // keep the other from surfacing as an unhandled rejection.
  code.catch(() => {});

  // Assigned once the server is bound; the handler only runs after that.
  let boundBase = "http://127.0.0.1";

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, boundBase);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }

    const got = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res
        .writeHead(400, { "Content-Type": "text/plain" })
        .end(`OAuth error: ${error}. You can close this tab.`);
      server.close();
      rejectCode(new Error(error));
      return;
    }
    if (returnedState !== state) {
      res
        .writeHead(400, { "Content-Type": "text/plain" })
        .end("State mismatch — possible CSRF attempt.");
      server.close();
      rejectCode(new Error("state mismatch"));
      return;
    }
    if (!got) {
      res.writeHead(400).end("missing code");
      return;
    }

    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<h2>Token captured — you can close this tab.</h2>");
    server.close();
    resolveCode(got);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      rejectCode(
        new Error(
          `Port ${PORT} is in use — stop whatever is listening on :${PORT}, ` +
            `or unset QUIRE_OAUTH_PORT to use an ephemeral one.`,
        ),
      );
    } else {
      rejectCode(err);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bind the loopback interface only — nothing off-box should reach this.
    server.listen(PORT, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  boundBase = `http://127.0.0.1:${address.port}`;
  return {
    redirectUri: `${boundBase}/callback`,
    code,
    close: () => server.close(),
  };
}

async function main(): Promise<void> {
  const loopback = await startLoopback();
  console.log(
    `\nMode: ${USE_PKCE ? "public client (PKCE)" : "confidential client (secret)"}`,
  );
  console.log(`Listening on ${loopback.redirectUri}`);

  const authUrl = buildAuthUrl(loopback.redirectUri);
  console.log(`\nOpening Quire authorize URL:\n  ${authUrl}\n`);
  console.log("If the browser doesn't open, paste the URL above manually.\n");
  openBrowser(authUrl);

  let code: string;
  try {
    code = await loopback.code;
  } finally {
    loopback.close();
  }
  console.log("✓ Got authorization code, exchanging for tokens…");

  const token = await exchangeCode(code, loopback.redirectUri);
  const expiresAt = Date.now() + token.expires_in * 1000;
  console.log(`✓ Access token valid until ${new Date(expiresAt).toISOString()}`);

  console.log(`Fetching project anchors for ${TEST_PROJECT_ID}…`);
  const { projectOid, orgOid } = await fetchProjectAnchors(token.access_token);
  if (projectOid) console.log(`✓ QUIRE_TEST_PROJECT_OID=${projectOid}`);
  if (orgOid) console.log(`✓ QUIRE_TEST_ORG_OID=${orgOid}`);

  await writeEnvFile({
    access: token.access_token,
    refresh: token.refresh_token,
    expiresAt,
    projectOid,
    orgOid,
  });
  console.log(`\n✓ Wrote ${ENV_PATH}`);
  console.log(`  Next:  npm run test:live`);
}

main().catch((err: Error) => {
  console.error("\n✗ Failed:", err.message ?? err);
  process.exit(1);
});

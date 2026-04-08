// Token storage and refresh for the Codex OAuth provider.
//
// Persistence: a single JSON blob stored under the `CODEX_OAUTH` settings key,
// encrypted at rest via server/lib/crypto.ts (AES-256-GCM).
//
// Refresh: tokens are refreshed transparently when within REFRESH_LEEWAY_MS of
// expiry. Concurrent callers share a single in-flight refresh promise.
//
// Constants are taken from the official `openai/codex` Rust CLI:
//   - codex-rs/login/src/auth/manager.rs:779   pub const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
//   - codex-rs/login/src/auth/manager.rs:85    REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"

import { getSetting, setSetting, deleteSetting } from "@/lib/settings.ts";
import { encrypt, decrypt } from "@/lib/crypto.ts";
import { log } from "@/lib/logger.ts";
import { retryFetch } from "@/lib/providers/middleware.ts";

const tokLog = log.child({ module: "codex-tokens" });

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_SCOPES = "openid profile email offline_access";
export const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_ORIGINATOR = "codex_cli_rs";

const SETTING_KEY = "CODEX_OAUTH";
const REFRESH_LEEWAY_MS = 60_000;

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number; // ms epoch
  accountEmail?: string;
  accountId?: string;
}

let memoCache: CodexTokens | null | undefined = undefined;
let inflightRefresh: Promise<CodexTokens> | null = null;

const tokFetch = retryFetch(fetch);

export async function loadTokens(): Promise<CodexTokens | null> {
  if (memoCache !== undefined) return memoCache;
  const raw = getSetting(SETTING_KEY);
  if (!raw) {
    memoCache = null;
    return null;
  }
  try {
    const decoded = await decrypt(raw);
    memoCache = JSON.parse(decoded) as CodexTokens;
    return memoCache;
  } catch (err) {
    tokLog.error("failed to decrypt CODEX_OAUTH blob", err instanceof Error ? err : undefined);
    memoCache = null;
    return null;
  }
}

export async function saveTokens(t: CodexTokens): Promise<void> {
  const encoded = await encrypt(JSON.stringify(t));
  setSetting(SETTING_KEY, encoded);
  memoCache = t;
}

export function clearTokens(): void {
  deleteSetting(SETTING_KEY);
  memoCache = null;
}

/** Parse `exp` (seconds) and useful claims out of a JWT without verifying signature. */
export function parseJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    return JSON.parse(atob(padded + pad));
  } catch {
    return null;
  }
}

/** Extract email + chatgpt_account_id from an id_token JWT. */
export function extractAccountFromIdToken(idToken: string): { email?: string; accountId?: string } {
  const claims = parseJwtClaims(idToken);
  if (!claims) return {};
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
  const email =
    (typeof claims.email === "string" && claims.email) ||
    (typeof profile.email === "string" && profile.email) ||
    undefined;
  const accountId = typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  return { email: email || undefined, accountId };
}

function expiryFromJwt(accessToken: string, fallbackSeconds: number): number {
  const claims = parseJwtClaims(accessToken);
  const exp = claims && typeof claims.exp === "number" ? claims.exp : 0;
  if (exp > 0) return exp * 1000;
  return Date.now() + fallbackSeconds * 1000;
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Exchange an OAuth authorization code (PKCE) for a token bundle. */
export async function exchangeCodeForTokens(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: args.codeVerifier,
  });
  const res = await tokFetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`codex token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as TokenEndpointResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("codex token exchange returned incomplete tokens");
  }
  const expiresAt = expiryFromJwt(data.access_token, data.expires_in ?? 3600);
  const account = data.id_token ? extractAccountFromIdToken(data.id_token) : {};
  const tokens: CodexTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresAt,
    accountEmail: account.email,
    accountId: account.accountId,
  };
  await saveTokens(tokens);
  return tokens;
}

async function doRefresh(refreshToken: string, prev: CodexTokens): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_SCOPES,
  });
  const res = await tokFetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`codex token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as TokenEndpointResponse;
  if (!data.access_token) throw new Error("codex token refresh returned no access_token");
  const expiresAt = expiryFromJwt(data.access_token, data.expires_in ?? 3600);
  const account = data.id_token ? extractAccountFromIdToken(data.id_token) : {};
  const tokens: CodexTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    idToken: data.id_token ?? prev.idToken,
    expiresAt,
    accountEmail: account.email ?? prev.accountEmail,
    accountId: account.accountId ?? prev.accountId,
  };
  await saveTokens(tokens);
  return tokens;
}

/**
 * Returns valid (non-expired) tokens, refreshing if necessary.
 * Throws if no tokens are stored. Concurrent callers share one refresh.
 */
export async function getValidTokens(force = false): Promise<CodexTokens> {
  const current = await loadTokens();
  if (!current) throw new Error("Codex provider is not connected. Run the OAuth flow first.");
  if (!force && current.expiresAt - Date.now() > REFRESH_LEEWAY_MS) return current;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh(current.refreshToken, current).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export async function getStatus(): Promise<{
  connected: boolean;
  accountEmail?: string;
  expiresAt?: number;
}> {
  const t = await loadTokens();
  if (!t) return { connected: false };
  return { connected: true, accountEmail: t.accountEmail, expiresAt: t.expiresAt };
}

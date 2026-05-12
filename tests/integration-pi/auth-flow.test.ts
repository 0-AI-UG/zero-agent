/**
 * Auth flow — integration coverage.
 *
 * Drives the real auth handlers (login / logout / me) through a Hono app
 * configured exactly like `server/index.ts` (same `checkCsrf` middleware,
 * same `h()` adapter) against a real SQLite database under a temp
 * `DB_PATH`. JWT signing, cookie issuance, CSRF double-submit, and
 * token-version invalidation are all exercised end-to-end.
 *
 * We do NOT import `server/index.ts` directly because importing it spins
 * up a real HTTP listener, scheduler, browser pool, and Telegram poller
 * as a side effect. Instead, we recreate the relevant subset of the
 * route table in this test — the auth handlers and middleware imported
 * here are the same objects that production uses.
 *
 * "Signup" in this codebase is not a public endpoint: the first user is
 * created via `/api/setup/complete`, and subsequent users join through
 * invitation. To exercise the login path hermetically the test seeds a
 * user directly via the same `users` table queries the routes use, with
 * a real bcrypt hash — the path under test (login → cookie → /me) is
 * identical to what an invited user would hit.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Hono, type Context } from "hono";

let tmpRoot: string;

// Lazy-bound after env vars are set in beforeAll.
let app: Hono;
let insertUser: typeof import("@/db/queries/users.ts").insertUser;
let bcrypt: typeof import("bcrypt");

const USERNAME = "alice_test";
const PASSWORD = "Hunter2-Hunter2";

// Track seeded user so /me assertions can verify identity.
let seededUserId: string;

function parseSetCookies(res: Response): Map<string, { value: string; raw: string }> {
  const out = new Map<string, { value: string; raw: string }>();
  // Hono returns a standard Response; getSetCookie() is available on Headers
  // in modern runtimes.
  const headers: string[] = (res.headers as any).getSetCookie
    ? (res.headers as any).getSetCookie()
    : (() => {
        const all = res.headers.get("set-cookie");
        return all ? all.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : [];
      })();
  for (const h of headers) {
    const first = h.split(";")[0];
    const idx = first.indexOf("=");
    if (idx < 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    out.set(name, { value, raw: h });
  }
  return out;
}

function cookieHeaderFrom(cookies: Map<string, { value: string }>): string {
  return Array.from(cookies.entries())
    .filter(([, v]) => v.value !== "")
    .map(([k, v]) => `${k}=${v.value}`)
    .join("; ");
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-auth-int-"));
  // Tests must be hermetic: set our own secrets before any module that
  // reads them initializes.
  process.env.DB_PATH = join(tmpRoot, "app.db");
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.CREDENTIALS_KEY = randomBytes(32).toString("hex");
  process.env.BLOB_STORE_DIR = join(tmpRoot, "blobs");
  // node env defaults to "test" under vitest; cookies.ts only adds
  // `Secure` in production. Leave NODE_ENV as-is.

  bcrypt = (await import("bcrypt")).default;
  ({ insertUser } = await import("@/db/queries/users.ts"));

  // Pull in the real handlers + middleware after env is in place.
  const {
    handleLogin,
    handleLogout,
    handleMe,
    handleUpdateMe,
  } = await import("@/routes/auth.ts");
  const { checkCsrf } = await import("@/lib/http/csrf.ts");

  // Mirror the production `h()` adapter from server/index.ts: surface a
  // synthetic socket IP per request so the rate limiter buckets by
  // per-test IP rather than the literal string "unknown" (which would
  // share state across cases).
  function h(handler: (req: any) => Response | Promise<Response>) {
    return async (c: Context) => {
      const req = c.req.raw;
      (req as any).params = c.req.param();
      (req as any).socketIp = `127.0.0.${Math.floor(Math.random() * 250) + 2}`;
      const csrfBlock = checkCsrf(req, c.req.path);
      if (csrfBlock) return csrfBlock;
      return handler(req);
    };
  }

  app = new Hono();
  app.post("/api/auth/login", h(handleLogin));
  app.post("/api/auth/logout", h(handleLogout));
  app.get("/api/me", h(handleMe));
  app.put("/api/me", h(handleUpdateMe));

  // Seed a user with a real bcrypt hash so login goes through the genuine
  // verification path.
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = insertUser(USERNAME, hash);
  seededUserId = row.id;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("auth-flow integration", () => {
  test("login → /me round-trip sets cookie and returns the right user", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as any;
    expect(loginJson.user.username).toBe(USERNAME);
    expect(typeof loginJson.csrfToken).toBe("string");
    expect(typeof loginJson.token).toBe("string");

    const cookies = parseSetCookies(loginRes);
    expect(cookies.get("auth")?.value).toBeTruthy();
    expect(cookies.get("csrf")?.value).toBeTruthy();
    expect(cookies.get("csrf")?.value).toBe(loginJson.csrfToken);

    const meRes = await app.request("/api/me", {
      method: "GET",
      headers: { cookie: cookieHeaderFrom(cookies) },
    });
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as any;
    expect(meJson.user.username).toBe(USERNAME);
    expect(meJson.user.id).toBe(seededUserId);
  });

  test("login with wrong password returns 401 and sets no auth cookie", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: "Wrong-Password-1" }),
    });
    expect(res.status).toBe(401);
    const cookies = parseSetCookies(res);
    expect(cookies.has("auth")).toBe(false);
    expect(cookies.has("csrf")).toBe(false);
  });

  test("unauthenticated GET /api/me returns 401", async () => {
    const res = await app.request("/api/me", { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("CSRF: state-changing call from a cookie session is rejected without the X-CSRF-Token header and accepted with it", async () => {
    // Establish a fresh session.
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const cookies = parseSetCookies(loginRes);
    const cookieHeader = cookieHeaderFrom(cookies);
    const csrf = cookies.get("csrf")!.value;

    // No CSRF header → 403.
    const without = await app.request("/api/me", {
      method: "PUT",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ companionSharing: true }),
    });
    expect(without.status).toBe(403);
    const withoutJson = (await without.json()) as any;
    expect(String(withoutJson.error)).toMatch(/csrf/i);

    // Wrong CSRF header → still 403.
    const wrong = await app.request("/api/me", {
      method: "PUT",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
        "x-csrf-token": "deadbeef",
      },
      body: JSON.stringify({ companionSharing: true }),
    });
    expect(wrong.status).toBe(403);

    // Correct CSRF header → 200.
    const ok = await app.request("/api/me", {
      method: "PUT",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ companionSharing: true }),
    });
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as any;
    expect(okJson.user.companionSharing).toBe(true);
  });

  test("logout clears the session cookie and a subsequent authenticated call returns 401", async () => {
    // Fresh session, because logout bumps token_version and invalidates
    // every other session for this user.
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const cookies = parseSetCookies(loginRes);
    const cookieHeader = cookieHeaderFrom(cookies);
    const csrf = cookies.get("csrf")!.value;

    // Logout is a state-changing POST under /api/* and requires CSRF.
    const logoutRes = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookieHeader, "x-csrf-token": csrf },
    });
    expect(logoutRes.status).toBe(200);

    const cleared = parseSetCookies(logoutRes);
    // Logout returns Set-Cookie that clears the auth cookie (empty value).
    expect(cleared.has("auth")).toBe(true);
    expect(cleared.get("auth")?.value).toBe("");
    expect(cleared.has("csrf")).toBe(true);
    expect(cleared.get("csrf")?.value).toBe("");

    // The JWT we held is now invalid because logout bumped token_version.
    const meAfter = await app.request("/api/me", {
      method: "GET",
      headers: { cookie: cookieHeader },
    });
    expect(meAfter.status).toBe(401);
  });

  // Passkey/WebAuthn registration requires a real authenticator (key pair +
  // attestation/assertion ceremonies signed by hardware or a virtual
  // authenticator). @simplewebauthn/server exposes verification helpers but
  // no built-in test authenticator, so an end-to-end drive from this layer
  // would amount to reimplementing CTAP2 in the test. Skipping.
  test.skip("passkey registration end-to-end", () => {});
});

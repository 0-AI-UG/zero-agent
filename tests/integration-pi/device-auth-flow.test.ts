/**
 * Device-authorization flow — integration coverage.
 *
 * Drives the real `zero login` device handlers (start / poll / info / approve /
 * deny) through a Hono app wired exactly like `server/index.ts` (same
 * `checkCsrf` middleware, same `h()` adapter) against a real SQLite DB under a
 * temp `DB_PATH`. The full happy path is exercised: the CLI starts a request
 * (unauthenticated), the logged-in user looks it up and approves it into a
 * project (session cookie + CSRF), and the CLI's next poll receives the minted
 * companion token exactly once.
 *
 * Mirrors the harness in `auth-flow.test.ts` — we recreate the relevant subset
 * of the route table rather than importing `server/index.ts` (which would spin
 * up a real listener, scheduler, and browser pool as a side effect).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Hono, type Context } from "hono";

let tmpRoot: string;
let app: Hono;

const USERNAME = "deviceuser_test";
const PASSWORD = "Hunter2-Hunter2";

let userId: string;
let projectId: string;

function parseSetCookies(res: Response): Map<string, { value: string }> {
  const out = new Map<string, { value: string }>();
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
    out.set(first.slice(0, idx).trim(), { value: first.slice(idx + 1).trim() });
  }
  return out;
}

function cookieHeaderFrom(cookies: Map<string, { value: string }>): string {
  return Array.from(cookies.entries())
    .filter(([, v]) => v.value !== "")
    .map(([k, v]) => `${k}=${v.value}`)
    .join("; ");
}

// Log in and return { cookie, csrf } for authenticated, CSRF-protected calls.
async function session(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookies = parseSetCookies(res);
  return { cookie: cookieHeaderFrom(cookies), csrf: cookies.get("csrf")!.value };
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-device-int-"));
  process.env.DB_PATH = join(tmpRoot, "app.db");
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.CREDENTIALS_KEY = randomBytes(32).toString("hex");
  process.env.BLOB_STORE_DIR = join(tmpRoot, "blobs");

  const bcrypt = (await import("bcrypt")).default;
  const { insertUser } = await import("@/db/queries/users.ts");
  const { insertProject } = await import("@/db/queries/projects.ts");
  const { insertProjectMember } = await import("@/db/queries/members.ts");

  const { handleLogin } = await import("@/routes/auth.ts");
  const {
    handleDeviceStart,
    handleDevicePoll,
    handleDeviceInfo,
    handleDeviceApprove,
    handleDeviceDeny,
  } = await import("@/routes/companion-device.ts");
  const { checkCsrf } = await import("@/lib/http/csrf.ts");

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
  app.post("/api/companion/device/start", h(handleDeviceStart));
  app.post("/api/companion/device/poll", h(handleDevicePoll));
  app.get("/api/companion/device/info", h(handleDeviceInfo));
  app.post("/api/companion/device/approve", h(handleDeviceApprove));
  app.post("/api/companion/device/deny", h(handleDeviceDeny));

  const hash = await bcrypt.hash(PASSWORD, 10);
  userId = insertUser(USERNAME, hash).id;
  projectId = insertProject(userId, "Device Test Project").id;
  insertProjectMember(projectId, userId, "owner");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function start(): Promise<{ deviceCode: string; userCode: string }> {
  const res = await app.request("/api/companion/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "test-laptop" }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  return { deviceCode: json.deviceCode, userCode: json.userCode };
}

async function poll(deviceCode: string): Promise<any> {
  const res = await app.request("/api/companion/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("device-auth flow integration", () => {
  test("start returns a 6-digit user code and verification URLs", async () => {
    const res = await app.request("/api/companion/device/start", {
      method: "POST",
      headers: { "content-type": "application/json", host: "zero.example.com" },
      body: JSON.stringify({ deviceName: "my-laptop" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.userCode).toMatch(/^\d{6}$/);
    expect(typeof json.deviceCode).toBe("string");
    expect(json.verificationUri).toBe("http://zero.example.com/device");
    expect(json.verificationUriComplete).toBe(
      `http://zero.example.com/device?code=${json.userCode}`,
    );
    expect(json.interval).toBeGreaterThan(0);
  });

  test("happy path: start → pending → approve → token delivered once", async () => {
    const { deviceCode, userCode } = await start();

    // Before approval the CLI sees "pending".
    expect((await poll(deviceCode)).status).toBe("pending");

    const { cookie, csrf } = await session();

    // The approval page can describe the request.
    const infoRes = await app.request(
      `/api/companion/device/info?userCode=${userCode}`,
      { method: "GET", headers: { cookie } },
    );
    expect(infoRes.status).toBe(200);
    expect((await infoRes.json()).deviceName).toBe("test-laptop");

    // Approve into the project.
    const approveRes = await app.request("/api/companion/device/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ userCode, projectId }),
    });
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).ok).toBe(true);

    // The CLI's next poll gets the minted token + bound project.
    const approved = await poll(deviceCode);
    expect(approved.status).toBe("approved");
    expect(approved.projectId).toBe(projectId);
    expect(approved.token).toMatch(/^cmp_/);

    // The request is consumed: a second poll no longer returns the token.
    expect((await poll(deviceCode)).status).toBe("expired");
  });

  test("approve requires CSRF (cookie session without the header is rejected)", async () => {
    const { userCode } = await start();
    const { cookie } = await session();
    const res = await app.request("/api/companion/device/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userCode, projectId }),
    });
    expect(res.status).toBe(403);
  });

  test("info/approve require authentication", async () => {
    const { userCode } = await start();
    const infoRes = await app.request(
      `/api/companion/device/info?userCode=${userCode}`,
      { method: "GET" },
    );
    expect(infoRes.status).toBe(401);
  });

  test("deny: CLI sees a denied status and cannot be approved afterwards", async () => {
    const { deviceCode, userCode } = await start();
    const { cookie, csrf } = await session();

    const denyRes = await app.request("/api/companion/device/deny", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ userCode }),
    });
    expect(denyRes.status).toBe(200);

    expect((await poll(deviceCode)).status).toBe("denied");

    // A denied request is no longer pending, so approval 404s.
    const approveRes = await app.request("/api/companion/device/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ userCode, projectId }),
    });
    expect(approveRes.status).toBe(404);
  });

  test("poll with an unknown device code reports expired", async () => {
    expect((await poll("nonexistent-code")).status).toBe("expired");
  });
});

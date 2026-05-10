/**
 * Host browser pool — integration coverage.
 *
 * Launches a real Chromium via Playwright and drives a single project
 * session through navigate → snapshot → screenshot → close. Gated on
 * `BROWSER_TEST=1` to keep the unit suite fast and avoid the ~150 MB
 * Chromium download on contributors who haven't run
 * `npx playwright install chromium`.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { getBrowserPool, stopBrowserPool } from "@/lib/browser/host-pool.ts";

const enabled = process.env.BROWSER_TEST === "1";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!enabled) return;
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body>
      <h1 id="t">Hello</h1>
      <button id="b">Click me</button>
      <a href="https://example.com">link</a>
    </body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(async () => {
  if (!enabled) return;
  await stopBrowserPool();
  await new Promise<void>((r) => server.close(() => r()));
});

describe.skipIf(!enabled)("browser host pool (integration)", () => {
  test("navigates, snapshots, screenshots, evaluates", async () => {
    const pool = getBrowserPool();
    pool.start();

    const projectId = `int-${Date.now()}`;

    const navResult = await pool.execute(projectId, { type: "navigate", url: baseUrl });
    expect(navResult.type).toBe("done");

    const snap = await pool.execute(projectId, { type: "snapshot", mode: "interactive" });
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      // The button + link should appear with refs in the interactive snapshot.
      expect(snap.content).toMatch(/button/);
      expect(snap.content).toMatch(/link/);
    }

    const shot = await pool.execute(projectId, { type: "screenshot" });
    expect(shot.type).toBe("screenshot");
    if (shot.type === "screenshot") {
      // JPEG header — first bytes after base64-decode should be 0xFF 0xD8.
      const buf = Buffer.from(shot.base64, "base64");
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    }

    const evalResult = await pool.execute(projectId, {
      type: "evaluate",
      script: "document.querySelector('#t').textContent",
    });
    expect(evalResult.type).toBe("evaluate");
    if (evalResult.type === "evaluate") {
      expect(evalResult.value).toBe("Hello");
    }

    await pool.closeSession(projectId);
  }, 30_000);
});

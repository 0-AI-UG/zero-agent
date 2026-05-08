/**
 * Per-turn unix socket auth: a request bearing the registered token gets
 * the scoped CliContext back; a missing or wrong token gets 401. The
 * sandbox itself is what controls *which processes* can reach the
 * socket; this test exercises only the application-level identity check.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import {
  _clearPiTurnTokens,
  registerPiTurnToken,
  resolvePiTurnToken,
  startPiSocketServer,
} from "./cli-socket.ts";
import type { PiCliContext } from "./cli-context.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  _clearPiTurnTokens();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkdir() {
  const d = mkdtempSync(join(tmpdir(), "pi-socket-test-"));
  tmpDirs.push(d);
  return d;
}

function ctx(): PiCliContext {
  return {
    projectId: "p1",
    chatId: "c1",
    userId: "u1",
    runId: "r1",
    expiresAt: Date.now() + 60_000,
  };
}

function postOverUnix(
  socketPath: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, method: "POST", path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("token registry", () => {
  test("resolve returns null after expiry", () => {
    registerPiTurnToken("t-expired", { ...ctx(), expiresAt: Date.now() - 1 });
    expect(resolvePiTurnToken("t-expired")).toBeNull();
  });

  test("release removes the token", () => {
    const release = registerPiTurnToken("t-rel", ctx());
    expect(resolvePiTurnToken("t-rel")).not.toBeNull();
    release();
    expect(resolvePiTurnToken("t-rel")).toBeNull();
  });
});

describe("startPiSocketServer", () => {
  test("valid token gets the scoped context back", async () => {
    const dir = mkdir();
    const sockPath = join(dir, "zero.sock");
    const server = await startPiSocketServer(sockPath, ctx(), "good-token");
    try {
      const res = await postOverUnix(sockPath, "/pi/health", {
        "X-Pi-Run-Token": "good-token",
        "Content-Length": "0",
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.ctx).toMatchObject({
        projectId: "p1",
        chatId: "c1",
        userId: "u1",
        runId: "r1",
      });
    } finally {
      await server.close();
    }
  });

  test("missing or wrong token gets 401", async () => {
    const dir = mkdir();
    const sockPath = join(dir, "zero.sock");
    const server = await startPiSocketServer(sockPath, ctx(), "good-token");
    try {
      const missing = await postOverUnix(sockPath, "/pi/health", {
        "Content-Length": "0",
      });
      expect(missing.status).toBe(401);
      const wrong = await postOverUnix(sockPath, "/pi/health", {
        "X-Pi-Run-Token": "nope",
        "Content-Length": "0",
      });
      expect(wrong.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("close() releases the token", async () => {
    const dir = mkdir();
    const sockPath = join(dir, "zero.sock");
    const server = await startPiSocketServer(sockPath, ctx(), "tok-close");
    expect(resolvePiTurnToken("tok-close")).not.toBeNull();
    await server.close();
    expect(resolvePiTurnToken("tok-close")).toBeNull();
  });
});

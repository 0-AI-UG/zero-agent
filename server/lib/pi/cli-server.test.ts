/**
 * Token registry: registered tokens resolve to their CliContext until
 * released or expired. The CLI handlers ride the main HTTP server now,
 * so there is no separate listener to test here — the surface is just
 * register/resolve/release.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  _clearPiTurnTokens,
  registerPiTurnToken,
  resolvePiTurnToken,
} from "./cli-server.ts";
import type { PiCliContext } from "./cli-context.ts";

afterEach(() => {
  _clearPiTurnTokens();
});

function ctx(): PiCliContext {
  return {
    projectId: "p1",
    chatId: "c1",
    userId: "u1",
    runId: "r1",
    expiresAt: Date.now() + 60_000,
  };
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

  test("valid token resolves to the registered ctx", () => {
    registerPiTurnToken("t-good", ctx());
    expect(resolvePiTurnToken("t-good")).toMatchObject({
      projectId: "p1",
      chatId: "c1",
      userId: "u1",
      runId: "r1",
    });
  });

  test("missing or unknown token resolves to null", () => {
    expect(resolvePiTurnToken("")).toBeNull();
    expect(resolvePiTurnToken("nope")).toBeNull();
  });
});

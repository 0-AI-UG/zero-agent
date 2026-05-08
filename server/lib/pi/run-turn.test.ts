/**
 * Smoke test for runTurn end-to-end. Spawns Pi in-process, drives one
 * prompt, and asserts the event envelope shape.
 *
 * Requires a real provider key — gated on LIVE=1 + OPENROUTER_API_KEY
 * (or ANTHROPIC_API_KEY). Without those the test is skipped, mirroring
 * the spike's `LIVE=1` mode.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { runTurn, type PiEventEnvelope } from "./run-turn.ts";

const live =
  process.env.LIVE === "1" &&
  Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("runTurn (LIVE)", () => {
  test("drives a turn and emits envelope-shaped events", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runturn-"));
    try {
      process.env.PI_PROJECTS_ROOT = join(root, "projects");
      process.env.PI_SOCKETS_ROOT = join(root, "sockets");

      const auth = AuthStorage.create(join(root, "auth.json"));
      if (process.env.OPENROUTER_API_KEY)
        auth.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY);
      if (process.env.ANTHROPIC_API_KEY)
        auth.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);

      const model = getModel("openrouter", "openai/gpt-4o-mini" as never);
      if (!model) throw new Error("no model resolved");

      const events: PiEventEnvelope[] = [];
      const result = await runTurn({
        projectId: "test-proj",
        chatId: "chat-1",
        userId: "user-1",
        userMessage: "Reply with exactly: OK",
        model: model as never,
        authStorage: auth,
        onEvent: (e) => events.push(e),
      });

      expect(result.runId).toMatch(/^run-/);
      expect(events.length).toBeGreaterThan(0);
      for (const env of events) {
        expect(env.type).toBe("pi.event");
        expect(env.projectId).toBe("test-proj");
        expect(env.chatId).toBe("chat-1");
        expect(env.runId).toBe(result.runId);
        expect(env.event).toBeDefined();
      }
      const types = new Set(events.map((e) => e.event.type));
      expect(types.has("agent_start")).toBe(true);
      expect(types.has("agent_end")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

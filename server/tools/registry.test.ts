import { describe, test, expect } from "vitest";
import { createToolRegistry, getAlwaysAvailable } from "@/tools/registry.ts";

const PROJECT_ID = "test-project";

// NOTE: many tools (searchWeb, fetchUrl, generateImage, scheduling,
// browser, credentials, telegram, chat-history, listFiles, searchFiles)
// have been migrated to the `zero` CLI/SDK in the runner sandbox and
// are no longer in this in-process registry. The agent reaches them
// via `bash` → `zero ...` → /api/runner-proxy/zero/* on the server.

describe("tool scoping by execution context", () => {
  test("chat context includes always-available base tools", () => {
    const registry = createToolRegistry(PROJECT_ID, { context: "chat" });
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.editFile).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });

  test("chat context includes progress tools when chatId is provided", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "chat",
      chatId: "chat-1",
      userId: "user-1",
    });
    expect(registry.progressCreate).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });

  test("onlyTools restricts to allowlist + base tools", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "automation",
      onlyTools: ["readFile"],
    });
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.editFile).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });
});

describe("subagent context", () => {
  test("excludes denied tools but includes loadSkill", () => {
    const registry = createToolRegistry(PROJECT_ID, { context: "subagent" });
    expect(registry.agent).toBeUndefined();
    expect(registry.loadSkill).toBeDefined();
    expect(registry.delete).toBeUndefined();
  });

  test("includes file tools", () => {
    const registry = createToolRegistry(PROJECT_ID, { context: "subagent" });
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
  });

  test("always-available includes loadSkill", () => {
    const available = getAlwaysAvailable("subagent");
    expect(available.has("readFile")).toBe(true);
    expect(available.has("loadSkill")).toBe(true);
    expect(available.has("browser")).toBe(false);
  });
});

describe("getAlwaysAvailable", () => {
  test("chat context includes base tools", () => {
    const available = getAlwaysAvailable("chat");
    expect(available.has("readFile")).toBe(true);
    expect(available.has("loadSkill")).toBe(true);
    expect(available.has("browser")).toBe(false);
    expect(available.has("listFiles")).toBe(false);
  });

  test("automation context includes base tools with loadSkill", () => {
    const available = getAlwaysAvailable("automation");
    expect(available.has("readFile")).toBe(true);
    expect(available.has("writeFile")).toBe(true);
    expect(available.has("loadSkill")).toBe(true);
  });
});

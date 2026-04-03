import { describe, test, expect } from "bun:test";
import { createToolRegistry, getAlwaysAvailable } from "@/tools/registry.ts";

const PROJECT_ID = "test-project";

describe("tool scoping by execution context", () => {
  test("chat context excludes nothing extra (all-scoped tools available)", () => {
    const registry = createToolRegistry(PROJECT_ID, { context: "chat" });
    expect(registry.searchWeb).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });

  test("automation context excludes agent tool", () => {
    const registry = createToolRegistry(PROJECT_ID, { context: "automation" });
    expect(registry.agent).toBeUndefined();
    // loadSkill is now available in all contexts
    expect(registry.loadSkill).toBeDefined();
  });

  test("chat context includes progress tools when deps are met", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "chat",
      chatId: "chat-1",
      userId: "user-1",
    });
    expect(registry.progressCreate).toBeDefined();
    expect(registry.browser).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });

  test("no context means all tools available", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      chatId: "chat-1",
      userId: "user-1",
    });
    expect(registry.progressCreate).toBeDefined();
    expect(registry.searchWeb).toBeDefined();
  });

  test("onlyTools restricts to allowlist + base tools", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "automation",
      onlyTools: ["searchWeb"],
    });
    // Allowed tool present
    expect(registry.searchWeb).toBeDefined();
    // Base file tools always present
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.editFile).toBeDefined();
    expect(registry.listFiles).toBeDefined();
    // loadSkill always present (in ALWAYS_AVAILABLE_BASE)
    expect(registry.loadSkill).toBeDefined();
    // Other on-demand tools excluded
    expect(registry.fetchUrl).toBeUndefined();
  });

  test("onlyTools undefined gives full automation scope", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "automation",
    });
    expect(registry.searchWeb).toBeDefined();
    expect(registry.fetchUrl).toBeDefined();
    expect(registry.readFile).toBeDefined();
    expect(registry.searchWeb).toBeDefined();
  });
});

describe("subagent context", () => {
  test("excludes denied tools, but includes loadSkill", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "subagent",
    });
    // Agent tool excluded in subagent
    expect(registry.agent).toBeUndefined();
    // loadSkill is now available everywhere
    expect(registry.loadSkill).toBeDefined();
    // Denied tools excluded
    expect(registry.scheduleTask).toBeUndefined();
    expect(registry.removeScheduledTask).toBeUndefined();
    expect(registry.delete).toBeUndefined();
  });

  test("includes research and file tools", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      context: "subagent",
    });
    expect(registry.searchWeb).toBeDefined();
    expect(registry.fetchUrl).toBeDefined();
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.listFiles).toBeDefined();
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
  });

  test("automation context includes base tools with loadSkill", () => {
    const available = getAlwaysAvailable("automation");
    expect(available.has("readFile")).toBe(true);
    expect(available.has("writeFile")).toBe(true);
    expect(available.has("loadSkill")).toBe(true);
    expect(available.has("browser")).toBe(false);
  });
});

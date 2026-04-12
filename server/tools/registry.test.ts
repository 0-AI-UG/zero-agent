import { describe, test, expect } from "vitest";
import { createToolRegistry } from "@/tools/registry.ts";

const PROJECT_ID = "test-project";

describe("tool registry", () => {
  test("includes base file and skill tools", () => {
    const registry = createToolRegistry(PROJECT_ID, {});
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.editFile).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });

  test("includes progress tools when chatId is provided", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      chatId: "chat-1",
      userId: "user-1",
    });
    expect(registry.progressCreate).toBeDefined();
  });

  test("omits progress tools when chatId is not provided", () => {
    const registry = createToolRegistry(PROJECT_ID, { userId: "user-1" });
    expect(registry.progressCreate).toBeUndefined();
  });

  test("onlyTools restricts to allowlist + core tools", () => {
    const registry = createToolRegistry(PROJECT_ID, {
      onlyTools: ["readFile"],
    });
    // Core tools always kept
    expect(registry.readFile).toBeDefined();
    expect(registry.writeFile).toBeDefined();
    expect(registry.editFile).toBeDefined();
    expect(registry.loadSkill).toBeDefined();
  });
});

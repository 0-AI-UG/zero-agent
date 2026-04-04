import { z } from "zod";
import { tool } from "ai";
import type { Tool } from "ai";
import { createSearchWebTool } from "@/tools/searchWeb.ts";
import { fetchUrlTool } from "@/tools/fetchUrl.ts";
import { createFileTools } from "@/tools/files.ts";
import { createGenerateImageTool } from "@/tools/generateImage.ts";
import { createSchedulingTools } from "@/tools/scheduling.ts";
import { createProgressTools } from "@/tools/progress.ts";
import { createSkillTools } from "@/tools/skills.ts";
import { createBrowserTool } from "@/tools/browser.ts";
import { createCodeTools } from "@/tools/code.ts";
import { createCredentialTools } from "@/tools/credentials.ts";
import { createTelegramTools } from "@/tools/telegram.ts";
import { createChatHistoryTools } from "@/tools/chat-history.ts";

export type ToolRegistry = Record<string, Tool<any, any>>;

export type ToolScope = "chat" | "automation" | "all";
export type ExecutionContext = "chat" | "automation" | "subagent";

const TOOL_SCOPES: Record<string, ToolScope> = {
  agent: "all",
};

// Tools explicitly denied in subagent context (on top of scope filtering)
const SUBAGENT_DENIED = new Set([
  "scheduleTask",
  "listScheduledTasks",
  "updateScheduledTask",
  "removeScheduledTask",
  "delete",
]);

function isToolAvailable(name: string, context: ExecutionContext): boolean {
  if (context === "subagent") {
    // Subagents get "all"-scoped tools minus the denied set
    const scope = TOOL_SCOPES[name] ?? "all";
    return scope === "all" && !SUBAGENT_DENIED.has(name);
  }
  const scope = TOOL_SCOPES[name] ?? "all";
  return scope === "all" || scope === context;
}

// Always-available base tools (all contexts)
const ALWAYS_AVAILABLE_BASE = new Set(["readFile", "writeFile", "editFile", "listFiles", "loadSkill"]);
// Additional always-available tools for chat context
const ALWAYS_AVAILABLE_CHAT_EXTRA = new Set<string>([]);

export function getAlwaysAvailable(context: ExecutionContext): Set<string> {
  if (context === "chat") {
    return new Set([...ALWAYS_AVAILABLE_BASE, ...ALWAYS_AVAILABLE_CHAT_EXTRA]);
  }
  // automation and subagent only get base file tools
  return new Set(ALWAYS_AVAILABLE_BASE);
}

export function createToolRegistry(
  projectId: string,
  options: {
    chatId?: string;
    userId?: string;
    modelId?: string;
    browserSessionId?: string;
    lazyBrowserSession?: { id: string; created: boolean; label?: string };
    context?: ExecutionContext;
    onlyTools?: string[];
    onlySkills?: string[];
    codeExecutionEnabled?: boolean;
    initialReadPaths?: string[];
    anchorRunId?: string;
  },
): ToolRegistry {
  const registry: ToolRegistry = {
    searchWeb: createSearchWebTool(),
    fetchUrl: fetchUrlTool,
    ...createFileTools(projectId, { modelId: options.modelId, initialReadPaths: options.initialReadPaths }),
    ...createGenerateImageTool(projectId),
    ...createSchedulingTools(projectId),
    ...(options.chatId ? createProgressTools({ projectId, chatId: options.chatId, anchorRunId: options.anchorRunId }) : {}),
    ...createSkillTools(projectId, options.chatId),
    ...(options.userId ? createBrowserTool(options.userId, projectId, options.browserSessionId, options.lazyBrowserSession, options.modelId) : {}),
    ...(options.userId && options.chatId && options.codeExecutionEnabled ? createCodeTools(options.userId, projectId, options.chatId) : {}),
    ...createCredentialTools(projectId, options.userId ?? undefined),
    ...createTelegramTools(projectId),
    ...createChatHistoryTools(projectId),
  };

  // 1. Scope filtering — remove tools not available in this context
  if (options.context) {
    for (const name of Object.keys(registry)) {
      if (!isToolAvailable(name, options.context)) {
        delete registry[name];
      }
    }
  }

  // 2. Per-automation allowlist — only restricts on-demand tools, base tools always kept
  if (options.onlyTools) {
    const allowed = new Set(options.onlyTools);
    const base = getAlwaysAvailable(options.context ?? "chat");
    for (const name of Object.keys(registry)) {
      if (!allowed.has(name) && !base.has(name)) {
        delete registry[name];
      }
    }
  }

  return registry;
}

/**
 * Build a tool index string for the system prompt.
 * Lists always-loaded tools and on-demand tools by name.
 */
export function buildToolIndex(registry: ToolRegistry, context: ExecutionContext = "chat"): string {
  const alwaysAvailable = getAlwaysAvailable(context);
  const alwaysLoaded = [...alwaysAvailable].filter((n) => registry[n]);
  const onDemand = Object.keys(registry).filter((n) => !alwaysAvailable.has(n));

  const lines = ["## Available Tools", ""];
  if (alwaysLoaded.length > 0) {
    lines.push(`Always loaded: ${alwaysLoaded.join(", ")}`);
  }
  if (onDemand.length > 0) {
    lines.push("");
    lines.push(`Call \`loadTools\` with tool names before using: ${onDemand.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Creates a mutable tools object for dynamic tool loading.
 *
 * Only core tools + loadTools are available initially.
 * When the agent calls loadTools, named tools are activated
 * (added to the same object) so they become available on the next step.
 */
export function createDiscoverableToolset(
  projectId: string,
  options: {
    chatId?: string;
    userId?: string;
    modelId?: string;
    browserSessionId?: string;
    lazyBrowserSession?: { id: string; created: boolean; label?: string };
    excludeTools?: string[];
    context?: ExecutionContext;
    onlyTools?: string[];
    onlySkills?: string[];
    codeExecutionEnabled?: boolean;
    initialReadPaths?: string[];
    anchorRunId?: string;
  },
): { activeTools: ToolRegistry; fullRegistry: ToolRegistry; toolIndex: string } {
  const context = options.context ?? "chat";
  const fullRegistry = createToolRegistry(projectId, {
    ...options,
    context,
  });

  // Remove excluded tools (e.g. approval-based tools unavailable in subagents)
  if (options.excludeTools) {
    for (const name of options.excludeTools) {
      delete fullRegistry[name];
    }
  }

  const alwaysAvailable = getAlwaysAvailable(context);

  // Mutable object — only core tools loaded initially
  const activeTools: ToolRegistry = {};

  for (const name of alwaysAvailable) {
    if (fullRegistry[name]) {
      activeTools[name] = fullRegistry[name];
    }
  }

  activeTools.loadTools = tool({
    description: "Load tools by name to make them available. Call this before using tools not listed as always-available.",
    inputSchema: z.object({
      names: z.array(z.string()).describe("Tool names to load"),
    }),
    execute: async ({ names }) => {
      const loaded: string[] = [];
      const notFound: string[] = [];
      for (const name of names) {
        if (fullRegistry[name] && !activeTools[name]) {
          activeTools[name] = fullRegistry[name];
          loaded.push(name);
        } else if (!fullRegistry[name]) {
          notFound.push(name);
        }
      }
      return {
        loaded: loaded.map((name) => ({
          name,
          description: fullRegistry[name]?.description ?? "",
        })),
        ...(notFound.length > 0 ? { notFound } : {}),
        hint: `${loaded.length} tool(s) loaded. You can now call them.`,
      };
    },
  });

  const toolIndex = buildToolIndex(fullRegistry, context);

  return { activeTools, fullRegistry, toolIndex };
}

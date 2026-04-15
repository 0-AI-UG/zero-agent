import type { Tool } from "@openrouter/sdk/lib/tool-types.js";
import { createFileTools } from "@/tools/files.ts";
import { createProgressTools } from "@/tools/progress.ts";
import { createSkillTools } from "@/tools/skills.ts";
import { createCodeTools } from "@/tools/code.ts";

// On-demand CLI tools (web, image, scheduling, browser, credentials, message,
// search, etc.) live in server/cli-handlers/ and are reached by the agent via
// `bash` → `zero ...` → the runner-proxy. Only in-process tools live here.

export type ToolRegistry = readonly Tool[];

/** Name-indexed lookup over a tool array (for callers that need record-style access). */
export function toolsByName(tools: ToolRegistry): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const t of tools) {
    out[t.function.name] = t;
  }
  return out;
}

// Core tools that survive an `onlyTools` allowlist - the agent can't function
// without file/bash/skill access.
const CORE_TOOLS = new Set(["readFile", "writeFile", "editFile", "loadSkill", "bash"]);

export function createToolRegistry(
  projectId: string,
  options: {
    chatId?: string;
    userId?: string;
    modelId?: string;
    onlyTools?: string[];
    onlySkills?: string[];
    initialReadPaths?: string[];
    runId?: string;
    /** Autonomous run - sync approvals fan out to every project member. */
    autonomous?: boolean;
  },
): ToolRegistry {
  const all: Tool[] = [
    ...createFileTools(projectId, {
      chatId: options.chatId,
      userId: options.userId,
      modelId: options.modelId,
      initialReadPaths: options.initialReadPaths,
    }),
    ...(options.chatId
      ? createProgressTools({ projectId, chatId: options.chatId, runId: options.runId })
      : []),
    ...createSkillTools(projectId, options.chatId),
    ...(options.userId
      ? createCodeTools(options.userId, projectId, { autonomous: options.autonomous })
      : []),
  ];

  if (options.onlyTools) {
    const allowed = new Set(options.onlyTools);
    return all.filter(
      (t) => allowed.has(t.function.name) || CORE_TOOLS.has(t.function.name),
    );
  }

  return all;
}

/**
 * Build a tool index string for the system prompt. All tools are loaded
 * up front - there is no on-demand loading step.
 */
export function buildToolIndex(registry: ToolRegistry): string {
  const names = registry.map((t) => t.function.name).sort();
  if (names.length === 0) return "";
  return `## Available Tools\n\n${names.join(", ")}`;
}

/**
 * Build the full toolset for an agent. Callers pass the result directly to
 * callModel. Subagent discrimination is done by the caller - subagents are
 * constructed via the separate path in `server/tools/agent.ts` which
 * deliberately does not inject the `agent` spawner (no recursive fan-out).
 */
export function createToolset(
  projectId: string,
  options: {
    chatId?: string;
    userId?: string;
    modelId?: string;
    excludeTools?: string[];
    onlyTools?: string[];
    onlySkills?: string[];
    initialReadPaths?: string[];
    runId?: string;
    /** Autonomous run - sync approvals fan out to every project member. */
    autonomous?: boolean;
  },
): { tools: ToolRegistry; toolIndex: string } {
  let tools = createToolRegistry(projectId, options);

  if (options.excludeTools) {
    const excluded = new Set(options.excludeTools);
    tools = tools.filter((t) => !excluded.has(t.function.name));
  }

  return { tools, toolIndex: buildToolIndex(tools) };
}

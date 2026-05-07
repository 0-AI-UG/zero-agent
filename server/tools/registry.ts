import type { ToolSet } from "ai";
import { createFileTools } from "@/tools/files.ts";
import { createProgressTools } from "@/tools/progress.ts";
import { createSkillTools } from "@/tools/skills.ts";
import { createCodeTools } from "@/tools/code.ts";

// On-demand CLI tools (web, image, scheduling, browser, credentials, message,
// search, etc.) live in server/cli-handlers/ and are reached by the agent via
// `bash` → `zero ...` → the runner-proxy. Only in-process tools live here.

export type ToolRegistry = ToolSet;

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
    runId?: string;
  },
): ToolRegistry {
  const all: ToolSet = {
    ...createFileTools(projectId, {
      chatId: options.chatId,
      userId: options.userId,
      modelId: options.modelId,
    }),
    ...(options.chatId
      ? createProgressTools({ projectId, chatId: options.chatId, runId: options.runId })
      : {}),
    ...createSkillTools(projectId, options.chatId),
    ...(options.userId
      ? createCodeTools(options.userId, projectId)
      : {}),
  };

  if (options.onlyTools) {
    const allowed = new Set(options.onlyTools);
    const filtered: ToolSet = {};
    for (const [name, t] of Object.entries(all)) {
      if (allowed.has(name) || CORE_TOOLS.has(name)) {
        filtered[name] = t;
      }
    }
    return filtered;
  }

  return all;
}

/**
 * Build the full toolset for an agent. Callers pass the result directly to
 * streamText/generateText. Subagent discrimination is done by the caller -
 * subagents are constructed via the separate path in `server/tools/agent.ts`
 * which deliberately does not inject the `agent` spawner (no recursive fan-out).
 */
export function createToolset(
  projectId: string,
  options: {
    chatId?: string;
    userId?: string;
    modelId?: string;
    onlyTools?: string[];
    onlySkills?: string[];
    runId?: string;
  },
): ToolRegistry {
  return createToolRegistry(projectId, options);
}

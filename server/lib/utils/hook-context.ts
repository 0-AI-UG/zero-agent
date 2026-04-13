import { log } from "@/lib/logger.ts";

const hookLog = log.child({ module: "hooks" });

// Rate limiting for reactive agent runs
const pluginRunCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_RUNS_PER_MINUTE = 10;

function checkRateLimit(pluginName: string): boolean {
  const now = Date.now();
  const entry = pluginRunCounts.get(pluginName);
  if (!entry || now > entry.resetAt) {
    pluginRunCounts.set(pluginName, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_RUNS_PER_MINUTE;
}

export interface HookContext {
  runAgent(opts: {
    projectId: string;
    prompt: string;
    title?: string;
    tools?: string[];
    skills?: string[];
  }): Promise<{ chatId: string }>;
}

// This will be set by the plugin loader after autonomous-agent is available
let runAgentImpl: ((opts: any) => Promise<{ chatId: string }>) | null = null;

export function setRunAgentImpl(impl: (opts: any) => Promise<{ chatId: string }>) {
  runAgentImpl = impl;
}

export function createHookContext(pluginName: string): HookContext {
  return {
    runAgent: async (opts) => {
      if (!checkRateLimit(pluginName)) {
        hookLog.warn("hook rate limited", { plugin: pluginName });
        throw new Error(`Plugin ${pluginName} rate limited`);
      }

      if (!runAgentImpl) {
        throw new Error("Agent runner not initialized");
      }

      hookLog.info("hook triggering agent run", { plugin: pluginName, projectId: opts.projectId });
      return runAgentImpl(opts);
    },
  };
}

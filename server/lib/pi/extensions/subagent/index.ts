/**
 * Subagent tool — delegates tasks to specialized agents in isolated
 * `AgentSession` instances, in-process.
 *
 * Modes:
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }
 *   - chain:    { chain: [{ agent, task: "... {previous} ..." }, ...] }
 *
 * Each invocation spins up a fresh `createAgentSession()` that reuses the
 * parent's `AuthStorage` + `ModelRegistry` (so provider keys are shared),
 * runs with an in-memory `SessionManager` + `SettingsManager`, and applies
 * the same project-sandbox extension as the parent so the child's bash/fs
 * tools stay confined to the project dir.
 *
 * Child sessions are intentionally *not* given recursive subagent access;
 * we don't want runaway fan-out.
 */

import * as path from "node:path";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type Api, type Message, type Model, StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
} from "./agents.ts";
import { createProjectSandboxExtension } from "../project-sandbox/index.ts";
import { defaultAgentsDir } from "../../pi-config.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Find a model in the registry by the frontmatter `model:` string.
 * Accepts a bare model id (matched across all providers) or an explicit
 * `provider/id`. Returns undefined if no match — caller falls back to the
 * parent's model.
 */
function resolveAgentModel(
  spec: string | undefined,
  ctx: ExtensionContext,
): Model<Api> | undefined {
  if (!spec) return undefined;
  const all = ctx.modelRegistry.getAll();
  const exact = all.find((m) => m.id === spec);
  if (exact) return exact;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const m = ctx.modelRegistry.find(provider, id);
    if (m) return m;
    // Some catalogs key models by the full `provider/id` literal. Try a
    // second lookup with the unsplit string.
    const literal = ctx.modelRegistry.find(provider, spec);
    if (literal) return literal;
  }
  return undefined;
}

interface RunSingleAgentArgs {
  parentCtx: ExtensionContext;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwdOverride?: string;
  step?: number;
  signal?: AbortSignal;
  onUpdate?: (result: SingleResult) => void;
  /** Env vars to inject into the child's bash subprocesses. */
  bashEnv?: Record<string, string>;
  /** Additional read-only roots for the child's sandbox. */
  extraReadOnlyRoots?: string[];
}

async function runSingleAgent(args: RunSingleAgentArgs): Promise<SingleResult> {
  const {
    parentCtx,
    agents,
    agentName,
    task,
    cwdOverride,
    step,
    signal,
    onUpdate,
    bashEnv,
    extraReadOnlyRoots,
  } = args;
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
    };
  }

  const cwd = path.resolve(cwdOverride ?? parentCtx.cwd);
  const model = resolveAgentModel(agent.model, parentCtx) ?? parentCtx.model;
  if (!model) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: "No model available — parent has no current model and the agent definition does not pin one.",
      usage: emptyUsage(),
      step,
    };
  }

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: agent.model ?? `${model.provider}/${model.id}`,
    step,
  };

  const emit = () => {
    if (onUpdate) onUpdate({ ...result, messages: [...result.messages] });
  };

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: model.provider,
    defaultModel: model.id,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3 },
    quietStartup: true,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [
      createProjectSandboxExtension({
        projectDir: cwd,
        bashEnv,
        extraReadOnlyRoots: [defaultAgentsDir(), ...(extraReadOnlyRoots ?? [])],
      }),
    ],
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPromptOverride: (base) =>
      agent.systemPrompt.trim() ? [...base, agent.systemPrompt] : base,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(cwd);

  let aborted = false;
  let sessionRef: { abort: () => Promise<void> } | undefined;
  const onAbort = () => {
    aborted = true;
    void sessionRef?.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      authStorage: parentCtx.modelRegistry.authStorage,
      modelRegistry: parentCtx.modelRegistry,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      tools: agent.tools,
    });
    sessionRef = session;

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end") {
        const msg = event.message as Message;
        result.messages.push(msg);

        if (msg.role === "assistant") {
          result.usage.turns++;
          const usage = (msg as { usage?: {
            input?: number; output?: number;
            cacheRead?: number; cacheWrite?: number;
            cost?: { total?: number };
            totalTokens?: number;
          } }).usage;
          if (usage) {
            result.usage.input += usage.input ?? 0;
            result.usage.output += usage.output ?? 0;
            result.usage.cacheRead += usage.cacheRead ?? 0;
            result.usage.cacheWrite += usage.cacheWrite ?? 0;
            result.usage.cost += usage.cost?.total ?? 0;
            result.usage.contextTokens = usage.totalTokens ?? result.usage.contextTokens;
          }
          const stopReason = (msg as { stopReason?: string }).stopReason;
          if (stopReason) result.stopReason = stopReason;
          const errorMessage = (msg as { errorMessage?: string }).errorMessage;
          if (errorMessage) result.errorMessage = errorMessage;
        }
        emit();
      }
    });

    try {
      await session.prompt(`Task: ${task}`);
    } finally {
      unsubscribe();
      session.dispose();
    }

    if (aborted) {
      result.exitCode = 130;
      result.errorMessage = result.errorMessage ?? "Subagent aborted";
    } else {
      const failed =
        result.stopReason === "error" ||
        result.stopReason === "aborted" ||
        Boolean(result.errorMessage);
      result.exitCode = failed ? 1 : 0;
    }
  } catch (err) {
    result.exitCode = 1;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    result.stderr = result.errorMessage;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  return result;
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to the parent's cwd)" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to the parent's cwd)" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to consult, on top of the bundled default-agents that are always available. Default: "project" (Zero ships repo-controlled agents in <project>/.pi/agents).',
  default: "project",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (single mode)" })),
});

export interface SubagentExtensionOptions {
  /** Default agentScope when the caller omits it. Default: "project". */
  defaultScope?: AgentScope;
  /**
   * Env vars injected into the child sandbox's bash subprocesses. Mirrors
   * the parent's `bashEnv` so subagents can reach `ZERO_PROXY_URL` with a
   * valid `ZERO_PROXY_TOKEN` — without this, `zero` CLI commands inside
   * subagents (e.g. `zero browser ...`) fail with no proxy configured.
   */
  childBashEnv?: Record<string, string>;
  /** Extra read-only roots applied to every child sandbox. */
  childExtraReadOnlyRoots?: string[];
}

export function createSubagentExtension(
  opts: SubagentExtensionOptions = {},
): ExtensionFactory {
  const defaultScope: AgentScope = opts.defaultScope ?? "project";
  const childBashEnv = opts.childBashEnv;
  const childExtraReadOnlyRoots = opts.childExtraReadOnlyRoots ?? [];

  return function subagent(pi: ExtensionAPI) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate tasks to specialized subagents with isolated context.",
        "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
        "Bundled agents are always available; set agentScope: \"both\" to also include ~/.pi/agent/agents.",
      ].join(" "),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const agentScope: AgentScope = params.agentScope ?? defaultScope;
        const discovery = discoverAgents(ctx.cwd, agentScope);
        const agents = discovery.agents;

        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

        const makeDetails =
          (mode: "single" | "parallel" | "chain") =>
          (results: SingleResult[]): SubagentDetails => ({
            mode,
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            results,
          });

        // Push a snapshot of the in-flight subagent state to the parent.
        // The parent emits `tool_execution_update` so the web UI can render
        // child tool calls / messages live instead of after the subagent
        // returns.
        const emitProgress = (
          mode: "single" | "parallel" | "chain",
          results: SingleResult[],
        ) => {
          if (!onUpdate) return;
          const last = results[results.length - 1];
          const previewText = last ? getFinalOutput(last.messages) : "";
          onUpdate({
            content: [{ type: "text", text: previewText || "(running...)" }],
            details: makeDetails(mode)(results),
          });
        };

        if (modeCount !== 1) {
          const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
              },
            ],
            details: makeDetails("single")([]),
          };
        }

        if (hasChain) {
          const results: SingleResult[] = [];
          let previousOutput = "";

          for (let i = 0; i < params.chain!.length; i++) {
            const step = params.chain![i]!;
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
            const result = await runSingleAgent({
              parentCtx: ctx,
              agents,
              agentName: step.agent,
              task: taskWithContext,
              cwdOverride: step.cwd,
              step: i + 1,
              signal,
              onUpdate: (snapshot) => emitProgress("chain", [...results, snapshot]),
              bashEnv: childBashEnv,
              extraReadOnlyRoots: childExtraReadOnlyRoots,
            });
            results.push(result);
            emitProgress("chain", results);

            const isError =
              result.exitCode !== 0 ||
              result.stopReason === "error" ||
              result.stopReason === "aborted";
            if (isError) {
              const errorMsg =
                result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
              return {
                content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                details: makeDetails("chain")(results),
                isError: true,
              };
            }
            previousOutput = getFinalOutput(result.messages);
          }
          return {
            content: [
              { type: "text", text: getFinalOutput(results[results.length - 1]!.messages) || "(no output)" },
            ],
            details: makeDetails("chain")(results),
          };
        }

        if (hasTasks) {
          if (params.tasks!.length > MAX_PARALLEL_TASKS) {
            return {
              content: [
                {
                  type: "text",
                  text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
              ],
              details: makeDetails("parallel")([]),
            };
          }

          const liveResults: SingleResult[] = params.tasks!.map((t) => ({
            agent: t.agent,
            agentSource: "unknown" as const,
            task: t.task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: emptyUsage(),
          }));
          emitProgress("parallel", liveResults);

          const results = await mapWithConcurrencyLimit(
            params.tasks!,
            MAX_CONCURRENCY,
            async (t, index) =>
              runSingleAgent({
                parentCtx: ctx,
                agents,
                agentName: t.agent,
                task: t.task,
                cwdOverride: t.cwd,
                signal,
                onUpdate: (snapshot) => {
                  liveResults[index] = snapshot;
                  emitProgress("parallel", liveResults);
                },
                bashEnv: childBashEnv,
                extraReadOnlyRoots: childExtraReadOnlyRoots,
              }),
          );

          const successCount = results.filter((r) => r.exitCode === 0).length;
          const summaries = results.map((r) => {
            const output = getFinalOutput(r.messages);
            const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
            return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
              },
            ],
            details: makeDetails("parallel")(results),
          };
        }

        // single
        const result = await runSingleAgent({
          parentCtx: ctx,
          agents,
          agentName: params.agent!,
          task: params.task!,
          cwdOverride: params.cwd,
          signal,
          onUpdate: (snapshot) => emitProgress("single", [snapshot]),
          bashEnv: childBashEnv,
          extraReadOnlyRoots: childExtraReadOnlyRoots,
        });
        const isError =
          result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          const errorMsg =
            result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      },
    });
  };
}

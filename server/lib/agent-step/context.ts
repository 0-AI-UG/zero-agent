/**
 * Shared context building for runAgentStep.
 *
 * Responsibilities factored out of routes/chat.ts, autonomous-agent.ts, and
 * routes/telegram.ts so all three paths go through the same logic for:
 *   - per-user token-limit enforcement
 *   - semantic context retrieval (memories + files)
 *   - previously-read-path seeding
 *   - agent instantiation with checkpoint wiring
 */
import type { Message, ToolCallPart } from "@/lib/messages/types.ts";
import { getFileById } from "@/db/queries/files.ts";
import { semanticSearch, isEmbeddingConfigured, embedValue } from "@/lib/search/vectors.ts";
import { getUserTokenTotal } from "@/db/queries/usage-logs.ts";
import { db } from "@/db/index.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/utils/logger.ts";

const ctxLog = log.child({ module: "agent-step:context" });

export interface TokenLimitRejection {
  used: number;
  limit: number;
  message: string;
}

/**
 * Check whether the user has exceeded their per-user token-usage limit.
 * Returns null if allowed, or a rejection object with a pre-formatted message.
 */
export function checkUserTokenLimit(userId: string | undefined): TokenLimitRejection | null {
  if (!userId) return null;
  const limitRow = db
    .prepare("SELECT token_limit FROM users WHERE id = ?")
    .get(userId) as { token_limit: number | null } | undefined;
  if (limitRow?.token_limit == null) return null;

  const used = getUserTokenTotal(userId);
  if (used < limitRow.token_limit) return null;

  return {
    used,
    limit: limitRow.token_limit,
    message:
      `You've reached your token usage limit (${used.toLocaleString()} / ` +
      `${limitRow.token_limit.toLocaleString()} tokens). Please ask an ` +
      `administrator to increase your usage limit to continue.`,
  };
}

/**
 * Walk prior UIMessages and collect file paths the agent has already
 * read/written so the read-guard can be seeded.
 */
export function extractReadPathsFromUIMessages(messages: Message[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== "tool-call") continue;
      const tc = part as ToolCallPart;
      if (tc.name !== "readFile" && tc.name !== "writeFile") continue;
      const args = tc.arguments as { path?: unknown } | undefined;
      if (typeof args?.path === "string") out.push(args.path);
    }
  }
  return out;
}

export interface RagContext {
  relevantMemories?: { content: string; score: number }[];
  relevantFiles?: { path: string }[];
}

/**
 * Retrieve semantic context (memories + files) for a query.
 * Tolerates embedding failures - returns empty arrays so the caller can
 * proceed without RAG context.
 */
export async function retrieveRagContext(
  projectId: string,
  queryText: string | undefined,
): Promise<RagContext> {
  if (!queryText || !isEmbeddingConfigured()) return {};

  const embedding = await embedValue(queryText).catch(() => null);
  const [memoryResults, fileResults] = await Promise.all([
    semanticSearch(projectId, "memory", queryText, 10, embedding ?? undefined).catch(() => []),
    semanticSearch(projectId, "file", queryText, 10, embedding ?? undefined).catch(() => []),
  ]);

  const relevantMemories = memoryResults.map((r) => ({ content: r.content, score: r.score }));

  const relevantFilesRaw = fileResults.map((r) => {
    const sourceId = (r.metadata.sourceId as string) ?? "";
    const file = sourceId ? getFileById(sourceId) : null;
    const path = file
      ? `${file.folder_path}${file.filename}`
      : (r.metadata.filename as string) ?? "unknown";
    return { path };
  });

  return {
    relevantMemories: relevantMemories.length > 0 ? relevantMemories : undefined,
    relevantFiles: relevantFilesRaw.length > 0 ? relevantFilesRaw : undefined,
  };
}

/**
 * Extended RAG retrieval used by the batch runner (autonomous + Telegram).
 * Includes historical messages alongside files + memories and renders them
 * as a markdown block ready to append to the prompt.
 */
export async function retrieveBatchContextBlock(
  projectId: string,
  queryText: string,
): Promise<string> {
  if (!isEmbeddingConfigured()) return "";

  try {
    const embedding = await embedValue(queryText);
    const [relevantFiles, relevantMemories, relevantHistory] = await Promise.all([
      semanticSearch(projectId, "file", queryText, 3, embedding),
      semanticSearch(projectId, "memory", queryText, 5, embedding),
      semanticSearch(projectId, "message", queryText, 3, embedding),
    ]);

    const sections: string[] = [];
    if (relevantFiles.length > 0) {
      sections.push(
        "### Related Files\n" +
          relevantFiles
            .map((r) => {
              const sourceId = r.metadata.sourceId as string | undefined;
              const file = sourceId ? getFileById(sourceId) : null;
              const path = file
                ? `${file.folder_path}${file.filename}`
                : ((r.metadata.filename as string | undefined) ?? "file");
              return `- ${path}`;
            })
            .join("\n"),
      );
    }
    if (relevantMemories.length > 0) {
      sections.push(
        "### Related Memories\n" + relevantMemories.map((r) => `- ${r.content}`).join("\n"),
      );
    }
    if (relevantHistory.length > 0) {
      sections.push(
        "### Related Past Conversations\n" +
          relevantHistory.map((r) => `- ${r.content.slice(0, 200)}`).join("\n"),
      );
    }

    if (sections.length === 0) return "";
    return `\n\n## Auto-Retrieved Context\n\n${sections.join("\n\n")}`;
  } catch (err) {
    ctxLog.warn("failed to retrieve batch RAG context", {
      projectId,
      error: String(err),
    });
    return "";
  }
}

/**
 * Best-effort read of HEARTBEAT.md. Returns null when the file is missing
 * or empty (only whitespace / section headers).
 */
export async function readHeartbeatChecklist(projectId: string): Promise<string | null> {
  try {
    const content = await readFromS3(`projects/${projectId}/HEARTBEAT.md`);
    const trimmed = content.trim();
    if (!trimmed || /^(#[^\n]*\n?\s*)*$/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Estimate how many tokens the next agent step will consume so the UI can
 * display a "compacting…" flag early. Prefers the last step's
 * `metadata.contextTokens` from the message history; falls back to a
 * character-based heuristic.
 */
export function willCompactionTrigger(
  messages: Message[],
  contextWindow: number,
): boolean {
  let estimatedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const ctx = (messages[i]!.metadata as Record<string, unknown> | undefined)?.contextTokens;
    if (typeof ctx === "number" && ctx > 0) {
      estimatedTokens = ctx;
      break;
    }
  }
  if (estimatedTokens === 0) {
    estimatedTokens = Math.ceil(JSON.stringify(messages).length / 3);
  }
  return estimatedTokens >= contextWindow * 0.85 && messages.length > 20;
}

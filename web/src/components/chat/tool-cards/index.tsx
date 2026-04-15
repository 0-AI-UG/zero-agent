import { memo } from "react";
import { isToolUIPart, getToolName } from "@/lib/messages";
import type { Message } from "@/lib/messages";
import type { SyncProposal } from "@/components/chat-ui/SyncApproval";
import { BashCard } from "./BashCard";
import { WriteFileCard } from "./WriteFileCard";
import { ForwardPortCard } from "./ForwardPortCard";
import { DisplayFileCard } from "./DisplayFileCard";
import { ParallelSubagentCard } from "./ParallelSubagentCard";
import { PlanReviewCard } from "./PlanReviewCard";
import { StatusLine } from "./StatusLine";
import { EditDiffCard } from "./EditDiffCard";
import { CliReadCard, CliWriteCard } from "./CliFileCard";
import { CliTaskCard } from "./CliTaskCard";
import { CliTodoCard } from "./CliTodoCard";
import { HIDDEN_TOOLS } from "./tool-config";

export { getToolActiveLabel, HIDDEN_TOOLS } from "./tool-config";

type Part = Message["parts"][number];

/**
 * Returns true if an assistant message part produces visible content in the
 * chat UI. Hidden tools, empty text, and non-image files are invisible.
 *
 * Centralised here so `MessageRow` and `shimmerLabel` share one predicate
 * and stay in sync when the renderer changes.
 */
export function isVisiblePart(p: Part): boolean {
  if (isToolUIPart(p)) return !HIDDEN_TOOLS.has(getToolName(p));
  if (p.type === "text") return p.text.length > 0;
  if (p.type === "file") {
    const mt = (p as { mediaType?: string }).mediaType;
    return typeof mt === "string" && mt.startsWith("image/");
  }
  return false;
}

interface Ctx {
  projectId?: string;
  chatId?: string;
}

function outputAsString(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) =>
        typeof b === "object" && b && "text" in b
          ? String((b as { text?: unknown }).text ?? "")
          : String(b),
      )
      .join("");
  }
  if (typeof output === "object") {
    const o = output as { text?: unknown; content?: unknown };
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  return "";
}

/**
 * Renders a single tool-call part. Memoized so streaming new parts into a
 * message doesn't re-render completed tool cards.
 */
export const ToolCard = memo(
  function ToolCard({ part, projectId, chatId }: { part: Part } & Ctx) {
    if (!isToolUIPart(part)) return null;
    const toolName = getToolName(part);
    if (HIDDEN_TOOLS.has(toolName)) return null;

    const isLoading = part.state === "input-streaming" || part.state === "input-available";
    const hasOutput = part.state === "output-available" || part.state === "output-error";
    const hasError = part.state === "output-error";
    const args = part.arguments as Record<string, unknown> | undefined;
    const rawOutput = part.output;
    const output = (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput))
      ? (rawOutput as Record<string, unknown>)
      : undefined;

    if (toolName === "agent" && part.state !== "input-streaming") {
      return (
        <ParallelSubagentCard
          input={{ tasks: (args?.tasks as Array<{ prompt: string }>) ?? [] }}
          output={hasOutput ? (output as Parameters<typeof ParallelSubagentCard>[0]["output"]) : null}
          isRunning={isLoading}
        />
      );
    }

    if (toolName === "finishPlanning" && projectId && chatId) {
      return (
        <PlanReviewCard
          planFilePath={(args?.planFilePath as string) ?? ""}
          summary={(args?.summary as string) ?? ""}
          chatId={chatId}
          projectId={projectId}
          isPending={isLoading}
        />
      );
    }

    // ── CLI-backend tools (Claude Code / Codex emit capitalized names) ──────
    if (toolName === "Bash") {
      if (!hasOutput) return <StatusLine toolName={toolName} state={part.state} args={args} />;
      const text = outputAsString(rawOutput);
      return (
        <BashCard
          output={hasError ? { error: text || "failed" } : { stdout: text }}
          command={(args?.command as string) ?? undefined}
        />
      );
    }

    if (toolName === "Edit" || toolName === "MultiEdit") {
      return <EditDiffCard args={args} hasError={hasError} />;
    }

    if (toolName === "Read") {
      if (!hasOutput) return <StatusLine toolName={toolName} state={part.state} args={args} />;
      return <CliReadCard args={args} output={rawOutput} hasError={hasError} />;
    }

    if (toolName === "Write") {
      return <CliWriteCard args={args} hasError={hasError} />;
    }

    if (toolName === "Task") {
      return (
        <CliTaskCard
          args={args}
          output={rawOutput}
          isRunning={isLoading}
          hasError={hasError}
        />
      );
    }

    if (toolName === "TodoWrite") {
      return <CliTodoCard args={args} />;
    }

    if (hasOutput && output) {
      if (toolName === "displayFile" && output.fileId && projectId) {
        return (
          <DisplayFileCard
            fileId={output.fileId as string}
            filename={output.filename as string}
            mimeType={output.mimeType as string}
            projectId={projectId}
            caption={output.caption as string | undefined}
          />
        );
      }
      if (toolName === "writeFile" && output.fileId) {
        return <WriteFileCard output={output} projectId={projectId} />;
      }
      if (toolName === "bash") {
        return (
          <BashCard
            output={output}
            command={(args?.command as string) ?? undefined}
          />
        );
      }
      if (toolName === "forwardPort") {
        return <ForwardPortCard input={args ?? {}} output={output} />;
      }
    }

    const isImageRead = toolName === "readFile" && (output as { type?: string } | undefined)?.type === "image";
    return <StatusLine toolName={toolName} state={part.state} args={args} isImageRead={isImageRead} />;
  },
  (prev, next) =>
    prev.part === next.part &&
    prev.projectId === next.projectId &&
    prev.chatId === next.chatId,
);

export type { SyncProposal };

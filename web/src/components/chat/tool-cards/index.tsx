import { memo } from "react";
import { isToolUIPart, getToolName } from "@/lib/messages";
import type { Message } from "@/lib/messages";
import { BashCard } from "./BashCard";
import { WriteFileCard } from "./WriteFileCard";
import { ForwardPortCard } from "./ForwardPortCard";
import { DisplayFileCard } from "./DisplayFileCard";
import { ParallelSubagentCard } from "./ParallelSubagentCard";
import { PlanReviewCard } from "./PlanReviewCard";
import { StatusLine } from "./StatusLine";
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
  if (p.type === "reasoning") return p.text.length > 0;
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
    const hasOutput = part.state === "output-available";
    const args = part.input as Record<string, unknown> | undefined;
    const output = part.output as Record<string, unknown> | undefined;

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

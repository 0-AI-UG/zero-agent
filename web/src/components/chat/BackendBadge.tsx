import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface CliBackendInfo {
  label: string;
  tooltip: string;
}

function resolveBackend(modelId: string | undefined): CliBackendInfo | null {
  if (!modelId) return null;
  if (modelId.startsWith("claude-code/")) {
    return {
      label: "Claude Code",
      tooltip:
        "This reply came from the Claude Code CLI running in your container. It uses Claude's own tool set — writes are applied directly in the container and bypass the S3 approval flow.",
    };
  }
  if (modelId.startsWith("codex/")) {
    return {
      label: "Codex",
      tooltip:
        "This reply came from the Codex CLI running in your container. It uses Codex's own tool set — writes are applied directly in the container and bypass the S3 approval flow.",
    };
  }
  return null;
}

export function BackendBadge({ modelId }: { modelId: string | undefined }) {
  const info = resolveBackend(modelId);
  if (!info) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary/70" />
          {info.label} CLI
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        {info.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

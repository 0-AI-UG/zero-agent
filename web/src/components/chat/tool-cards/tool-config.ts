import {
  DownloadIcon,
  FileTextIcon,
  ImageIcon,
  NetworkIcon,
  PencilIcon,
  TerminalSquareIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ToolConfig {
  label: string;
  activeLabel: string;
  icon: LucideIcon;
}

const TOOL_CONFIG: Record<string, ToolConfig> = {
  readFile: { label: "Read file", activeLabel: "Reading file", icon: FileTextIcon },
  writeFile: { label: "Wrote file", activeLabel: "Writing file", icon: PencilIcon },
  editFile: { label: "Edited file", activeLabel: "Editing file", icon: PencilIcon },
  displayFile: { label: "Displayed file", activeLabel: "Loading file", icon: ImageIcon },
  agent: { label: "Agents completed", activeLabel: "Running agents", icon: SparklesIcon },
  loadSkill: { label: "Loaded skill", activeLabel: "Loading skill", icon: DownloadIcon },
  bash: { label: "Ran command", activeLabel: "Running command", icon: TerminalSquareIcon },
  forwardPort: { label: "Forwarded port", activeLabel: "Forwarding port", icon: NetworkIcon },
  finishPlanning: { label: "Plan ready", activeLabel: "Preparing plan", icon: FileTextIcon },
};

const FALLBACK: ToolConfig = {
  label: "Done",
  activeLabel: "Working",
  icon: SearchIcon,
};

export function getToolConfig(toolName: string): ToolConfig {
  return TOOL_CONFIG[toolName] ?? FALLBACK;
}

export function getToolActiveLabel(toolName: string): string {
  return getToolConfig(toolName).activeLabel;
}

/** Short detail string shown beside the tool label (e.g. path, command). */
export function getToolDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case "readFile":
    case "writeFile":
    case "editFile":
    case "displayFile":
      return typeof inp.path === "string" ? inp.path : null;
    case "agent": {
      const tasks = inp.tasks as unknown[] | undefined;
      if (!tasks) return null;
      const bg = inp.background === true;
      return bg
        ? `${tasks.length} background task${tasks.length !== 1 ? "s" : ""}`
        : `${tasks.length} parallel tasks`;
    }
    case "loadSkill":
      return typeof inp.name === "string" ? inp.name : null;
    case "bash": {
      const cmd = (inp as { command?: unknown }).command;
      if (typeof cmd !== "string" || !cmd) return null;
      return cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
    }
    case "forwardPort": {
      const port = inp.port;
      const label = inp.label;
      if (typeof label === "string") return `${label} (:${port})`;
      return typeof port === "number" ? `Port ${port}` : null;
    }
    default:
      return null;
  }
}

/** Tools that never render anywhere in chat UI. */
export const HIDDEN_TOOLS = new Set([
  "progressCreate",
  "progressUpdate",
  "progressList",
]);

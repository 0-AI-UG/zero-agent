import {
  DownloadIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
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

  // CLI-backend tool names (Claude Code / Codex emit capitalized names)
  Bash: { label: "Ran command", activeLabel: "Running command", icon: TerminalSquareIcon },
  Read: { label: "Read file", activeLabel: "Reading file", icon: FileTextIcon },
  Write: { label: "Wrote file", activeLabel: "Writing file", icon: PencilIcon },
  Edit: { label: "Edited file", activeLabel: "Editing file", icon: PencilIcon },
  MultiEdit: { label: "Edited file", activeLabel: "Editing file", icon: PencilIcon },
  Glob: { label: "Searched files", activeLabel: "Searching files", icon: SearchIcon },
  Grep: { label: "Searched text", activeLabel: "Searching text", icon: SearchIcon },
  WebFetch: { label: "Fetched web page", activeLabel: "Fetching web page", icon: GlobeIcon },
  WebSearch: { label: "Searched the web", activeLabel: "Searching the web", icon: GlobeIcon },
  Task: { label: "Sub-agent done", activeLabel: "Running sub-agent", icon: SparklesIcon },
  TodoWrite: { label: "Updated todos", activeLabel: "Updating todos", icon: ListTodoIcon },
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
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof inp.file_path === "string" ? inp.file_path : null;
    case "Glob":
      return typeof inp.pattern === "string" ? inp.pattern : null;
    case "Grep":
      return typeof inp.pattern === "string" ? inp.pattern : null;
    case "WebFetch":
    case "WebSearch":
      return typeof inp.url === "string"
        ? inp.url
        : typeof inp.query === "string"
          ? inp.query
          : null;
    case "Task":
      return typeof inp.description === "string" ? inp.description : null;
    case "Bash": {
      const cmd = (inp as { command?: unknown }).command;
      if (typeof cmd !== "string" || !cmd) return null;
      return cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
    }
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

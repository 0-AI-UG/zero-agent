export interface ToolGroup {
  id: string;
  label: string;
  icon: string; // lucide icon name for reference
  tools: string[];
}

// Only in-process tools are toggleable here. On-demand tools (web, image,
// scheduling, browser, credentials, message, search, etc.) live in the `zero`
// CLI and the agent reaches them via `bash`, so they're not user-toggleable.
export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "agent",
    label: "Sub Agents",
    icon: "Sparkles",
    tools: ["agent"],
  },
  {
    id: "files",
    label: "File Operations",
    icon: "FolderOpen",
    tools: ["readFile", "writeFile", "editFile"],
  },
  {
    id: "code",
    label: "Code Execution",
    icon: "Terminal",
    tools: ["bash"],
  },
  {
    id: "skills",
    label: "Skills",
    icon: "Puzzle",
    tools: ["loadSkill"],
  },
  {
    id: "progress",
    label: "Progress",
    icon: "ListTodo",
    tools: ["progressCreate", "progressUpdate", "progressList"],
  },
];

/** Tool groups available to automation/scheduled tasks (excludes agent spawning). */
export const AUTOMATION_TOOL_GROUPS: ToolGroup[] = TOOL_GROUPS.filter(
  (g) => g.id !== "agent",
);

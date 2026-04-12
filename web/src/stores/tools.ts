import { create } from "zustand";
import { persist } from "zustand/middleware";

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
    tools: ["bash", "forwardPort"],
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

export const ALL_TOOL_NAMES = TOOL_GROUPS.flatMap((g) => g.tools);

/** Tool groups available to automation/scheduled tasks (excludes agent spawning). */
export const AUTOMATION_TOOL_GROUPS: ToolGroup[] = TOOL_GROUPS.filter(
  (g) => g.id !== "agent",
);

interface ToolsState {
  /** Tools that are disabled (all enabled by default) */
  disabledTools: Set<string>;
  toggleGroup: (groupId: string) => void;
  isGroupEnabled: (groupId: string) => boolean;
  isGroupPartial: (groupId: string) => boolean;
  getDisabledToolsList: () => string[];
}

export const useToolsStore = create<ToolsState>()(
  persist(
    (set, get) => ({
      disabledTools: new Set<string>(),

      toggleGroup: (groupId: string) => {
        const group = TOOL_GROUPS.find((g) => g.id === groupId);
        if (!group) return;

        set((state) => {
          const next = new Set(state.disabledTools);
          const allDisabled = group.tools.every((t) => next.has(t));

          if (allDisabled) {
            // Enable all tools in group
            for (const t of group.tools) next.delete(t);
          } else {
            // Disable all tools in group
            for (const t of group.tools) next.add(t);
          }

          return { disabledTools: next };
        });
      },

      isGroupEnabled: (groupId: string) => {
        const group = TOOL_GROUPS.find((g) => g.id === groupId);
        if (!group) return true;
        return group.tools.every((t) => !get().disabledTools.has(t));
      },

      isGroupPartial: (groupId: string) => {
        const group = TOOL_GROUPS.find((g) => g.id === groupId);
        if (!group) return false;
        const disabledCount = group.tools.filter((t) =>
          get().disabledTools.has(t)
        ).length;
        return disabledCount > 0 && disabledCount < group.tools.length;
      },

      getDisabledToolsList: () => Array.from(get().disabledTools),
    }),
    {
      name: "tool-settings",
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          const parsed = JSON.parse(str);
          // Convert array back to Set
          if (parsed?.state?.disabledTools) {
            parsed.state.disabledTools = new Set(parsed.state.disabledTools);
          }
          return parsed;
        },
        setItem: (name, value) => {
          // Convert Set to array for serialization
          const toStore = {
            ...value,
            state: {
              ...value.state,
              disabledTools: Array.from(value.state.disabledTools),
            },
          };
          localStorage.setItem(name, JSON.stringify(toStore));
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    }
  )
);

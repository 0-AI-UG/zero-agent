import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ToolGroup {
  id: string;
  label: string;
  icon: string; // lucide icon name for reference
  tools: string[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "agent",
    label: "Sub Agents",
    icon: "Sparkles",
    tools: ["agent"],
  },
  {
    id: "leads",
    label: "Lead Management",
    icon: "Users",
    tools: ["saveLead", "updateLead", "appendLeadNote", "listLeads"],
  },
  {
    id: "files",
    label: "File Operations",
    icon: "FolderOpen",
    tools: [
      "readFile",
      "writeFile",
      "editFile",
      "listFiles",
      "searchFiles",
      "moveFile",
      "createFolder",
      "delete",
    ],
  },
  {
    id: "web",
    label: "Web & Browse",
    icon: "Globe",
    tools: ["searchWeb", "fetchUrl", "browser"],
  },
  {
    id: "creative",
    label: "Image Generation",
    icon: "Image",
    tools: ["generateImage"],
  },
  {
    id: "code",
    label: "Code Execution",
    icon: "Terminal",
    tools: ["runPython"],
  },
  {
    id: "outreach",
    label: "Outreach",
    icon: "Send",
    tools: [
      "sendDirectMessage",
      "getOutreachHistory",
      "getApprovedMessages",
      "updateOutreachStatus",
      "recordOutreachReply",
    ],
  },
  {
    id: "scheduling",
    label: "Scheduling",
    icon: "Calendar",
    tools: [
      "scheduleTask",
      "listScheduledTasks",
      "updateScheduledTask",
      "removeScheduledTask",
    ],
  },
];

export const ALL_TOOL_NAMES = TOOL_GROUPS.flatMap((g) => g.tools);

/** Tool groups available for automation tasks (includes automation-only tools). */
export const AUTOMATION_TOOL_GROUPS: ToolGroup[] = [
  {
    id: "leads",
    label: "Lead Management",
    icon: "Users",
    tools: ["saveLead", "updateLead", "appendLeadNote", "listLeads"],
  },
  {
    id: "outreach",
    label: "Outreach",
    icon: "Send",
    tools: [
      "sendDirectMessage",
      "getOutreachHistory",
      "getApprovedMessages",
      "updateOutreachStatus",
      "recordOutreachReply",
    ],
  },
  {
    id: "web",
    label: "Web & Browse",
    icon: "Globe",
    tools: ["searchWeb", "fetchUrl", "browser"],
  },
  {
    id: "files",
    label: "File Operations",
    icon: "FolderOpen",
    tools: ["readFile", "writeFile", "editFile", "listFiles", "searchFiles"],
  },
  {
    id: "creative",
    label: "Image Generation",
    icon: "Image",
    tools: ["generateImage"],
  },
  {
    id: "code",
    label: "Code Execution",
    icon: "Terminal",
    tools: ["runPython"],
  },
];

export const ALL_AUTOMATION_TOOL_NAMES = AUTOMATION_TOOL_GROUPS.flatMap((g) => g.tools);

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

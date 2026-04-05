export const queryKeys = {
  projects: {
    all: ["projects"] as const,
    detail: (id: string) => ["project", id] as const,
  },
  chats: {
    byProject: (projectId: string) => ["chats", projectId] as const,
  },
  messages: {
    byProject: (projectId: string) => ["messages", projectId] as const,
    byChat: (projectId: string, chatId: string) =>
      ["messages", projectId, chatId] as const,
  },
  files: {
    byProject: (projectId: string, folderPath?: string) =>
      folderPath
        ? (["files", projectId, folderPath] as const)
        : (["files", projectId] as const),
    search: (projectId: string, query: string) =>
      ["files", "search", projectId, query] as const,
  },
  tasks: {
    byProject: (projectId: string) => ["tasks", projectId] as const,
    runs: (projectId: string, taskId: string) =>
      ["task-runs", projectId, taskId] as const,
  },
  members: {
    byProject: (projectId: string) => ["members", projectId] as const,
  },
  invitations: {
    mine: ["invitations"] as const,
  },
  todos: {
    byChat: (projectId: string, chatId: string) =>
      ["todos", projectId, chatId] as const,
  },
  skills: {
    byProject: (projectId: string) => ["skills", projectId] as const,
  },
  templates: {
    community: (search?: string, category?: string) =>
      ["templates", "community", search ?? "", category ?? ""] as const,
  },
  telegram: {
    status: (projectId: string) => ["telegram", "status", projectId] as const,
  },
  quickActions: {
    byProject: (projectId: string) => ["quick-actions", projectId] as const,
  },
  credentials: {
    byProject: (projectId: string) => ["credentials", projectId] as const,
  },
  services: {
    byProject: (projectId: string) => ["services", projectId] as const,
  },
  containers: {
    all: ["containers"] as const,
    byChat: (projectId: string, chatId: string) =>
      ["containers", projectId, chatId] as const,
    browserScreenshot: (projectId: string, chatId: string) =>
      ["containers", "screenshot", projectId, chatId] as const,
  },
} as const;

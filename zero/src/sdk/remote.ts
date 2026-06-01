/**
 * Remote-mode SDK: control-plane operations a laptop companion performs
 * against the zero server's public /api surface. These mirror a subset of the
 * web app's REST calls (projects, scheduled tasks) and are used by the CLI
 * when it is logged in (a ~/.zero/config.json companion token is present)
 * rather than running inside a runner container.
 */
import { apiRequest, resolveProjectId } from "./remote-client.ts";
import { loadConfig, hasConfig } from "./config.ts";

/** True when the CLI should operate against a remote server (laptop mode). */
export function isRemoteMode(): boolean {
  // In-container runs set ZERO_PROXY_URL; laptop runs rely on a saved config.
  return !process.env.ZERO_PROXY_URL && hasConfig();
}

export interface RemoteProject {
  id: string;
  name: string;
  description: string;
  role: string;
  isArchived: boolean;
}

export interface RemoteTask {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  triggerType: "schedule" | "event" | "script";
  triggerEvent: string | null;
  scriptPath: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
}

export interface CreateRemoteTaskInput {
  name: string;
  prompt: string;
  schedule?: string;
  triggerType?: "schedule" | "event" | "script";
  triggerEvent?: string;
  scriptPath?: string;
  cooldownSeconds?: number;
}

export const remote = {
  /** The bound project from config, or null when not logged in. */
  boundProject(): { id: string; name?: string } | null {
    const cfg = loadConfig();
    return cfg ? { id: cfg.projectId, name: cfg.projectName } : null;
  },

  async listProjects(): Promise<RemoteProject[]> {
    // A companion token is single-project scoped, so /api/projects (account
    // wide) is denied. Fetch just the bound project instead.
    const projectId = resolveProjectId();
    const data = await apiRequest<{ project?: RemoteProject } | RemoteProject>(
      "GET",
      `/api/projects/${projectId}`,
    );
    const project = (data as any).project ?? data;
    return project ? [project as RemoteProject] : [];
  },

  async listTasks(projectId?: string): Promise<RemoteTask[]> {
    const pid = resolveProjectId(projectId);
    const data = await apiRequest<{ tasks: RemoteTask[] }>(
      "GET",
      `/api/projects/${pid}/tasks`,
    );
    return data.tasks;
  },

  async addTask(input: CreateRemoteTaskInput, projectId?: string): Promise<RemoteTask> {
    const pid = resolveProjectId(projectId);
    const data = await apiRequest<{ task: RemoteTask }>(
      "POST",
      `/api/projects/${pid}/tasks`,
      input,
    );
    return data.task;
  },

  async removeTask(taskId: string, projectId?: string): Promise<void> {
    const pid = resolveProjectId(projectId);
    await apiRequest("DELETE", `/api/projects/${pid}/tasks/${taskId}`);
  },

  async runTask(taskId: string, projectId?: string): Promise<void> {
    const pid = resolveProjectId(projectId);
    await apiRequest("POST", `/api/projects/${pid}/tasks/${taskId}/run`, {});
  },
};

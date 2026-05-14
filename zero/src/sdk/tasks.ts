import { call, type CallOptions } from "./client.ts";
import {
  TasksAddInput,
  TasksListInput,
  TasksUpdateInput,
  TasksRemoveInput,
  type TasksAddInputT,
  type TasksUpdateInputT,
} from "./schemas.ts";

export interface Task {
  id: string;
  name: string;
  prompt: string;
  triggerType: "schedule" | "event" | "script";
  schedule?: string;
  triggerEvent?: string;
  triggerFilter?: Record<string, string>;
  cooldownSeconds?: number;
  scriptPath?: string | null;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount?: number;
}

export type AddTaskInput = TasksAddInputT;
export type UpdateTaskInput = TasksUpdateInputT;

export const tasks = {
  add(input: AddTaskInput, options?: CallOptions): Promise<Task> {
    return call<Task>("/zero/tasks/add", TasksAddInput.parse(input), options);
  },
  list(options?: CallOptions): Promise<{ tasks: Task[] }> {
    return call<{ tasks: Task[] }>("/zero/tasks/list", TasksListInput.parse({}), options);
  },
  update(input: UpdateTaskInput, options?: CallOptions): Promise<Task> {
    return call<Task>("/zero/tasks/update", TasksUpdateInput.parse(input), options);
  },
  remove(taskId: string, options?: CallOptions): Promise<{ success: boolean; deletedTask: string }> {
    return call<{ success: boolean; deletedTask: string }>(
      "/zero/tasks/remove",
      TasksRemoveInput.parse({ taskId }),
      options,
    );
  },
};

import { call, type CallOptions } from "./client.ts";
import {
  ScheduleAddInput,
  ScheduleListInput,
  ScheduleUpdateInput,
  ScheduleRemoveInput,
  type ScheduleAddInputT,
  type ScheduleUpdateInputT,
} from "./schemas.ts";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  triggerType: "schedule" | "event";
  schedule?: string;
  triggerEvent?: string;
  triggerFilter?: Record<string, string>;
  cooldownSeconds?: number;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount?: number;
}

export type AddTaskInput = ScheduleAddInputT;
export type UpdateTaskInput = ScheduleUpdateInputT;

export const schedule = {
  add(input: AddTaskInput, options?: CallOptions): Promise<ScheduledTask> {
    return call<ScheduledTask>("/zero/schedule/add", ScheduleAddInput.parse(input), options);
  },
  list(options?: CallOptions): Promise<{ tasks: ScheduledTask[] }> {
    return call<{ tasks: ScheduledTask[] }>("/zero/schedule/list", ScheduleListInput.parse({}), options);
  },
  update(input: UpdateTaskInput, options?: CallOptions): Promise<ScheduledTask> {
    return call<ScheduledTask>("/zero/schedule/update", ScheduleUpdateInput.parse(input), options);
  },
  remove(taskId: string, options?: CallOptions): Promise<{ success: boolean; deletedTask: string }> {
    return call<{ success: boolean; deletedTask: string }>(
      "/zero/schedule/remove",
      ScheduleRemoveInput.parse({ taskId }),
      options,
    );
  },
};

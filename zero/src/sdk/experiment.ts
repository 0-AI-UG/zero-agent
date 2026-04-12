import { call, type CallOptions } from "./client.ts";
import {
  ExperimentCreateInput,
  ExperimentStartInput,
  ExperimentEvaluateInput,
  ExperimentStatusInput,
  ExperimentStopInput,
  ExperimentListInput,
  type ExperimentCreateInputT,
  type ExperimentEvaluateInputT,
} from "./schemas.ts";

export interface Experiment {
  id: string;
  name: string;
  metricPattern: string;
  direction: "minimize" | "maximize";
  instructionsPath?: string;
  targetPath?: string;
  schedule: string;
  baselineMetric?: number;
  bestMetric?: number;
  iterationCount: number;
  status: string;
  createdAt: string;
}

export interface EvaluateResult {
  status: "kept" | "discarded" | "error";
  metric: number | null;
  best: number | null;
  iteration: number;
  description: string;
}

export interface ExperimentStatus {
  id: string;
  name: string;
  status: string;
  iterationCount: number;
  baselineMetric: number | null;
  bestMetric: number | null;
  successRate: number;
  recentResults: Array<{
    iteration: number;
    status: string;
    metric: number | null;
    description: string;
    notes?: string;
  }>;
}

export type CreateExperimentInput = ExperimentCreateInputT;
export type EvaluateExperimentInput = ExperimentEvaluateInputT;

export const experiment = {
  create(input: CreateExperimentInput, options?: CallOptions): Promise<Experiment> {
    return call<Experiment>("/zero/experiment/create", ExperimentCreateInput.parse(input), options);
  },
  start(id: string, options?: CallOptions): Promise<Experiment> {
    return call<Experiment>("/zero/experiment/start", ExperimentStartInput.parse({ id }), options);
  },
  evaluate(input: EvaluateExperimentInput, options?: CallOptions): Promise<EvaluateResult> {
    return call<EvaluateResult>("/zero/experiment/evaluate", ExperimentEvaluateInput.parse(input), options);
  },
  status(id: string, options?: CallOptions): Promise<ExperimentStatus> {
    return call<ExperimentStatus>("/zero/experiment/status", ExperimentStatusInput.parse({ id }), options);
  },
  stop(id: string, options?: CallOptions): Promise<Experiment> {
    return call<Experiment>("/zero/experiment/stop", ExperimentStopInput.parse({ id }), options);
  },
  list(options?: CallOptions): Promise<{ experiments: Experiment[] }> {
    return call<{ experiments: Experiment[] }>("/zero/experiment/list", ExperimentListInput.parse({}), options);
  },
};

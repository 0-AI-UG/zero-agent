import { db, generateId } from "@/db/index.ts";
import type { UsageLogRow } from "@/db/types.ts";

const insert = db.prepare(
  `INSERT INTO usage_logs (id, user_id, project_id, chat_id, model_id, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cost_input, cost_output, duration_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

export interface UsageLogInput {
  userId: string;
  projectId: string;
  chatId: string | null;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costInput: number;
  costOutput: number;
  durationMs: number | null;
}

export function insertUsageLog(data: UsageLogInput): void {
  const id = generateId();
  insert.run(
    id, data.userId, data.projectId, data.chatId, data.modelId,
    data.inputTokens, data.outputTokens, data.reasoningTokens, data.cachedTokens,
    data.costInput, data.costOutput, data.durationMs,
  );
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostInput: number;
  totalCostOutput: number;
  totalCost: number;
}

export function getUsageSummary(opts?: { from?: string; to?: string }): UsageSummary {
  let sql = `SELECT count(*) as totalRequests, coalesce(sum(input_tokens),0) as totalInputTokens, coalesce(sum(output_tokens),0) as totalOutputTokens, coalesce(sum(cost_input),0) as totalCostInput, coalesce(sum(cost_output),0) as totalCostOutput, coalesce(sum(cost_input + cost_output),0) as totalCost FROM usage_logs`;
  const conditions: string[] = [];
  const params: string[] = [];
  if (opts?.from) { conditions.push("created_at >= ?"); params.push(opts.from); }
  if (opts?.to) { conditions.push("created_at <= ?"); params.push(opts.to); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  return db.query<UsageSummary, string[]>(sql).get(...params) as UsageSummary;
}

export interface UsageByModel {
  modelId: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export function getUsageByModel(opts?: { from?: string; to?: string }): UsageByModel[] {
  let sql = `SELECT model_id as modelId, count(*) as totalRequests, coalesce(sum(input_tokens),0) as totalInputTokens, coalesce(sum(output_tokens),0) as totalOutputTokens, coalesce(sum(cost_input + cost_output),0) as totalCost FROM usage_logs`;
  const conditions: string[] = [];
  const params: string[] = [];
  if (opts?.from) { conditions.push("created_at >= ?"); params.push(opts.from); }
  if (opts?.to) { conditions.push("created_at <= ?"); params.push(opts.to); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " GROUP BY model_id ORDER BY totalCost DESC";
  return db.query<UsageByModel, string[]>(sql).all(...params);
}

export interface UsageByUser {
  userId: string;
  email: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export function getUsageByUser(opts?: { from?: string; to?: string }): UsageByUser[] {
  let sql = `SELECT u.user_id as userId, users.email as email, count(*) as totalRequests, coalesce(sum(u.input_tokens),0) as totalInputTokens, coalesce(sum(u.output_tokens),0) as totalOutputTokens, coalesce(sum(u.cost_input + u.cost_output),0) as totalCost FROM usage_logs u LEFT JOIN users ON u.user_id = users.id`;
  const conditions: string[] = [];
  const params: string[] = [];
  if (opts?.from) { conditions.push("u.created_at >= ?"); params.push(opts.from); }
  if (opts?.to) { conditions.push("u.created_at <= ?"); params.push(opts.to); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " GROUP BY u.user_id ORDER BY totalCost DESC";
  return db.query<UsageByUser, string[]>(sql).all(...params);
}

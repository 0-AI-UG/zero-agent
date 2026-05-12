/**
 * In-memory fire registry for script-triggered tasks.
 *
 * The script-runner spawns a Bun process; while the script runs it may call
 * `trigger.fire({prompt?, payload?})` zero or more times. Each call POSTs to
 * the server cli-handler, which records the intent here keyed by task+run id.
 * After the script exits, the script-runner reads the buffered fires (and
 * clears them) to decide whether to wake the agent.
 */
export interface FireRecord {
  prompt?: string;
  payload?: Record<string, unknown>;
}

const fires = new Map<string, FireRecord[]>();

function k(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

export function recordFire(taskId: string, runId: string, record: FireRecord): void {
  const key = k(taskId, runId);
  const arr = fires.get(key);
  if (arr) arr.push(record);
  else fires.set(key, [record]);
}

export function takeFires(taskId: string, runId: string): FireRecord[] {
  const key = k(taskId, runId);
  const arr = fires.get(key) ?? [];
  fires.delete(key);
  return arr;
}

/** Test-only. */
export function _clearFires(): void {
  fires.clear();
}

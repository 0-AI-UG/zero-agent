/**
 * In-process counters for CLI-backend turn outcomes. No external metrics
 * system exists in the server today, so we expose a minimal counter map
 * and periodically snapshot it to the structured log — downstream log
 * scraping can aggregate rates from there.
 *
 * Events: `started` at turn entry; one of `completed | aborted | errored`
 * at exit. Backends call both — there's no shared abstraction wrapping
 * them, but the pairing is small enough to keep inline.
 */
import { log } from "@/lib/utils/logger.ts";

const metricsLog = log.child({ module: "backend:cli-metrics" });

export type CliTurnEvent = "started" | "completed" | "aborted" | "errored";

type CounterKey = `${string}:${CliTurnEvent}`;
const counters = new Map<CounterKey, number>();

export function recordTurn(backendId: string, event: CliTurnEvent): void {
  const key: CounterKey = `${backendId}:${event}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** Snapshot the current counter map (test + ops introspection). */
export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

/**
 * Emit a structured log line with the current counter snapshot, and
 * optionally reset. We keep running totals rather than per-window rates
 * — downstream tooling can diff consecutive snapshots for a rate.
 */
export function logCounterSnapshot(): void {
  const snap = snapshotCounters();
  if (Object.keys(snap).length === 0) return;
  metricsLog.info("cli-turn-counters", snap);
}

/**
 * Emit a structured alert log. Separate from recordTurn so the counter
 * increment is unconditional while alerts can be gated on thresholds
 * by whatever ingests the logs (exit code ≠ 0 rate, OAuth failure rate,
 * runner exec-stream 5xx rate). `alert: true` is the stable field log
 * scrapers key on.
 */
export function emitAlert(
  reason: string,
  ctx: Record<string, unknown>,
): void {
  metricsLog.warn(reason, { alert: true, ...ctx });
}

// Start a background snapshot emitter. 60s cadence — frequent enough to
// see rates but quiet enough not to spam logs.
const SNAPSHOT_INTERVAL_MS = 60_000;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

export function startMetricsSnapshotLoop(): void {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(logCounterSnapshot, SNAPSHOT_INTERVAL_MS);
  // Don't hold the event loop open for a metrics timer.
  if (typeof snapshotTimer.unref === "function") snapshotTimer.unref();
}

export function stopMetricsSnapshotLoop(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

startMetricsSnapshotLoop();

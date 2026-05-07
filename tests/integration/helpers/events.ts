/**
 * Subscribe to the in-process event bus and resolve when a matching event
 * arrives. Rejects with the events seen so far if the deadline passes.
 */
import { events, type AgentEvents, type EventName } from "@/lib/scheduling/events.ts";

export function waitForEvent<K extends EventName>(
  name: K,
  predicate: (e: AgentEvents[K]) => boolean,
  timeoutMs = 5_000,
): Promise<AgentEvents[K]> {
  return new Promise((resolve, reject) => {
    const seen: AgentEvents[K][] = [];
    const off = events.on(name, (event) => {
      seen.push(event);
      if (predicate(event)) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
    const timer = setTimeout(() => {
      off();
      const summary = seen.length === 0
        ? "no events seen"
        : `seen: ${JSON.stringify(seen.slice(-5))}`;
      reject(new Error(`waitForEvent(${name}) timed out after ${timeoutMs}ms — ${summary}`));
    }, timeoutMs);
  });
}

/** Drain any pending file.* events for a project (useful for clean test setup). */
export function quietlyConsumeFor(projectId: string, name: EventName, ms = 100): void {
  const off = events.on(name, (e: any) => {
    if (e?.projectId !== projectId) return;
  });
  setTimeout(off, ms);
}

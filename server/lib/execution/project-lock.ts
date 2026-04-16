/**
 * Per-project async mutex. Serializes container-mutating tool calls (bash,
 * writeFile, editFile) so concurrent tool calls from a single agent step
 * don't race on the shared `/tmp/.snapshot-marker`, reconcileToContainer, or
 * the sandbox filesystem itself.
 *
 * Pure-read tools should NOT use this — that's where the parallelism pays off.
 */
const locks = new Map<string, Promise<unknown>>();

export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    projectId,
    next.finally(() => {
      if (locks.get(projectId) === next) locks.delete(projectId);
    }),
  );
  return next;
}

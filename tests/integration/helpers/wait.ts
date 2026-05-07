/** Poll `fn` until it returns truthy or the deadline passes. */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  opts?: { timeoutMs?: number; intervalMs?: number; description?: string },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `eventually(${opts?.description ?? "predicate"}) timed out after ${timeoutMs}ms` +
      (lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ""),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

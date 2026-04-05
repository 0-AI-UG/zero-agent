/**
 * Defer a promise-returning function with setTimeout(0) to avoid running
 * concurrently with AbortSignal-bearing fetches in Bun.serve() — concurrent
 * AbortSignal + fetch causes event loop stalls in Bun (see oven-sh/bun#6366).
 */
export function deferAsync<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => fn().then(resolve, reject), 0);
  });
}

/**
 * Fetch with a manual timeout using setTimeout + AbortController.
 * Avoids AbortSignal.timeout() which is buggy in Bun, and defers the call
 * to avoid event loop stalls (see oven-sh/bun#6366).
 */
export function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 2000, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return deferAsync(() =>
    fetch(url, { ...rest, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    ),
  );
}

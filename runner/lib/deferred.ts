/**
 * Fetch with a timeout using AbortSignal.timeout().
 */
export function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30_000, ...rest } = init ?? {};
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeout) });
}

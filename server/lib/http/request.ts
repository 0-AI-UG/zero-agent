/** Extract route params injected by the Hono adapter. */
export function getParams<T extends Record<string, string> = Record<string, string>>(
  request: Request,
): T {
  return ((request as any).params ?? {}) as T;
}

/**
 * Response shape shared with the SDK in `zero/src/sdk/types.ts`. Always
 * `{ ok: true, data }` or `{ ok: false, error: { code, message } }` so
 * the SDK client can throw a structured ZeroError on failure.
 */
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/utils/errors.ts";

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function fail(code: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export function failFromError(err: unknown): Response {
  if (err instanceof AuthError) return fail("unauthorized", err.message, 401);
  if (err instanceof ForbiddenError) return fail("forbidden", err.message, 403);
  if (err instanceof NotFoundError) return fail("not_found", err.message, 404);
  if (err instanceof ValidationError) return fail("invalid", err.message, 400);
  const msg = err instanceof Error ? err.message : String(err);
  return fail("internal", msg, 500);
}

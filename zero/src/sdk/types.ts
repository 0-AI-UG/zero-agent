/**
 * Wire types shared between the zero CLI/SDK and the server cli-handlers.
 * These are intentionally narrow — the request body for each action is
 * just the SDK function arguments JSON-serialized.
 */

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

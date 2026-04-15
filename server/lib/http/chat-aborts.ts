/**
 * Per-chat AbortControllers for in-flight model calls.
 *
 * Used by the WS chat entrypoint, the planning tool's nested stream, and
 * the background-resume path so an out-of-band `chat.stop` (or shutdown
 * drain) can cancel the underlying SDK stream at the token level.
 */

const abortControllers = new Map<
  string,
  { controller: AbortController; createdAt: number }
>();

const ABORT_CONTROLLER_TTL_MS = 15 * 60 * 1000;

const _sweep = setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of abortControllers) {
    if (now - entry.createdAt > ABORT_CONTROLLER_TTL_MS) {
      abortControllers.delete(chatId);
    }
  }
}, 5 * 60 * 1000);
if (typeof _sweep === "object" && "unref" in _sweep) _sweep.unref();

export function createAbortController(chatId: string): AbortController {
  const controller = new AbortController();
  abortControllers.set(chatId, { controller, createdAt: Date.now() });
  return controller;
}

export function requestAbort(chatId: string): boolean {
  const entry = abortControllers.get(chatId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function clearAbortController(chatId: string): void {
  abortControllers.delete(chatId);
}

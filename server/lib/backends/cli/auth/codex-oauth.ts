/**
 * Codex per-user authentication — scaffolded but not yet implemented. The
 * real flow lands alongside the Codex backend (plan.md §6). For now every
 * public call throws a clear "not implemented" error so the route layer
 * can expose the same shape without silently succeeding.
 */
import type { ExecutionBackend, AuthExecFrame } from "@/lib/execution/backend-interface.ts";
import type { CliAuthStatus } from "./types.ts";

export interface StartAuthOpts {
  userId: string;
  projectId: string;
  backend: ExecutionBackend;
}

function notImplemented(): never {
  throw new Error("Codex login is not yet available — ships alongside the Codex backend (plan.md §6).");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function startCodexAuth(_opts: StartAuthOpts): Promise<{ sessionId: string }> {
  notImplemented();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function subscribeCodexAuth(
  _sessionId: string,
  _onFrame: (f: AuthExecFrame) => void,
): { unsubscribe: () => void; replay: AuthExecFrame[]; closed: boolean } | null {
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function writeCodexAuthStdin(_sessionId: string, _data: string): Promise<boolean> {
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function cancelCodexAuth(_sessionId: string): Promise<boolean> {
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getCodexAuthStatus(_opts: StartAuthOpts): Promise<CliAuthStatus> {
  return { provider: "codex", authenticated: false };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function logoutCodex(_opts: StartAuthOpts): Promise<void> {
  // no-op until §6
}

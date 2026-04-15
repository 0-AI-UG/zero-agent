/**
 * Client for the per-user CLI subscription login endpoints. Streaming is
 * done via a plain `fetch` with an NDJSON reader since the auth flow is
 * short-lived (≤ 10 min) and only a handful of users would ever drive one
 * concurrently — reusing the WebSocket channel would have meant wiring
 * new scene types end to end for a non-chat surface.
 */
import { apiFetch } from "./client";
import { useAuthStore } from "@/stores/auth";

export type CliAuthProvider = "claude" | "codex";

export interface CliAuthStatus {
  provider: CliAuthProvider;
  authenticated: boolean;
  account?: string;
  expiresAt?: number;
  lastVerifiedAt?: number;
}

export type CliAuthFrame =
  | { type: "stdout"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export async function getCliAuthStatus(projectId: string): Promise<{ claude: CliAuthStatus; codex: CliAuthStatus }> {
  return apiFetch(`/cli-auth/status?projectId=${encodeURIComponent(projectId)}`);
}

export async function startCliAuth(
  provider: CliAuthProvider,
  projectId: string,
): Promise<{ sessionId: string; provider: CliAuthProvider }> {
  return apiFetch(`/cli-auth/${provider}/start`, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export async function sendCliAuthStdin(
  provider: CliAuthProvider,
  sessionId: string,
  data: string,
): Promise<void> {
  await apiFetch(`/cli-auth/${provider}/stdin/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify({ data }),
  });
}

export async function cancelCliAuth(provider: CliAuthProvider, sessionId: string): Promise<void> {
  await apiFetch(`/cli-auth/${provider}/cancel/${encodeURIComponent(sessionId)}`, {
    method: "POST",
  }).catch(() => {});
}

export async function logoutCliAuth(provider: CliAuthProvider, projectId: string): Promise<void> {
  await apiFetch(`/cli-auth/${provider}/logout`, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

/**
 * Opens the streaming NDJSON channel for an in-flight auth session. Yields
 * frames until the server closes the stream (on exit or error). Cancel by
 * aborting the passed signal.
 */
export async function* streamCliAuth(
  provider: CliAuthProvider,
  sessionId: string,
  signal: AbortSignal,
): AsyncIterable<CliAuthFrame> {
  const { token } = useAuthStore.getState();
  const res = await fetch(`/api/cli-auth/${provider}/stream/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Stream failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as CliAuthFrame;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

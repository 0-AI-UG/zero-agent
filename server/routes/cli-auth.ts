/**
 * HTTP routes for per-user CLI subscription login (Claude Code, Codex).
 *
 * These are mounted under `/api/cli-auth/:provider/...`. Each handler
 * requires an authenticated caller and scopes everything to the caller's
 * user id — session secrets never cross users. The caller picks which of
 * their projects' container to drive the flow through (via `projectId`
 * in the request body); all containers owned by that user share a single
 * per-user named volume at `/root/.claude`, so the login result is
 * visible to every container they own afterwards.
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { verifyProjectAccess } from "@/routes/utils.ts";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";
import {
  startClaudeAuth,
  subscribeClaudeAuth,
  writeClaudeAuthStdin,
  cancelClaudeAuth,
  getClaudeAuthStatus,
  logoutClaude,
} from "@/lib/backends/cli/auth/claude-oauth.ts";
import {
  startCodexAuth,
  getCodexAuthStatus,
  logoutCodex,
} from "@/lib/backends/cli/auth/codex-oauth.ts";
import type { CliAuthProvider } from "@/lib/backends/cli/auth/types.ts";

const PROVIDERS = ["claude", "codex"] as const;

function parseProvider(raw: string): CliAuthProvider {
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as CliAuthProvider;
  throw Object.assign(new Error("Unknown provider"), { name: "ValidationError" });
}

async function requireBackend(): Promise<ExecutionBackend> {
  const backend = await ensureBackend();
  if (!backend) throw new Error("Execution backend unavailable");
  return backend;
}

async function readStartBody(request: Request): Promise<{ projectId: string }> {
  const body = (await request.json()) as { projectId?: string };
  if (!body.projectId) {
    throw Object.assign(new Error("projectId is required"), { name: "ValidationError" });
  }
  return { projectId: body.projectId };
}

export async function handleStart(request: Request, provider: string): Promise<Response> {
  try {
    const prov = parseProvider(provider);
    const { userId } = await authenticateRequest(request);
    const { projectId } = await readStartBody(request);
    verifyProjectAccess(projectId, userId);
    const backend = await requireBackend();
    if (prov === "claude") {
      const { sessionId } = await startClaudeAuth({ userId, projectId, backend });
      return Response.json({ sessionId, provider: prov }, { headers: corsHeaders });
    }
    const { sessionId } = await startCodexAuth({ userId, projectId, backend });
    return Response.json({ sessionId, provider: prov }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Streams NDJSON frames until the session ends. We do not gate subscription
 * by sessionId ownership — sessionIds are opaque and only known to the
 * original caller — but we still require an authenticated user to prevent
 * drive-by scraping by unauthenticated clients.
 */
export async function handleStream(request: Request, provider: string, sessionId: string): Promise<Response> {
  try {
    const prov = parseProvider(provider);
    await authenticateRequest(request);
    if (prov !== "claude") {
      return Response.json({ error: "Codex login is not yet available" }, { status: 501, headers: corsHeaders });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const encoder = new TextEncoder();
        const emit = (obj: unknown) => {
          try { ctrl.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch {}
        };
        const sub = subscribeClaudeAuth(sessionId, (f) => {
          emit(f);
          if (f.type === "exit") {
            try { ctrl.close(); } catch {}
          }
        });
        if (!sub) {
          emit({ type: "error", message: "session not found" });
          try { ctrl.close(); } catch {}
          return;
        }
        for (const f of sub.replay) emit(f);
        if (sub.closed) {
          try { ctrl.close(); } catch {}
        }
        request.signal.addEventListener("abort", () => {
          sub.unsubscribe();
          try { ctrl.close(); } catch {}
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleStdin(request: Request, provider: string, sessionId: string): Promise<Response> {
  try {
    const prov = parseProvider(provider);
    await authenticateRequest(request);
    if (prov !== "claude") {
      return Response.json({ error: "Codex login is not yet available" }, { status: 501, headers: corsHeaders });
    }
    const body = (await request.json()) as { data?: string };
    if (typeof body.data !== "string") {
      return Response.json({ error: "data must be a string" }, { status: 400, headers: corsHeaders });
    }
    const ok = await writeClaudeAuthStdin(sessionId, body.data);
    if (!ok) return Response.json({ error: "session closed or missing" }, { status: 404, headers: corsHeaders });
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCancel(request: Request, provider: string, sessionId: string): Promise<Response> {
  try {
    parseProvider(provider);
    await authenticateRequest(request);
    await cancelClaudeAuth(sessionId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      return Response.json({ error: "projectId query param is required" }, { status: 400, headers: corsHeaders });
    }
    verifyProjectAccess(projectId, userId);
    const backend = await requireBackend();
    const [claude, codex] = await Promise.all([
      getClaudeAuthStatus({ userId, projectId, backend }),
      getCodexAuthStatus({ userId, projectId, backend }),
    ]);
    return Response.json({ claude, codex }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleLogout(request: Request, provider: string): Promise<Response> {
  try {
    const prov = parseProvider(provider);
    const { userId } = await authenticateRequest(request);
    const body = (await request.json()) as { projectId?: string };
    if (!body.projectId) {
      return Response.json({ error: "projectId is required" }, { status: 400, headers: corsHeaders });
    }
    verifyProjectAccess(body.projectId, userId);
    const backend = await requireBackend();
    if (prov === "claude") {
      await logoutClaude({ userId, projectId: body.projectId, backend });
    } else {
      await logoutCodex({ userId, projectId: body.projectId, backend });
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

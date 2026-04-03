import path from "path";
import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";
import { handleHealth } from "@/routes/health.ts";
import { handleLogin, handleMe, handleUpdateMe } from "@/routes/auth.ts";
import {
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpLogin,
  handleTotpDisable,
  handleTotpStatus,
  handleTotpSetupFromLogin,
  handleTotpConfirmFromLogin,
} from "@/routes/totp.ts";
import {
  handleListProjects,
  handleCreateProject,
  handleGetProject,
  handleUpdateProject,
  handleDeleteProject,
  handleGetSoul,
  handleUpdateSoul,
} from "@/routes/projects.ts";
import {
  handleListChats,
  handleCreateChat,
  handleUpdateChat,
  handleDeleteChat,
  handleSearchChats,
} from "@/routes/chats.ts";
import { handleChat, handleAbortChat, handleContextPreview } from "@/routes/chat.ts";
import { handleResumeStream } from "@/routes/stream.ts";
import { handleGetMessages } from "@/routes/messages.ts";
import {
  handleListFiles,
  handleGetFileUrl,
  handleUploadRequest,
  handleDeleteFile,
  handleMoveFile,
  handleCreateFolder,
  handleDeleteFolder,
  handleMoveFolder,
  handleSearchFiles,
  handleUpdateFileContent,
  handleGetUploadUrl,
  handleUpdateFileBinary,
} from "@/routes/files.ts";
import {
  handleReindex,
  handleReindexStatus,
  handleReindexStream,
} from "@/routes/reindex.ts";
import {
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
  handleRunTaskNow,
  handleGetTaskRuns,
} from "@/routes/scheduled-tasks.ts";
import {
  handleListMembers,
  handleInviteMember,
  handleRemoveMember,
  handleLeaveProject,
} from "@/routes/members.ts";
import {
  handleListInvitations,
  handleAcceptInvitation,
  handleDeclineInvitation,
} from "@/routes/invitations.ts";
import { handleListTodos } from "@/routes/todos.ts";
import {
  handleListQuickActions,
  handleCreateQuickAction,
  handleUpdateQuickAction,
  handleDeleteQuickAction,
} from "@/routes/quick-actions.ts";
import {
  handleListCompanionTokens,
  handleCreateCompanionToken,
  handleDeleteCompanionToken,
  handleCompanionStatus,
} from "@/routes/companion.ts";
import {
  handleListCredentials,
  handleCreateCredential,
  handleUpdateCredential,
  handleDeleteCredential,
} from "@/routes/credentials.ts";
import {
  handleTelegramWebhook,
  handleTelegramSetup,
  handleTelegramTeardown,
  handleTelegramStatus,
  handleUpdateTelegramAllowlist,
  handleListTelegramBindings,
} from "@/routes/telegram.ts";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { getCompanionTokenByToken, touchCompanionToken } from "@/db/queries/companion-tokens.ts";
import { presignHandler, s3 } from "@/lib/s3.ts";

// ── Rate limiter for WebSocket upgrade attempts ──
const WS_RATE_WINDOW = 60_000; // 1 minute
const WS_RATE_MAX = 10; // max attempts per IP per window
const wsRateMap = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of wsRateMap) {
    if (now > entry.resetAt) wsRateMap.delete(ip);
  }
}, 5 * 60_000);

function isWsRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = wsRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    wsRateMap.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > WS_RATE_MAX;
}
import {
  handleListSkills,
  handleInstallSkill,
  handleDiscoverSkills,
  handleInstallFromGithub,
  handleGetSkill,
  handleDeleteSkill,
} from "@/routes/skills.ts";

import { startScheduler, stopScheduler } from "@/lib/scheduler.ts";
import { requestShutdown, drainActiveRuns, isShuttingDown } from "@/lib/durability/shutdown.ts";
import { recoverInterruptedRuns } from "@/lib/durability/recovery.ts";
import { handleListUsers, handleCreateUser, handleDeleteUser, handleUpdateUser } from "@/routes/admin.ts";
import { handleSetupStatus, handleSetupComplete } from "@/routes/setup.ts";
import { handleGetSettings, handleUpdateSettings } from "@/routes/settings.ts";
import {
  handleListEnabledModels,
  handleListAllModels,
  handleCreateModel,
  handleUpdateModel,
  handleDeleteModel,
} from "@/routes/models.ts";
import { handleUsageSummary, handleUsageByModel, handleUsageByUser } from "@/routes/usage.ts";
import { startAllPollers } from "@/lib/telegram-polling.ts";
import { processIncomingUpdate } from "@/routes/telegram.ts";

import { initDesktopUser } from "@/lib/desktop-init.ts";
import { DESKTOP_MODE } from "@/lib/auth.ts";
import { webOnly } from "@/routes/utils.ts";
import { db } from "@/db/index.ts";
await initDesktopUser();

const httpLog = log.child({ module: "http" });
const PORT = parseInt(process.env.PORT ?? "3000");

// Embedded assets (populated at compile time, null in dev/normal prod)
let embeddedAssets: Record<string, { data: Buffer; mime: string; immutable: boolean }> | null = null;
// @ts-ignore — _generated/assets.ts only exists at compile time
try { embeddedAssets = (await import("./_generated/assets.ts")).assets; } catch {}

const IS_PROD = process.env.NODE_ENV === "production" || !!embeddedAssets;

// ── Frontend serving ──
const WEB_DIST = path.resolve(import.meta.dir, "../web/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveEmbedded(pathname: string): Response | null {
  if (!embeddedAssets) return null;
  const key = pathname === "/" ? "/index.html" : pathname;
  const asset = embeddedAssets[key];
  if (!asset) return null;
  const headers: Record<string, string> = { "Content-Type": asset.mime };
  if (asset.immutable) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  return new Response(asset.data, { headers });
}

async function serveStatic(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (/[-\.][a-z0-9]{8,}\.\w+$/.test(filePath)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return new Response(file, { headers });
}

// In dev, use Bun's HTML import for HMR
let devIndex: any = null;
if (!IS_PROD) {
  devIndex = (await import("../web/src/index.html")).default;
}

function withLogging(handler: (req: any, ...args: any[]) => Response | Promise<Response>, opts?: { noTimeout?: boolean }) {
  return async (req: Request, server: any, ...args: any[]) => {
    if (opts?.noTimeout) server.timeout(req, 0);
    const start = Date.now();
    const method = req.method;
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const res = await handler(req, ...args);
      httpLog.info("request", { method, path, status: res.status, durationMs: Date.now() - start });
      return res;
    } catch (err) {
      httpLog.error("request error", err, { method, path, durationMs: Date.now() - start });
      throw err;
    }
  };
}

const AUTH_TIMEOUT = 5_000; // 5 seconds to send auth message after connecting

const server = Bun.serve<{ userId: string; projectId: string; authenticated: boolean }>({
  port: PORT,
  hostname: "0.0.0.0",
  routes: {
    "/api/health": {
      GET: withLogging(handleHealth),
    },
    "/api/auth/login": {
      POST: withLogging(webOnly(handleLogin)),
    },
    "/api/me": {
      GET: withLogging(handleMe),
      PUT: withLogging(handleUpdateMe),
    },
    "/api/auth/totp/setup": {
      POST: withLogging(webOnly(handleTotpSetup)),
    },
    "/api/auth/totp/confirm": {
      POST: withLogging(webOnly(handleTotpConfirm)),
    },
    "/api/auth/totp/login": {
      POST: withLogging(webOnly(handleTotpLogin)),
    },
    "/api/auth/totp/disable": {
      POST: withLogging(webOnly(handleTotpDisable)),
    },
    "/api/auth/totp/status": {
      GET: withLogging(webOnly(handleTotpStatus)),
    },
    "/api/auth/totp/setup-from-login": {
      POST: withLogging(webOnly(handleTotpSetupFromLogin)),
    },
    "/api/auth/totp/confirm-from-login": {
      POST: withLogging(webOnly(handleTotpConfirmFromLogin)),
    },
    "/api/projects": {
      GET: withLogging(handleListProjects),
      POST: withLogging(handleCreateProject),
    },
    "/api/projects/:id": {
      GET: withLogging(handleGetProject),
      PUT: withLogging(handleUpdateProject),
      DELETE: withLogging(handleDeleteProject),
    },
    // Soul (identity)
    "/api/projects/:projectId/soul": {
      GET: withLogging(handleGetSoul),
      PUT: withLogging(handleUpdateSoul),
    },
    // Chat CRUD
    "/api/projects/:projectId/chats": {
      GET: withLogging(handleListChats),
      POST: withLogging(handleCreateChat),
    },
    "/api/projects/:projectId/chats/search": {
      GET: withLogging(handleSearchChats),
    },
    "/api/projects/:projectId/chats/:chatId": {
      PUT: withLogging(handleUpdateChat),
      DELETE: withLogging(handleDeleteChat),
    },
    "/api/projects/:projectId/chats/:chatId/chat": {
      POST: withLogging(handleChat, { noTimeout: true }),
    },
    "/api/projects/:projectId/chats/:chatId/abort": {
      POST: withLogging(handleAbortChat),
    },
    "/api/projects/:projectId/chats/:chatId/stream": {
      GET: withLogging(handleResumeStream, { noTimeout: true }),
    },
    "/api/projects/:projectId/chats/:chatId/messages": {
      GET: withLogging(handleGetMessages),
    },
    // Files
    "/api/projects/:projectId/files": {
      GET: withLogging(handleListFiles),
    },
    "/api/projects/:projectId/files/search": {
      GET: withLogging(handleSearchFiles),
    },
    "/api/projects/:projectId/context-preview": {
      GET: withLogging(handleContextPreview),
    },
    "/api/projects/:projectId/reindex": {
      POST: withLogging(handleReindex, { noTimeout: true }),
    },
    "/api/projects/:projectId/reindex/status": {
      GET: withLogging(handleReindexStatus),
    },
    "/api/projects/:projectId/reindex/stream": {
      GET: withLogging(handleReindexStream, { noTimeout: true }),
    },
    "/api/projects/:projectId/files/upload": {
      POST: withLogging(handleUploadRequest),
    },
    "/api/projects/:projectId/files/:id/url": {
      GET: withLogging(handleGetFileUrl),
    },
    "/api/projects/:projectId/files/:id/upload-url": {
      POST: withLogging(handleGetUploadUrl),
    },
    "/api/projects/:projectId/files/:id/binary": {
      POST: withLogging(handleUpdateFileBinary),
    },
    "/api/projects/:projectId/files/:id": {
      DELETE: withLogging(handleDeleteFile),
      PUT: withLogging(handleUpdateFileContent),
      PATCH: withLogging(handleMoveFile),
    },
    // Folders
    "/api/projects/:projectId/folders": {
      POST: withLogging(handleCreateFolder),
    },
    "/api/projects/:projectId/folders/:id": {
      DELETE: withLogging(handleDeleteFolder),
      PATCH: withLogging(handleMoveFolder),
    },
    // Scheduled Tasks
    "/api/projects/:projectId/tasks": {
      GET: withLogging(handleListTasks),
      POST: withLogging(handleCreateTask),
    },
    "/api/projects/:projectId/tasks/:taskId": {
      PUT: withLogging(handleUpdateTask),
      DELETE: withLogging(handleDeleteTask),
    },
    "/api/projects/:projectId/tasks/:taskId/run": {
      POST: withLogging(handleRunTaskNow),
    },
    "/api/projects/:projectId/tasks/:taskId/runs": {
      GET: withLogging(handleGetTaskRuns),
    },
    // Members
    "/api/projects/:projectId/members": {
      GET: withLogging(handleListMembers),
    },
    "/api/projects/:projectId/members/invite": {
      POST: withLogging(handleInviteMember),
    },
    "/api/projects/:projectId/members/:userId": {
      DELETE: withLogging(handleRemoveMember),
    },
    "/api/projects/:projectId/members/leave": {
      POST: withLogging(handleLeaveProject),
    },
    // Invitations
    "/api/invitations": {
      GET: withLogging(handleListInvitations),
    },
    "/api/invitations/:id/accept": {
      POST: withLogging(handleAcceptInvitation),
    },
    "/api/invitations/:id/decline": {
      POST: withLogging(handleDeclineInvitation),
    },
    // Todos
    "/api/projects/:projectId/todos": {
      GET: withLogging(handleListTodos),
    },
    // Quick Actions
    "/api/projects/:projectId/quick-actions": {
      GET: withLogging(handleListQuickActions),
      POST: withLogging(handleCreateQuickAction),
    },
    "/api/projects/:projectId/quick-actions/:actionId": {
      PUT: withLogging(handleUpdateQuickAction),
      DELETE: withLogging(handleDeleteQuickAction),
    },
    // Skills
    "/api/projects/:projectId/skills": {
      GET: withLogging(handleListSkills),
    },
    "/api/projects/:projectId/skills/install": {
      POST: withLogging(handleInstallSkill),
    },
    "/api/projects/:projectId/skills/discover": {
      POST: withLogging(handleDiscoverSkills),
    },
    "/api/projects/:projectId/skills/install-from-github": {
      POST: withLogging(handleInstallFromGithub),
    },
    "/api/projects/:projectId/skills/:name": {
      GET: withLogging(handleGetSkill),
      DELETE: withLogging(handleDeleteSkill),
    },
    // Companion tokens (project-scoped)
    "/api/projects/:projectId/companion/tokens": {
      GET: withLogging(handleListCompanionTokens),
      POST: withLogging(handleCreateCompanionToken),
    },
    "/api/projects/:projectId/companion/tokens/:id": {
      DELETE: withLogging(handleDeleteCompanionToken),
    },
    "/api/projects/:projectId/companion/status": {
      GET: withLogging(handleCompanionStatus),
    },
    // Telegram webhook (unauthenticated — secret token verified)
    "/api/telegram/webhook/:projectId": {
      POST: withLogging(handleTelegramWebhook),
    },
    // Telegram management (authenticated)
    "/api/projects/:projectId/telegram/setup": {
      POST: withLogging(handleTelegramSetup),
      DELETE: withLogging(handleTelegramTeardown),
    },
    "/api/projects/:projectId/telegram/status": {
      GET: withLogging(handleTelegramStatus),
    },
    "/api/projects/:projectId/telegram/allowlist": {
      PUT: withLogging(handleUpdateTelegramAllowlist),
    },
    "/api/projects/:projectId/telegram/bindings": {
      GET: withLogging(handleListTelegramBindings),
    },
    // Setup (no auth required)
    "/api/setup/status": {
      GET: withLogging(handleSetupStatus),
    },
    "/api/setup/complete": {
      POST: withLogging(handleSetupComplete),
    },
    // Admin
    "/api/admin/users": {
      GET: withLogging(handleListUsers),
      POST: withLogging(handleCreateUser),
    },
    "/api/admin/users/:userId": {
      PUT: withLogging(handleUpdateUser),
      DELETE: withLogging(handleDeleteUser),
    },
    // Models
    "/api/models": {
      GET: withLogging(handleListEnabledModels),
    },
    "/api/admin/models": {
      GET: withLogging(handleListAllModels),
      POST: withLogging(handleCreateModel),
      PUT: withLogging(handleUpdateModel),
      DELETE: withLogging(handleDeleteModel),
    },
    // Usage
    "/api/admin/usage/summary": {
      GET: withLogging(handleUsageSummary),
    },
    "/api/admin/usage/by-model": {
      GET: withLogging(handleUsageByModel),
    },
    "/api/admin/usage/by-user": {
      GET: withLogging(handleUsageByUser),
    },
    // Settings
    "/api/settings": {
      GET: withLogging(handleGetSettings),
    },
    "/api/settings/:key": {
      PUT: withLogging(handleUpdateSettings),
    },
    // Credentials (saved logins)
    "/api/projects/:projectId/credentials": {
      GET: withLogging(handleListCredentials),
      POST: withLogging(handleCreateCredential),
    },
    "/api/projects/:projectId/credentials/:id": {
      PUT: withLogging(handleUpdateCredential),
      DELETE: withLogging(handleDeleteCredential),
    },

    // S3 presigned file serving (must be before catch-all)
    "/api/s3/*": (req: Request) => presignHandler.handleRequest(req),

    // Frontend catch-all (dev mode only — prod uses fetch fallback)
    ...(!IS_PROD && devIndex ? { "/*": devIndex } : {}) as Record<string, never>,
  },
  async fetch(request, server) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade for companion agent
    const url = new URL(request.url);
    if (url.pathname === "/ws/companion") {
      // Rate limit by IP (skip in desktop mode — local connections only)
      if (!DESKTOP_MODE) {
        const ip = server.requestIP(request)?.address ?? "unknown";
        if (isWsRateLimited(ip)) {
          return Response.json({ error: "Too many connection attempts" }, { status: 429, headers: corsHeaders });
        }
      }

      // Upgrade without auth — token is sent as the first message
      const upgraded = server.upgrade(request, {
        data: { userId: "", projectId: "", authenticated: false },
      });
      if (!upgraded) {
        return Response.json({ error: "WebSocket upgrade failed" }, { status: 500, headers: corsHeaders });
      }
      return undefined as unknown as Response;
    }

    if (url.pathname.startsWith("/api/s3/")) {
      return presignHandler.handleRequest(request);
    }

    // API routes that weren't matched
    if (url.pathname.startsWith("/api/")) {
      httpLog.warn("not found", { method: request.method, path: url.pathname });
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    // Production: serve frontend (embedded in binary, or from web/dist/)
    if (IS_PROD) {
      const embedded = serveEmbedded(url.pathname);
      if (embedded) return embedded;

      const filePath = path.join(WEB_DIST, url.pathname === "/" ? "index.html" : url.pathname);
      const staticRes = await serveStatic(filePath);
      if (staticRes) return staticRes;

      // SPA fallback
      return serveEmbedded("/") ?? (await serveStatic(path.join(WEB_DIST, "index.html")))!;
    }

    // Dev: return undefined to let Bun's internal dev server handle /_bun/* etc.
    return undefined as unknown as Response;
  },
  websocket: {
    idleTimeout: 30, // seconds — Bun closes WS if no data received within this window
    open(ws) {
      // Start auth timeout — companion must send { type: "auth", token: "..." } within 5s
      setTimeout(() => {
        if (!ws.data.authenticated) {
          httpLog.warn("companion auth timeout, closing", {});
          ws.close(4001, "Authentication timeout");
        }
      }, AUTH_TIMEOUT);
    },
    message(ws, message) {
      // Handle auth as the first message for unauthenticated connections
      if (!ws.data.authenticated) {
        try {
          const data = JSON.parse(typeof message === "string" ? message : (message as Buffer).toString());
          if (data.type !== "auth" || !data.token) {
            ws.send(JSON.stringify({ type: "error", error: "First message must be auth" }));
            ws.close(4002, "Invalid auth message");
            return;
          }

          if (DESKTOP_MODE) {
            const firstProject = db.query<{ id: string }, []>("SELECT id FROM projects LIMIT 1").get();
            ws.data.userId = "desktop-user";
            ws.data.projectId = data.projectId ?? firstProject?.id ?? "";
            ws.data.authenticated = true;
            ws.send(JSON.stringify({ type: "auth_ok" }));
            browserBridge.handleOpen(ws as any);
            return;
          }

          const tokenRow = getCompanionTokenByToken(data.token);
          if (!tokenRow) {
            ws.send(JSON.stringify({ type: "error", error: "Invalid or expired token" }));
            ws.close(4003, "Invalid token");
            return;
          }
          // Authenticated — set connection data and proceed
          ws.data.userId = tokenRow.user_id;
          ws.data.projectId = tokenRow.project_id;
          ws.data.authenticated = true;
          touchCompanionToken(data.token);
          ws.send(JSON.stringify({ type: "auth_ok" }));
          browserBridge.handleOpen(ws as any);
        } catch {
          ws.close(4002, "Invalid auth message");
        }
        return;
      }
      browserBridge.handleMessage(ws as any, message as string);
    },
    close(ws) {
      if (ws.data.authenticated) {
        browserBridge.handleClose(ws as any);
      }
    },
  },
  development: !IS_PROD && {
    hmr: true,
    console: true,
  },
});

export { server };
log.info("server started", { port: server.port, url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "debug" });

// Recover any interrupted runs from a previous crash before starting scheduler
recoverInterruptedRuns();

startScheduler();

import { startEventTriggers } from "@/lib/event-trigger.ts";
startEventTriggers();

// Start Telegram polling for all configured bots (only when webhooks are not configured)
if (!process.env.TELEGRAM_WEBHOOK_BASE_URL) {
  startAllPollers(processIncomingUpdate);
}

// ── Graceful Shutdown ──

async function handleShutdown(signal: string) {
  if (isShuttingDown()) return; // prevent double-shutdown
  log.info("shutdown signal received", { signal });
  requestShutdown();
  stopScheduler();
  await drainActiveRuns(30_000);
  s3.close();
  db.close();
  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

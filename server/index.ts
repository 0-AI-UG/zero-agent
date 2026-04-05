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
import { handleChat, handleAbortChat } from "@/routes/chat.ts";
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
import {
  handleListServices,
  handleDeleteService,
  handlePinService,
  handleUnpinService,
  handleAppStatus,
} from "@/routes/apps.ts";
import { presignHandler, s3 } from "@/lib/s3.ts";
import {
  enableExecution,
  disableExecution,
  teardownExecution,
  getLocalBackend,
} from "@/lib/execution/lifecycle.ts";
import { proxyAppRequest } from "@/lib/app-proxy.ts";
import { getSetting } from "@/lib/settings.ts";

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
import { startAllPollers, stopAllPollers } from "@/lib/telegram-polling.ts";
import { processIncomingUpdate } from "@/routes/telegram.ts";

import { initDesktopUser } from "@/lib/desktop-init.ts";
import { DESKTOP_MODE, requireAdmin, authenticateRequest } from "@/lib/auth.ts";
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
      const durationMs = Date.now() - start;
      if (res.status >= 500) {
        httpLog.error("request failed", undefined, { method, path, status: res.status, durationMs });
      } else if (res.status >= 400) {
        httpLog.warn("request error", { method, path, status: res.status, durationMs });
      } else {
        httpLog.info("request", { method, path, status: res.status, durationMs });
      }
      return res;
    } catch (err) {
      httpLog.error("unhandled request exception", err, { method, path, durationMs: Date.now() - start });
      throw err;
    }
  };
}

const server = Bun.serve({
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

    // Services (forwarded ports)
    "/api/projects/:projectId/services": {
      GET: withLogging(handleListServices),
    },
    "/api/projects/:projectId/services/:serviceId": {
      DELETE: withLogging(handleDeleteService),
    },
    "/api/projects/:projectId/services/:serviceId/pin": {
      POST: withLogging(handlePinService),
    },
    "/api/projects/:projectId/services/:serviceId/unpin": {
      POST: withLogging(handleUnpinService),
    },
    "/api/apps/:slug/status": {
      GET: withLogging(handleAppStatus),
    },

    // Containers (admin — list, pause, resume, destroy)
    "/api/admin/containers": {
      GET: withLogging(async (req: Request) => {
        await requireAdmin(req);
        const containers = getLocalBackend()?.listContainers() ?? [];
        return Response.json({ containers }, { headers: corsHeaders });
      }),
    },
    "/api/admin/containers/:sessionId": {
      DELETE: withLogging(async (req: Request) => {
        await requireAdmin(req);
        const url = new URL(req.url);
        const sessionId = url.pathname.split("/")[4]!;
        await getLocalBackend()?.destroyContainer(sessionId);
        return Response.json({ ok: true }, { headers: corsHeaders });
      }),
    },
    // Container status for a project (authenticated)
    "/api/projects/:projectId/chats/:chatId/container": {
      GET: withLogging((req: Request) => {
        const url = new URL(req.url);
        const projectId = url.pathname.split("/")[3]!;
        const session = getLocalBackend()?.getSessionForProject(projectId);
        return Response.json({ status: session ? "running" : "none" }, { headers: corsHeaders });
      }),
    },
    // Latest browser screenshot for a project's session
    "/api/projects/:projectId/chats/:chatId/browser-screenshot": {
      GET: withLogging((req: Request) => {
        const url = new URL(req.url);
        const projectId = url.pathname.split("/")[3]!;
        const screenshot = getLocalBackend()?.getLatestScreenshot(projectId);
        if (!screenshot) {
          return Response.json({ screenshot: null }, { headers: corsHeaders });
        }
        return Response.json({ screenshot }, { headers: corsHeaders });
      }),
    },

    // Execution lifecycle (admin — enable/disable Docker execution & app deployments)
    "/api/admin/execution/enable": {
      POST: withLogging(async (req: Request) => {
        await requireAdmin(req);
        const result = await enableExecution();
        return Response.json(result, {
          status: result.success ? 200 : 500,
          headers: corsHeaders,
        });
      }),
    },
    "/api/admin/execution/disable": {
      POST: withLogging(async (req: Request) => {
        await requireAdmin(req);
        await disableExecution();
        return Response.json({ success: true }, { headers: corsHeaders });
      }),
    },
    // Capabilities (server-side execution status)
    "/api/capabilities": {
      GET: withLogging((req: Request) => {
        const backend = getLocalBackend();
        const hasDocker = !!backend?.isReady();
        return Response.json({
          serverDocker: hasDocker,
          serverBrowser: hasDocker,
          appDeployments: hasDocker,
        }, { headers: corsHeaders });
      }),
    },

    // Short-lived token for /_apps/* browser navigation
    "/api/app-token": {
      POST: withLogging(async (req: Request) => {
        const { userId, email } = await authenticateRequest(req);
        const { createAppToken } = await import("@/lib/auth.ts");
        const appToken = await createAppToken(userId, email);
        return Response.json({ token: appToken }, { headers: corsHeaders });
      }),
    },

    // S3 presigned file serving (must be before catch-all)
    "/api/s3/*": (req: Request) => presignHandler.handleRequest(req),

    // Reverse proxy for forwarded ports (must be before frontend catch-all)
    "/_apps/*": (req: Request) => {
      const slug = new URL(req.url).pathname.split("/")[2];
      if (slug) return proxyAppRequest(slug, req);
      return new Response("Not found", { status: 404 });
    },

    // Frontend catch-all (dev mode only — prod uses fetch fallback)
    ...(!IS_PROD && devIndex ? { "/*": devIndex } : {}) as Record<string, never>,
  },
  async fetch(request, server) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/s3/")) {
      return presignHandler.handleRequest(request);
    }

    // Reverse proxy for deployed apps
    if (url.pathname.startsWith("/_apps/")) {
      const slug = url.pathname.split("/")[2];
      if (slug) {
        return proxyAppRequest(slug, request);
      }
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
  error(error) {
    httpLog.error("bun server error", error);
    return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  },
  development: !IS_PROD && {
    hmr: true,
    console: true,
  },
});

export { server };
log.info("server started", { port: server.port, url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "debug" });

// ── Global error handlers ──
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", err);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

// Recover any interrupted runs from a previous crash before starting scheduler
recoverInterruptedRuns();

startScheduler();

import { startEventTriggers, stopAllEventTriggers } from "@/lib/event-trigger.ts";
startEventTriggers();

// Start Telegram polling for all configured bots (only when webhooks are not configured)
if (!process.env.TELEGRAM_WEBHOOK_BASE_URL) {
  startAllPollers(processIncomingUpdate);
}

// ── Local Docker Backend ──
// Only initialize Docker if admin has explicitly enabled server execution
(async () => {
  if (getSetting("SERVER_EXECUTION_ENABLED") !== "true") {
    log.info("server execution not enabled — skipping Docker initialization");
    return;
  }

  const result = await enableExecution();
  if (!result.success) {
    log.info("Docker execution not available", { error: result.error });
  }
})();

// ── Graceful Shutdown ──

async function handleShutdown(signal: string) {
  if (isShuttingDown()) return; // prevent double-shutdown
  log.info("shutdown signal received", { signal });
  requestShutdown();
  stopScheduler();
  stopAllEventTriggers();
  stopAllPollers();
  await drainActiveRuns(IS_PROD ? 30_000 : 2_000);
  await teardownExecution();
  s3.close();
  db.close();
  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

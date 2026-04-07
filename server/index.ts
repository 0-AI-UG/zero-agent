import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
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
  reconnectExecution,
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
import {
  handleListRunners,
  handleCreateRunner,
  handleUpdateRunner,
  handleDeleteRunner,
  handleTestRunner,
} from "@/routes/runners.ts";
import { startAllPollers, stopAllPollers } from "@/lib/telegram-polling.ts";
import { processIncomingUpdate } from "@/routes/telegram.ts";

import { requireAdmin, authenticateRequest } from "@/lib/auth.ts";
import { db } from "@/db/index.ts";

const httpLog = log.child({ module: "http" });
const PORT = parseInt(process.env.PORT ?? "3000");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Embedded assets (populated at compile time, null in dev/normal prod)
let embeddedAssets: Record<string, { data: Buffer; mime: string; immutable: boolean }> | null = null;
// @ts-ignore — _generated/assets.ts only exists at compile time
try { embeddedAssets = (await import("./_generated/assets.ts")).assets; } catch {}

const IS_PROD = process.env.NODE_ENV === "production" || !!embeddedAssets;

// ── Frontend serving ──
const WEB_DIST = path.resolve(__dirname, "../web/dist");

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
  return new Response(asset.data as unknown as BodyInit, { headers });
}

async function serveStatic(filePath: string): Promise<Response | null> {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (/[-\.][a-z0-9]{8,}\.\w+$/.test(filePath)) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    return new Response(data as unknown as BodyInit, { headers });
  } catch {
    return null;
  }
}

// ── Hono adapter ──
// Injects route params from Hono context onto the raw Request object
// so existing handlers can access request.params unchanged.
function h(handler: (req: any) => Response | Promise<Response>) {
  return async (c: Context) => {
    const req = c.req.raw;
    (req as any).params = c.req.param();
    const start = Date.now();
    const method = req.method;
    const urlPath = c.req.path;
    try {
      const res = await handler(req);
      const durationMs = Date.now() - start;
      if (res.status >= 500) {
        httpLog.error("request failed", undefined, { method, path: urlPath, status: res.status, durationMs });
      } else if (res.status >= 400) {
        httpLog.warn("request error", { method, path: urlPath, status: res.status, durationMs });
      } else {
        httpLog.info("request", { method, path: urlPath, status: res.status, durationMs });
      }
      return res;
    } catch (err) {
      httpLog.error("unhandled request exception", err, { method, path: urlPath, durationMs: Date.now() - start });
      throw err;
    }
  };
}

const app = new Hono();

// CORS preflight
app.options("*", (c) => new Response(null, { status: 204, headers: corsHeaders }));

// ── API Routes ──

// Health
app.get("/api/health", h(handleHealth));

// Auth
app.post("/api/auth/login", h(handleLogin));
app.get("/api/me", h(handleMe));
app.put("/api/me", h(handleUpdateMe));

// TOTP
app.post("/api/auth/totp/setup", h(handleTotpSetup));
app.post("/api/auth/totp/confirm", h(handleTotpConfirm));
app.post("/api/auth/totp/login", h(handleTotpLogin));
app.post("/api/auth/totp/disable", h(handleTotpDisable));
app.get("/api/auth/totp/status", h(handleTotpStatus));
app.post("/api/auth/totp/setup-from-login", h(handleTotpSetupFromLogin));
app.post("/api/auth/totp/confirm-from-login", h(handleTotpConfirmFromLogin));

// Projects
app.get("/api/projects", h(handleListProjects));
app.post("/api/projects", h(handleCreateProject));
app.get("/api/projects/:id", h(handleGetProject));
app.put("/api/projects/:id", h(handleUpdateProject));
app.delete("/api/projects/:id", h(handleDeleteProject));

// Soul (identity)
app.get("/api/projects/:projectId/soul", h(handleGetSoul));
app.put("/api/projects/:projectId/soul", h(handleUpdateSoul));

// Chat CRUD
app.get("/api/projects/:projectId/chats", h(handleListChats));
app.post("/api/projects/:projectId/chats", h(handleCreateChat));
app.get("/api/projects/:projectId/chats/search", h(handleSearchChats));
app.put("/api/projects/:projectId/chats/:chatId", h(handleUpdateChat));
app.delete("/api/projects/:projectId/chats/:chatId", h(handleDeleteChat));

// Chat streaming
app.post("/api/projects/:projectId/chats/:chatId/chat", h(handleChat));
app.post("/api/projects/:projectId/chats/:chatId/abort", h(handleAbortChat));
app.get("/api/projects/:projectId/chats/:chatId/stream", h(handleResumeStream));
app.get("/api/projects/:projectId/chats/:chatId/messages", h(handleGetMessages));

// Files
app.get("/api/projects/:projectId/files", h(handleListFiles));
app.get("/api/projects/:projectId/files/search", h(handleSearchFiles));
app.post("/api/projects/:projectId/reindex", h(handleReindex));
app.get("/api/projects/:projectId/reindex/status", h(handleReindexStatus));
app.get("/api/projects/:projectId/reindex/stream", h(handleReindexStream));
app.post("/api/projects/:projectId/files/upload", h(handleUploadRequest));
app.get("/api/projects/:projectId/files/:id/url", h(handleGetFileUrl));
app.post("/api/projects/:projectId/files/:id/upload-url", h(handleGetUploadUrl));
app.post("/api/projects/:projectId/files/:id/binary", h(handleUpdateFileBinary));
app.delete("/api/projects/:projectId/files/:id", h(handleDeleteFile));
app.put("/api/projects/:projectId/files/:id", h(handleUpdateFileContent));
app.patch("/api/projects/:projectId/files/:id", h(handleMoveFile));

// Folders
app.post("/api/projects/:projectId/folders", h(handleCreateFolder));
app.delete("/api/projects/:projectId/folders/:id", h(handleDeleteFolder));
app.patch("/api/projects/:projectId/folders/:id", h(handleMoveFolder));

// Scheduled Tasks
app.get("/api/projects/:projectId/tasks", h(handleListTasks));
app.post("/api/projects/:projectId/tasks", h(handleCreateTask));
app.put("/api/projects/:projectId/tasks/:taskId", h(handleUpdateTask));
app.delete("/api/projects/:projectId/tasks/:taskId", h(handleDeleteTask));
app.post("/api/projects/:projectId/tasks/:taskId/run", h(handleRunTaskNow));
app.get("/api/projects/:projectId/tasks/:taskId/runs", h(handleGetTaskRuns));

// Members
app.get("/api/projects/:projectId/members", h(handleListMembers));
app.post("/api/projects/:projectId/members/invite", h(handleInviteMember));
app.delete("/api/projects/:projectId/members/:userId", h(handleRemoveMember));
app.post("/api/projects/:projectId/members/leave", h(handleLeaveProject));

// Invitations
app.get("/api/invitations", h(handleListInvitations));
app.post("/api/invitations/:id/accept", h(handleAcceptInvitation));
app.post("/api/invitations/:id/decline", h(handleDeclineInvitation));

// Todos
app.get("/api/projects/:projectId/todos", h(handleListTodos));

// Quick Actions
app.get("/api/projects/:projectId/quick-actions", h(handleListQuickActions));
app.post("/api/projects/:projectId/quick-actions", h(handleCreateQuickAction));
app.put("/api/projects/:projectId/quick-actions/:actionId", h(handleUpdateQuickAction));
app.delete("/api/projects/:projectId/quick-actions/:actionId", h(handleDeleteQuickAction));

// Skills
app.get("/api/projects/:projectId/skills", h(handleListSkills));
app.post("/api/projects/:projectId/skills/install", h(handleInstallSkill));
app.post("/api/projects/:projectId/skills/discover", h(handleDiscoverSkills));
app.post("/api/projects/:projectId/skills/install-from-github", h(handleInstallFromGithub));
app.get("/api/projects/:projectId/skills/:name", h(handleGetSkill));
app.delete("/api/projects/:projectId/skills/:name", h(handleDeleteSkill));

// Telegram webhook (unauthenticated — secret token verified)
app.post("/api/telegram/webhook/:projectId", h(handleTelegramWebhook));

// Telegram management (authenticated)
app.post("/api/projects/:projectId/telegram/setup", h(handleTelegramSetup));
app.delete("/api/projects/:projectId/telegram/setup", h(handleTelegramTeardown));
app.get("/api/projects/:projectId/telegram/status", h(handleTelegramStatus));
app.put("/api/projects/:projectId/telegram/allowlist", h(handleUpdateTelegramAllowlist));
app.get("/api/projects/:projectId/telegram/bindings", h(handleListTelegramBindings));

// Setup (no auth required)
app.get("/api/setup/status", h(handleSetupStatus));
app.post("/api/setup/complete", h(handleSetupComplete));

// Admin
app.get("/api/admin/users", h(handleListUsers));
app.post("/api/admin/users", h(handleCreateUser));
app.put("/api/admin/users/:userId", h(handleUpdateUser));
app.delete("/api/admin/users/:userId", h(handleDeleteUser));

// Runners (admin)
app.get("/api/admin/runners", h(handleListRunners));
app.post("/api/admin/runners", h(handleCreateRunner));
app.put("/api/admin/runners/:runnerId", h(handleUpdateRunner));
app.delete("/api/admin/runners/:runnerId", h(handleDeleteRunner));
app.post("/api/admin/runners/:runnerId/test", h(handleTestRunner));

// Models
app.get("/api/models", h(handleListEnabledModels));
app.get("/api/admin/models", h(handleListAllModels));
app.post("/api/admin/models", h(handleCreateModel));
app.put("/api/admin/models", h(handleUpdateModel));
app.delete("/api/admin/models", h(handleDeleteModel));

// Usage
app.get("/api/admin/usage/summary", h(handleUsageSummary));
app.get("/api/admin/usage/by-model", h(handleUsageByModel));
app.get("/api/admin/usage/by-user", h(handleUsageByUser));

// Settings
app.get("/api/settings", h(handleGetSettings));
app.put("/api/settings/:key", h(handleUpdateSettings));

// Credentials (saved logins)
app.get("/api/projects/:projectId/credentials", h(handleListCredentials));
app.post("/api/projects/:projectId/credentials", h(handleCreateCredential));
app.put("/api/projects/:projectId/credentials/:id", h(handleUpdateCredential));
app.delete("/api/projects/:projectId/credentials/:id", h(handleDeleteCredential));

// Services (forwarded ports)
app.get("/api/projects/:projectId/services", h(handleListServices));
app.delete("/api/projects/:projectId/services/:serviceId", h(handleDeleteService));
app.post("/api/projects/:projectId/services/:serviceId/pin", h(handlePinService));
app.post("/api/projects/:projectId/services/:serviceId/unpin", h(handleUnpinService));
app.get("/api/apps/:slug/status", h(handleAppStatus));

// Containers (admin)
app.get("/api/admin/containers", h(async (req: Request) => {
  await requireAdmin(req);
  const backend = getLocalBackend();
  const containers = backend ? await backend.listContainersAsync() : [];
  return Response.json({ containers }, { headers: corsHeaders });
}));
app.delete("/api/admin/containers/:sessionId", h(async (req: Request) => {
  await requireAdmin(req);
  const sessionId = (req as any).params.sessionId;
  await getLocalBackend()?.destroyContainer(sessionId);
  return Response.json({ ok: true }, { headers: corsHeaders });
}));

// Container status for a project (authenticated)
app.get("/api/projects/:projectId/chats/:chatId/container", h(async (req: Request) => {
  const projectId = (req as any).params.projectId;
  const backend = getLocalBackend();
  const session = backend?.getSessionForProject(projectId);
  if (session) {
    return Response.json({ status: "running" }, { headers: corsHeaders });
  }
  const running = await backend?.hasContainer(projectId) ?? false;
  return Response.json({ status: running ? "running" : "none" }, { headers: corsHeaders });
}));

// Latest browser screenshot for a project's session
app.get("/api/projects/:projectId/chats/:chatId/browser-screenshot", h(async (req: Request) => {
  const projectId = (req as any).params.projectId;
  const screenshot = await getLocalBackend()?.getLatestScreenshot(projectId) ?? null;
  if (!screenshot) {
    return Response.json({ screenshot: null }, { headers: corsHeaders });
  }
  return Response.json({ screenshot }, { headers: corsHeaders });
}));

// Execution lifecycle (admin)
app.post("/api/admin/execution/enable", h(async (req: Request) => {
  await requireAdmin(req);
  const result = await enableExecution();
  return Response.json(result, { status: result.success ? 200 : 500, headers: corsHeaders });
}));
app.post("/api/admin/execution/disable", h(async (req: Request) => {
  await requireAdmin(req);
  await disableExecution();
  return Response.json({ success: true }, { headers: corsHeaders });
}));
app.post("/api/admin/execution/reconnect", h(async (req: Request) => {
  await requireAdmin(req);
  const result = await reconnectExecution();
  return Response.json(result, { status: result.success ? 200 : 500, headers: corsHeaders });
}));
app.get("/api/admin/runner/status", h(async (req: Request) => {
  await requireAdmin(req);
  const backend = getLocalBackend();
  if (!backend) {
    return Response.json({ connected: false, containers: 0, runners: [] }, { headers: corsHeaders });
  }
  try {
    const containers = await backend.listContainersAsync();
    return Response.json({ connected: true, containers: containers.length }, { headers: corsHeaders });
  } catch {
    return Response.json({ connected: false, containers: 0 }, { headers: corsHeaders });
  }
}));

// Capabilities
app.get("/api/capabilities", h((req: Request) => {
  const backend = getLocalBackend();
  const hasDocker = !!backend?.isReady();
  return Response.json({
    serverDocker: hasDocker,
    serverBrowser: hasDocker,
    appDeployments: hasDocker,
  }, { headers: corsHeaders });
}));

// Short-lived token for /_apps/* browser navigation
app.post("/api/app-token", h(async (req: Request) => {
  const { userId, email } = await authenticateRequest(req);
  const { createAppToken } = await import("@/lib/auth.ts");
  const appToken = await createAppToken(userId, email);
  return Response.json({ token: appToken }, { headers: corsHeaders });
}));

// S3 presigned file serving
app.all("/api/s3/*", (c) => presignHandler.handleRequest(c.req.raw));

// Reverse proxy for forwarded ports
app.all("/_apps/:slug/*", (c) => {
  const slug = c.req.param("slug");
  if (slug) return proxyAppRequest(slug, c.req.raw);
  return new Response("Not found", { status: 404 });
});

// API 404 catch-all
app.all("/api/*", (c) => {
  httpLog.warn("not found", { method: c.req.method, path: c.req.path });
  return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
});

// Frontend serving (production only — dev uses Vite middleware below)
if (IS_PROD) {
  app.get("*", async (c) => {
    const pathname = c.req.path;

    const embedded = serveEmbedded(pathname);
    if (embedded) return embedded;

    const filePath = path.join(WEB_DIST, pathname === "/" ? "index.html" : pathname);
    const staticRes = await serveStatic(filePath);
    if (staticRes) return staticRes;

    // SPA fallback
    return serveEmbedded("/") ?? (await serveStatic(path.join(WEB_DIST, "index.html")))!;
  });
}

// Error handler
app.onError((err, c) => {
  httpLog.error("server error", err);
  return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
});

// ── Start server ──

import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { getRequestListener } from "@hono/node-server";

const honoListener = getRequestListener(app.fetch);
const nodeServer = createHttpServer(honoListener);

// In dev mode, attach Vite dev server in middleware mode (official Vite approach)
if (!IS_PROD) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: path.resolve(__dirname, "../web/vite.config.ts"),
    server: { middlewareMode: true, hmr: { server: nodeServer } },
    appType: "custom",
  });

  const indexHtmlPath = path.resolve(__dirname, "../web/src/index.html");

  // Vite handles all requests first (source modules, HMR, static assets).
  // If Vite doesn't match, fall through: API/app routes go to Hono, the rest get SPA fallback.
  nodeServer.removeAllListeners("request");
  nodeServer.on("request", (req, res) => {
    const url = req.url ?? "";
    const pathname = url.split("?")[0]!;
    // Route real API / app-proxy calls to Hono, but let Vite handle
    // source-module requests (e.g. /api/client.ts) that have a file extension.
    const isSourceModule = /\.\w+$/.test(pathname);
    if (!isSourceModule && (pathname.startsWith("/api/") || pathname.startsWith("/_apps/"))) {
      return honoListener(req, res);
    }
    vite.middlewares(req, res, async () => {
      try {
        const template = readFileSync(indexHtmlPath, "utf-8");
        const html = await vite.transformIndexHtml(url, template);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        res.writeHead(500);
        res.end(e.message);
      }
    });
  });
  log.info("vite dev server attached");
}

const server = nodeServer.listen(PORT, "0.0.0.0");

export { server };
log.info("server started", { port: PORT, url: `http://0.0.0.0:${PORT}`, logLevel: process.env.LOG_LEVEL ?? "debug" });

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
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

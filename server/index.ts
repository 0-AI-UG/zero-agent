import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";
import { handleHealth } from "@/routes/health.ts";
import { handleLogin, handleMe, handleUpdateMe, handlePasswordResetInit, handlePasswordResetConfirm, handlePasswordResetPasskeyOptions, handlePasswordResetPasskeyConfirm } from "@/routes/auth.ts";
import {
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpLogin,
  handleTotpDisable,
  handleTotpStatus,
  handleTotpSetupFromLogin,
  handleTotpConfirmFromLogin,
  handleTotpRecover,
} from "@/routes/totp.ts";
import {
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyList,
  handlePasskeyDelete,
} from "@/routes/passkeys.ts";
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
import { handleTelegramGlobalWebhook } from "@/routes/telegram-webhook.ts";
import {
  handleTelegramLinkCode,
  handleTelegramUnlink,
  handleTelegramLinkStatus,
  handleTelegramSetActiveProject,
} from "@/routes/me-telegram.ts";
import { registerTelegramProvider } from "@/lib/chat-providers/telegram/provider.ts";
import { handleGlobalUpdate } from "@/lib/chat-providers/telegram/router.ts";
import {
  startGlobalPoller,
  stopGlobalPoller,
  registerGlobalPollerHandler,
} from "@/lib/telegram-global/poller.ts";
import { ensureWebhookRegistered } from "@/lib/telegram-global/bot.ts";
import { startupExpirySweep } from "@/lib/pending-responses/store.ts";
import {
  cancelAllPendingSyncs,
  recoverSyncOrphansOnStartup,
} from "@/lib/sync-approval.ts";
import {
  handleGetVapidKey,
  handlePushSubscribe,
  handlePushUnsubscribe,
} from "@/routes/push.ts";
import {
  handleListNotificationSubscriptions,
  handleUpdateNotificationSubscription,
} from "@/routes/notification-subscriptions.ts";
import {
  handleGetPendingResponse,
  handleRespondPendingResponse,
} from "@/routes/pending-responses.ts";
import {
  handleListServices,
  handleDeleteService,
  handlePinService,
  handleUnpinService,
  handleAppStatus,
  handleCreateShareLink,
} from "@/routes/apps.ts";
import { presignHandler, s3 } from "@/lib/s3.ts";
import {
  enableExecution,
  disableExecution,
  teardownExecution,
  reconcile,
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
import {
  handleCreateInvitation,
  handleListAdminInvitations,
  handleDeleteInvitation,
  handleLookupInvitation,
  handleAcceptUserInvitation,
} from "@/routes/user-invitations.ts";
import { handleSetupStatus, handleSetupComplete } from "@/routes/setup.ts";
import { handleGetSettings, handleUpdateSettings } from "@/routes/settings.ts";
import {
  handleCodexImport,
  handleCodexStatus,
  handleCodexDisconnect,
} from "@/routes/oauth.ts";
import {
  handleListEnabledModels,
  handleListAllModels,
  handleCreateModel,
  handleUpdateModel,
  handleDeleteModel,
} from "@/routes/models.ts";
import { handleUsageSummary, handleUsageByModel, handleUsageByUser } from "@/routes/usage.ts";
import { handleSyncVerdict, handleSyncDiff, handleSyncStatus } from "@/routes/sync.ts";
import {
  handleListRunners,
  handleCreateRunner,
  handleUpdateRunner,
  handleDeleteRunner,
  handleTestRunner,
} from "@/routes/runners.ts";
import { requireAdmin, authenticateRequest } from "@/lib/auth.ts";
import { mountCliHandlers } from "@/cli-handlers/index.ts";
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
  ".webmanifest": "application/manifest+json",
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
app.post("/api/auth/password-reset/init", h(handlePasswordResetInit));
app.post("/api/auth/password-reset/confirm", h(handlePasswordResetConfirm));
app.post("/api/auth/password-reset/passkey-options", h(handlePasswordResetPasskeyOptions));
app.post("/api/auth/password-reset/passkey-confirm", h(handlePasswordResetPasskeyConfirm));
app.get("/api/me", h(handleMe));
app.put("/api/me", h(handleUpdateMe));

// TOTP
app.post("/api/auth/totp/setup", h(handleTotpSetup));
app.post("/api/auth/totp/confirm", h(handleTotpConfirm));
app.post("/api/auth/totp/login", h(handleTotpLogin));
app.post("/api/auth/totp/recover", h(handleTotpRecover));
app.post("/api/auth/totp/disable", h(handleTotpDisable));
app.get("/api/auth/totp/status", h(handleTotpStatus));
app.post("/api/auth/totp/setup-from-login", h(handleTotpSetupFromLogin));
app.post("/api/auth/totp/confirm-from-login", h(handleTotpConfirmFromLogin));

// Passkeys
app.post("/api/auth/passkey/register-options", h(handlePasskeyRegisterOptions));
app.post("/api/auth/passkey/register-verify", h(handlePasskeyRegisterVerify));
app.post("/api/auth/passkey/login-options", h(handlePasskeyLoginOptions));
app.post("/api/auth/passkey/login-verify", h(handlePasskeyLoginVerify));
app.get("/api/auth/passkey/list", h(handlePasskeyList));
app.delete("/api/auth/passkey/:id", h(handlePasskeyDelete));

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

// Telegram global webhook (unauthenticated — secret token verified)
app.post("/api/telegram/webhook", h(handleTelegramGlobalWebhook));

// Per-user Telegram linking (authenticated)
app.post("/api/me/telegram/link-code", h(handleTelegramLinkCode));
app.delete("/api/me/telegram/link", h(handleTelegramUnlink));
app.get("/api/me/telegram/status", h(handleTelegramLinkStatus));
app.put("/api/me/telegram/active-project", h(handleTelegramSetActiveProject));

// Web Push (authenticated)
app.get("/api/push/vapid-key", h(handleGetVapidKey));
app.post("/api/push/subscribe", h(handlePushSubscribe));
app.delete("/api/push/subscribe", h(handlePushUnsubscribe));

// Notification subscriptions (per-user kind × channel opt-out)
app.get("/api/me/notification-subscriptions", h(handleListNotificationSubscriptions));
app.put("/api/me/notification-subscriptions/:kind/:channel", h(handleUpdateNotificationSubscription));

// Pending responses (two-way notifications — web reply toast + click-through page)
app.get("/api/pending-responses/:id", h(handleGetPendingResponse));
app.post("/api/pending-responses/:id/respond", h(handleRespondPendingResponse));

// Setup (no auth required)
app.get("/api/setup/status", h(handleSetupStatus));
app.post("/api/setup/complete", h(handleSetupComplete));

// Admin
app.get("/api/admin/users", h(handleListUsers));
app.post("/api/admin/users", h(handleCreateUser));
app.put("/api/admin/users/:userId", h(handleUpdateUser));
app.delete("/api/admin/users/:userId", h(handleDeleteUser));

// Admin: user invitations
app.get("/api/admin/invitations", h(handleListAdminInvitations));
app.post("/api/admin/invitations", h(handleCreateInvitation));
app.delete("/api/admin/invitations/:id", h(handleDeleteInvitation));

// Public: user invitation accept flow
app.get("/api/user-invitations/:token", h(handleLookupInvitation));
app.post("/api/user-invitations/:token/accept", h(handleAcceptUserInvitation));

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

// Workspace sync approval
app.post("/api/sync/:id/verdict", h(handleSyncVerdict));
app.get("/api/sync/:id/diff", h(handleSyncDiff));
app.get("/api/sync/:id", h(handleSyncStatus));

// Settings
app.get("/api/settings", h(handleGetSettings));
app.put("/api/settings/:key", h(handleUpdateSettings));

// OAuth — Codex inference provider
app.get("/api/oauth/codex/status", h(handleCodexStatus));
app.post("/api/oauth/codex/import", h(handleCodexImport));
app.post("/api/oauth/codex/disconnect", h(handleCodexDisconnect));

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
app.post("/api/projects/:projectId/services/:serviceId/share", h(handleCreateShareLink));
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
  const result = await reconcile().then(r => ({
    success: r.healthy > 0,
    error: r.healthy === 0 ? "No healthy runners available" : undefined,
  }));
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
    theme: getSetting("UI_THEME") ?? "default",
  }, { headers: corsHeaders });
}));

// Short-lived token for /_apps/* browser navigation
app.post("/api/app-token", h(async (req: Request) => {
  const { userId, username } = await authenticateRequest(req);
  const { createAppToken } = await import("@/lib/auth.ts");
  const appToken = await createAppToken(userId, username);
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

// Runner-proxy CLI handlers — only reachable via the trusted runner
// proxy on behalf of an in-container `zero` CLI/SDK call. See
// server/cli-handlers/middleware.ts for the auth model.
mountCliHandlers(app);

// API 404 catch-all
app.all("/api/*", (c) => {
  httpLog.warn("not found", { method: c.req.method, path: c.req.path });
  return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
});

// Frontend serving — same path for dev and prod.
// In dev: served from web/dist/ on disk (rebuilt by `bun build.ts --watch`).
// In compiled prod: served from embedded assets, with disk fallback.
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

// Error handler
app.onError((err, c) => {
  httpLog.error("server error", err);
  return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
});

// ── Start server ──

import { createServer as createHttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";

const honoListener = getRequestListener(app.fetch);
const nodeServer = createHttpServer(honoListener);

import { attachWebSocketServer, closeWebSocketServer } from "@/lib/ws.ts";
import { startWsBridge, startBackgroundBridge } from "@/lib/ws-bridge.ts";
import { initBackgroundTaskListeners } from "@/lib/background-task-store.ts";
import { initBackgroundResume } from "@/lib/background-resume.ts";

attachWebSocketServer(nodeServer);
startWsBridge();
startBackgroundBridge();
initBackgroundTaskListeners();
// Must init after initBackgroundTaskListeners so the store-update listener
// runs before the resume listener reads from it (Set iteration preserves
// insertion order, and EventBus dispatches in that order).
initBackgroundResume();

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

// Register the global Telegram provider + wire webhook or start the long-poller.
registerTelegramProvider();
registerGlobalPollerHandler(handleGlobalUpdate);
(async () => {
  const webhookRegistered = await ensureWebhookRegistered();
  if (!webhookRegistered) {
    await startGlobalPoller();
  }
})();

// Sweep pending-responses that expired while the server was down.
startupExpirySweep();
// Reject any still-pending sync approvals from a prior process — their
// owning runs are gone, so auto-reject and broadcast so any reconnecting
// UI flips the card.
recoverSyncOrphansOnStartup();

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
  stopGlobalPoller();
  // Unblock any tool calls waiting on a sync approval so their runs can
  // finish instead of timing out at the drain deadline.
  const cancelledSyncs = cancelAllPendingSyncs("shutdown");
  if (cancelledSyncs > 0) {
    log.info("cancelled pending sync approvals on shutdown", {
      count: cancelledSyncs,
    });
  }
  await drainActiveRuns(IS_PROD ? 30_000 : 2_000);
  closeWebSocketServer();
  await teardownExecution();
  s3.close();
  db.close();
  log.info("shutdown complete");
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

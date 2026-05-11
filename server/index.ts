import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { corsHeaders } from "@/lib/http/cors.ts";
import { log } from "@/lib/utils/logger.ts";
import { handleHealth } from "@/routes/health.ts";
import { handleLogin, handleLogout, handleMe, handleUpdateMe, handlePasswordResetInit, handlePasswordResetPasskeyOptions, handlePasswordResetPasskeyConfirm } from "@/routes/auth.ts";
import {
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyEnrollOptions,
  handlePasskeyEnrollVerify,
  handlePasskeyList,
  handlePasskeyDelete,
} from "@/routes/passkeys.ts";
import { checkCsrf } from "@/lib/http/csrf.ts";
import {
  handleListProjects,
  handleCreateProject,
  handleGetProject,
  handleUpdateProject,
  handleDeleteProject,
} from "@/routes/projects.ts";
import {
  handleListChats,
  handleCreateChat,
  handleUpdateChat,
  handleDeleteChat,
  handleSearchChats,
} from "@/routes/chats.ts";
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
  handleUpdateFileBinary,
} from "@/routes/files.ts";
import {
  handleGetTurnSnapshotDiff,
  handleGetTurnSnapshotFile,
  handleRevertTurnSnapshot,
} from "@/routes/turn-snapshots.ts";
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
  handleListApps,
  handleDeleteApp,
  handleAppStatus,
  handleCreateShareLink,
} from "@/routes/apps.ts";
import { startBrowserPool, stopBrowserPool } from "@/lib/browser/host-pool.ts";
import { proxyAppRequest } from "@/lib/http/app-proxy.ts";
import { getSetting } from "@/lib/settings.ts";

import {
  handleListSkills,
  handleInstallSkill,
  handleDiscoverSkills,
  handleInstallFromGithub,
  handleGetSkill,
  handleDeleteSkill,
} from "@/routes/skills.ts";

import { startScheduler, stopScheduler } from "@/lib/scheduling/scheduler.ts";
import { requestShutdown, drainActiveRuns, isShuttingDown } from "@/lib/durability/shutdown.ts";
import { pruneOrphanedMessageVectors } from "@/lib/search/vectors.ts";
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
  handleListEnabledModels,
  handleListAllModels,
  handleCreateModel,
  handleUpdateModel,
  handleDeleteModel,
} from "@/routes/models.ts";
import { handleUsageSummary, handleUsageByModel, handleUsageByUser } from "@/routes/usage.ts";
import { requireAdmin, authenticateRequest } from "@/lib/auth/auth.ts";
import { verifyProjectAccess } from "@/routes/utils.ts";
import { db } from "@/db/index.ts";

const httpLog = log.child({ module: "http" });
const PORT = parseInt(process.env.PORT ?? "3000");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Embedded assets (populated at compile time, null in dev/normal prod)
let embeddedAssets: Record<string, { data: Buffer; mime: string; immutable: boolean }> | null = null;
// @ts-ignore - _generated/assets.ts only exists at compile time
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
    // Surface the trusted socket IP for rate-limit/IP lookups when not
    // behind a reverse proxy.
    const node = (c.env as any)?.incoming;
    if (node?.socket?.remoteAddress) {
      (req as any).socketIp = node.socket.remoteAddress;
    }
    const start = Date.now();
    const method = req.method;
    const urlPath = c.req.path;
    try {
      const csrfBlock = checkCsrf(req, urlPath);
      if (csrfBlock) return csrfBlock;
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
app.post("/api/auth/logout", h(handleLogout));
app.post("/api/auth/password-reset/init", h(handlePasswordResetInit));
app.post("/api/auth/password-reset/passkey-options", h(handlePasswordResetPasskeyOptions));
app.post("/api/auth/password-reset/passkey-confirm", h(handlePasswordResetPasskeyConfirm));
app.get("/api/me", h(handleMe));
app.put("/api/me", h(handleUpdateMe));

// Passkeys
app.post("/api/auth/passkey/register-options", h(handlePasskeyRegisterOptions));
app.post("/api/auth/passkey/register-verify", h(handlePasskeyRegisterVerify));
app.post("/api/auth/passkey/login-options", h(handlePasskeyLoginOptions));
app.post("/api/auth/passkey/login-verify", h(handlePasskeyLoginVerify));
app.post("/api/auth/passkey/enroll-options", h(handlePasskeyEnrollOptions));
app.post("/api/auth/passkey/enroll-verify", h(handlePasskeyEnrollVerify));
app.get("/api/auth/passkey/list", h(handlePasskeyList));
app.delete("/api/auth/passkey/:id", h(handlePasskeyDelete));

// Projects
app.get("/api/projects", h(handleListProjects));
app.post("/api/projects", h(handleCreateProject));
app.get("/api/projects/:id", h(handleGetProject));
app.put("/api/projects/:id", h(handleUpdateProject));
app.delete("/api/projects/:id", h(handleDeleteProject));

// Chat CRUD
app.get("/api/projects/:projectId/chats", h(handleListChats));
app.post("/api/projects/:projectId/chats", h(handleCreateChat));
app.get("/api/projects/:projectId/chats/search", h(handleSearchChats));
app.put("/api/projects/:projectId/chats/:chatId", h(handleUpdateChat));
app.delete("/api/projects/:projectId/chats/:chatId", h(handleDeleteChat));

// Files
app.get("/api/projects/:projectId/files", h(handleListFiles));
app.get("/api/projects/:projectId/files/search", h(handleSearchFiles));
app.post("/api/projects/:projectId/reindex", h(handleReindex));
app.get("/api/projects/:projectId/reindex/status", h(handleReindexStatus));
app.get("/api/projects/:projectId/reindex/stream", h(handleReindexStream));
app.post("/api/projects/:projectId/files/upload", h(handleUploadRequest));
app.get("/api/projects/:projectId/files/:id/url", h(handleGetFileUrl));
app.post("/api/projects/:projectId/files/:id/binary", h(handleUpdateFileBinary));
app.delete("/api/projects/:projectId/files/:id", h(handleDeleteFile));
app.put("/api/projects/:projectId/files/:id", h(handleUpdateFileContent));
app.patch("/api/projects/:projectId/files/:id", h(handleMoveFile));

// Turn snapshots (per-turn git diff / file / revert)
app.get("/api/turns/:snapshotId/diff", h(handleGetTurnSnapshotDiff));
app.get("/api/turns/:snapshotId/file", h(handleGetTurnSnapshotFile));
app.post("/api/turns/:snapshotId/revert", h(handleRevertTurnSnapshot));

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

// Telegram global webhook (unauthenticated - secret token verified)
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

// Pending responses (two-way notifications - web reply toast + click-through page)
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

// Apps (slug ↔ port reverse-proxy mappings)
app.get("/api/projects/:projectId/apps", h(handleListApps));
app.delete("/api/projects/:projectId/apps/:appId", h(handleDeleteApp));
app.post("/api/projects/:projectId/apps/:appId/share", h(handleCreateShareLink));
app.get("/api/apps/:slug/status", h(handleAppStatus));

// Content-addressed blob serving, scoped to a project the caller is a member of.
// Scoping is enforced via an in-memory ownership index populated at `putBlob`
// sites (screenshots, exec overflow). A bare `/api/blobs/:hash` route would be
// usable by any authenticated user who obtained a hash — so we require the
// caller to prove project membership and the blob to have been associated with
// that project.
app.get("/api/projects/:projectId/blobs/:hash", h(async (req: Request) => {
  const { userId } = await authenticateRequest(req);
  const projectId = (req as any).params.projectId as string;
  verifyProjectAccess(projectId, userId);
  const hash = (req as any).params.hash as string;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return Response.json({ error: "invalid hash" }, { status: 400, headers: corsHeaders });
  }
  const { getBlob, blobOwnedBy } = await import("@/lib/media/blob-store.ts");
  if (!blobOwnedBy(hash, projectId)) {
    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
  }
  const entry = await getBlob(hash);
  if (!entry) {
    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
  }
  return new Response(new Uint8Array(entry.bytes).buffer as ArrayBuffer, {
    headers: {
      ...corsHeaders,
      "Content-Type": entry.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${hash}"`,
    },
  });
}));

// Capabilities
app.get("/api/capabilities", h((_req: Request) => {
  return Response.json({
    theme: getSetting("UI_THEME") ?? "default",
  }, { headers: corsHeaders });
}));

// Lightweight memory/process debug. Auth required; returns only counts, no user data.
app.get("/api/debug/mem", h(async (req: Request) => {
  await authenticateRequest(req);
  const mem = process.memoryUsage();
  const fmt = (b: number) => Math.round(b / 1024 / 1024);
  return Response.json({
    uptimeSec: Math.round(process.uptime()),
    rssMB: fmt(mem.rss),
    heapUsedMB: fmt(mem.heapUsed),
    heapTotalMB: fmt(mem.heapTotal),
    externalMB: fmt(mem.external),
    arrayBuffersMB: fmt(mem.arrayBuffers),
    ...chatSceneStats(),
    blobs: (await import("@/lib/media/blob-store.ts")).blobStoreStats(),
  }, { headers: corsHeaders });
}));

// Short-lived token for /_apps/* browser navigation
app.post("/api/app-token", h(async (req: Request) => {
  const { userId, username } = await authenticateRequest(req);
  const { createAppToken } = await import("@/lib/auth/auth.ts");
  const appToken = await createAppToken(userId, username);
  return Response.json({ token: appToken }, { headers: corsHeaders });
}));

// Reverse proxy for forwarded ports
app.all("/_apps/:slug/*", (c) => {
  const slug = c.req.param("slug");
  if (slug) return proxyAppRequest(slug, c.req.raw);
  return new Response("Not found", { status: 404 });
});

// Mount the in-sandbox `zero` CLI handlers under `/v1/proxy/zero/*`.
// Auth is the per-turn token registered by `runTurn` (see
// `server/lib/pi/cli-server.ts`). Pi is pointed here via
// `ZERO_PROXY_URL=http://127.0.0.1:<port>` in the spawned env.
import { buildCliHandlerApp } from "@/cli-handlers/index.ts";
app.route("/v1/proxy", buildCliHandlerApp());

// API 404 catch-all
app.all("/api/*", (c) => {
  httpLog.warn("not found", { method: c.req.method, path: c.req.path });
  return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
});

// Frontend serving - same path for dev and prod.
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

import { attachWebSocketServer, closeWebSocketServer, shedChatScenes, chatSceneStats } from "@/lib/http/ws.ts";
import { startWsBridge } from "@/lib/http/ws-bridge.ts";

attachWebSocketServer(nodeServer);
startWsBridge();

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

startScheduler();

// Host browser pool — Chromium launches lazily on first action. Starting
// here just installs the idle-eviction sweep + frame event emitter wiring.
startBrowserPool();

import { startEventTriggers, stopAllEventTriggers } from "@/lib/scheduling/event-trigger.ts";
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

// ── Heap monitoring + self-defense (every 60s) ──
// heap cap is 400MB (--max-old-space-size=400). Above 300MB we aggressively
// drop recoverable caches (chat scenes, stale background tasks) as a last
// line of defense before V8 OOMs.
const HEAP_SHED_THRESHOLD_MB = 300;
const HEAP_MONITOR_INTERVAL_MS = Number(process.env.HEAP_MONITOR_INTERVAL_MS ?? 5_000);
let lastShedAt = 0;
let lastHeapLogMB = 0;
const _heapMonitor = setInterval(() => {
  const mem = process.memoryUsage();
  const fmt = (b: number) => (b / 1024 / 1024).toFixed(1);
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  // Always log on spike (>25MB change) or every ~60s baseline; otherwise stay quiet.
  const spike = Math.abs(heapUsedMB - lastHeapLogMB) > 25;
  const baseline = Date.now() % 60_000 < HEAP_MONITOR_INTERVAL_MS;
  if (spike || baseline) {
    log.info("heap", {
      rss: fmt(mem.rss) + "MB",
      heapUsed: fmt(mem.heapUsed) + "MB",
      heapTotal: fmt(mem.heapTotal) + "MB",
      external: fmt(mem.external) + "MB",
      arrayBuffers: fmt(mem.arrayBuffers) + "MB",
    });
    lastHeapLogMB = heapUsedMB;
  }
  if (heapUsedMB > HEAP_SHED_THRESHOLD_MB && Date.now() - lastShedAt > 60_000) {
    lastShedAt = Date.now();
    const scenes = shedChatScenes();
    log.warn("heap pressure: shed caches", { heapUsedMB: heapUsedMB.toFixed(0), scenes });
    if (typeof (globalThis as any).gc === "function") (globalThis as any).gc();
  }
}, HEAP_MONITOR_INTERVAL_MS);
if (typeof _heapMonitor === "object" && "unref" in _heapMonitor) _heapMonitor.unref();

// ── Periodic vector pruning (every 30 min) ──
const _vectorPruneInterval = setInterval(() => {
  try {
    const { projectsPruned, vectorsDeleted } = pruneOrphanedMessageVectors();
    if (vectorsDeleted > 0) {
      log.info("vector prune complete", { projectsPruned, vectorsDeleted });
    }
  } catch (err) {
    log.warn("vector prune failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 30 * 60 * 1000);
if (typeof _vectorPruneInterval === "object" && "unref" in _vectorPruneInterval) _vectorPruneInterval.unref();

// ── Graceful Shutdown ──

async function handleShutdown(signal: string) {
  if (isShuttingDown()) return; // prevent double-shutdown
  log.info("shutdown signal received", { signal });
  requestShutdown();
  stopScheduler();
  stopAllEventTriggers();
  stopGlobalPoller();
  await drainActiveRuns(IS_PROD ? 30_000 : 2_000);
  closeWebSocketServer();
  await stopBrowserPool().catch(() => {});
  db.close();
  log.info("shutdown complete");
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

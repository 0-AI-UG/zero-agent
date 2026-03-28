import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";
import { handleHealth } from "@/routes/health.ts";
import { handleLogin, handleMe } from "@/routes/auth.ts";
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
} from "@/routes/chats.ts";
import { handleChat } from "@/routes/chat.ts";
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
  handleParseScreenshot,
  handleUpdateFileContent,
  handleGetUploadUrl,
  handleUpdateFileBinary,
} from "@/routes/files.ts";
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
import { presignHandler } from "@/lib/s3.ts";

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

import {
  handleConvertSlides,
  handleConvertSlidesPdf,
  handleSlidePreviews,
} from "@/routes/slides.ts";
import { startScheduler } from "@/lib/scheduler.ts";
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

const httpLog = log.child({ module: "http" });
const PORT = parseInt(process.env.PORT ?? "3001");

function withLogging(handler: (req: any, ...args: any[]) => Response | Promise<Response>) {
  return async (req: Request, ...args: any[]) => {
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
  routes: {
    "/api/health": {
      GET: withLogging(handleHealth),
    },
    "/api/auth/login": {
      POST: withLogging(handleLogin),
    },
    "/api/me": {
      GET: withLogging(handleMe),
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
    "/api/projects/:projectId/chats/:chatId": {
      PUT: withLogging(handleUpdateChat),
      DELETE: withLogging(handleDeleteChat),
    },
    "/api/projects/:projectId/chats/:chatId/chat": {
      POST: (req: any, server: any) => {
        server.timeout(req, 0);
        httpLog.info("request", { method: "POST", path: new URL(req.url).pathname, note: "streaming" });
        return handleChat(req);
      },
    },
    "/api/projects/:projectId/chats/:chatId/stream": {
      GET: (req: any, server: any) => {
        server.timeout(req, 0);
        return handleResumeStream(req);
      },
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
    // Parse screenshot
    "/api/projects/:projectId/parse-screenshot": {
      POST: withLogging(handleParseScreenshot),
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
    // Slides
    "/api/projects/:projectId/slides/convert": {
      POST: withLogging(handleConvertSlides),
    },
    "/api/projects/:projectId/slides/convert-pdf": {
      POST: withLogging(handleConvertSlidesPdf),
    },
    "/api/projects/:projectId/slides/previews": {
      POST: withLogging(handleSlidePreviews),
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
  },
  fetch(request, server) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade for companion agent
    const url = new URL(request.url);
    if (url.pathname === "/ws/companion") {
      // Rate limit by IP
      const ip = server.requestIP(request)?.address ?? "unknown";
      if (isWsRateLimited(ip)) {
        return Response.json({ error: "Too many connection attempts" }, { status: 429, headers: corsHeaders });
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

    httpLog.warn("not found", { method: request.method, path: url.pathname });
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders },
    );
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
});

log.info("server started", { port: server.port, logLevel: process.env.LOG_LEVEL ?? "debug" });

startScheduler();

import { startEventTriggers } from "@/lib/event-trigger.ts";
startEventTriggers();

// Start Telegram polling for all configured bots (only when webhooks are not configured)
if (!process.env.TELEGRAM_WEBHOOK_BASE_URL) {
  startAllPollers(processIncomingUpdate);
}

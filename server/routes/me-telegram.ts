/**
 * Per-user Telegram linking routes.
 *
 *  - POST   /api/me/telegram/link-code      - generate a short-lived code
 *  - DELETE /api/me/telegram/link           - unlink the current user
 *  - GET    /api/me/telegram/status         - current link state
 *  - PUT    /api/me/telegram/active-project - set active project for inbound messages
 */
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { TelegramProvider } from "@/lib/chat-providers/telegram/provider.ts";
import { getLinkForUser } from "@/lib/chat-providers/telegram/linker.ts";
import {
  getBotInfoSync,
  isBotConfigured,
} from "@/lib/telegram-global/bot.ts";
import { getVisibleProjectsForUser } from "@/db/queries/projects.ts";
import { setActiveProjectId } from "@/db/queries/user-telegram-links.ts";

export async function handleTelegramLinkCode(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    if (!isBotConfigured()) {
      return Response.json(
        { error: "Telegram bot is not configured" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await TelegramProvider.createLinkCode!(userId);
    const info = getBotInfoSync();
    return Response.json(
      {
        code: result.code,
        botUsername: info?.username ?? null,
        instructions: result.instructions,
        expiresIn: result.expiresIn,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleTelegramUnlink(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    await TelegramProvider.unlink!(userId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleTelegramLinkStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const link = getLinkForUser(userId);
    const info = getBotInfoSync();
    // Always return the user's projects so the picker can render even when
    // unlinked (the surface is hidden client-side, but the data is cheap).
    const projects = getVisibleProjectsForUser(userId).map((p) => ({
      id: p.id,
      name: p.name,
    }));
    // Effective active project: stored selection if still a member, else
    // first project (matches resolveUserProjectId in the bot).
    let activeProjectId: string | null = null;
    if (link) {
      if (
        link.active_project_id &&
        projects.some((p) => p.id === link.active_project_id)
      ) {
        activeProjectId = link.active_project_id;
      } else if (projects.length > 0) {
        activeProjectId = projects[0]!.id;
      }
    }
    return Response.json(
      {
        configured: isBotConfigured(),
        linked: !!link,
        botUsername: info?.username ?? null,
        telegramUsername: link?.telegram_username ?? null,
        linkedAt: link?.linked_at ?? null,
        activeProjectId,
        projects,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleTelegramSetActiveProject(
  request: Request,
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const link = getLinkForUser(userId);
    if (!link) {
      return Response.json(
        { error: "Telegram is not linked" },
        { status: 400, headers: corsHeaders },
      );
    }
    const body = (await request.json().catch(() => null)) as
      | { projectId?: string | null }
      | null;
    const projectId = body?.projectId ?? null;
    if (projectId !== null) {
      const projects = getVisibleProjectsForUser(userId);
      if (!projects.some((p) => p.id === projectId)) {
        return Response.json(
          { error: "Project not found" },
          { status: 404, headers: corsHeaders },
        );
      }
    }
    setActiveProjectId(userId, projectId);
    return Response.json({ ok: true, activeProjectId: projectId }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

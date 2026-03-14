import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, toUTC } from "@/routes/utils.ts";
import { getNotificationsByUser, getUnreadCount, markRead, markAllRead } from "@/db/queries/notifications.ts";

export async function handleListNotifications(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    const rows = getNotificationsByUser(userId);
    const unreadCount = getUnreadCount(userId);

    const notifications = rows.map((n) => ({
      id: n.id,
      type: n.type,
      data: JSON.parse(n.data),
      read: n.read === 1,
      createdAt: toUTC(n.created_at),
    }));

    return Response.json({ notifications, unreadCount }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMarkRead(request: BunRequest): Promise<Response> {
  try {
    await authenticateRequest(request);
    const { id } = request.params as { id: string };
    markRead(id);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMarkAllRead(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    markAllRead(userId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Notification subscription routes — per-user kind × channel opt-out.
 *
 * Model: default-on with explicit opt-out rows. GET returns the user's
 * explicit rules plus the current channel availability so the UI can
 * render the grid with accurate defaults. PUT upserts a single rule.
 *
 * Canonical kinds live in `server/lib/notifications/kinds.ts`. Channels
 * are `ws` | `push` | `telegram`.
 */

import { authenticateRequest } from "@/lib/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { ValidationError } from "@/lib/errors.ts";
import {
  listUserSubscriptions,
  upsertUserSubscription,
  type NotificationChannel,
} from "@/db/queries/user-notification-subscriptions.ts";
import {
  NOTIFICATION_KINDS,
  DEFAULT_NOTIFIABLE_KINDS,
  isDispatchableKind,
} from "@/lib/notifications/kinds.ts";
import { getChannelAvailability } from "@/lib/notifications/subscriptions.ts";

const CHANNELS: NotificationChannel[] = ["ws", "push", "telegram"];

const DISPATCHABLE_KINDS = Object.values(NOTIFICATION_KINDS).filter(
  isDispatchableKind
);

function isValidChannel(value: string): value is NotificationChannel {
  return (CHANNELS as string[]).includes(value);
}

function isValidKind(value: string): boolean {
  if (value === "*") return true;
  if (!DISPATCHABLE_KINDS.includes(value as (typeof DISPATCHABLE_KINDS)[number]))
    return false;
  return true;
}

export async function handleListNotificationSubscriptions(
  request: Request
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const rules = listUserSubscriptions(userId).map((r) => ({
      kind: r.kind,
      channel: r.channel as NotificationChannel,
      enabled: r.enabled === 1,
    }));
    const availability = getChannelAvailability(userId);
    return Response.json(
      {
        kinds: DISPATCHABLE_KINDS,
        defaultEnabledKinds: [...DEFAULT_NOTIFIABLE_KINDS],
        channels: CHANNELS,
        rules,
        availability,
      },
      { headers: corsHeaders }
    );
  } catch (e) {
    return handleError(e);
  }
}

export async function handleUpdateNotificationSubscription(
  request: Request
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const params = (
      request as unknown as { params: Record<string, string | undefined> }
    ).params;
    const kind = params.kind ?? "";
    const channel = params.channel ?? "";
    if (!kind || !isValidKind(kind)) {
      throw new ValidationError(`Unknown notification kind: ${kind}`);
    }
    if (!channel || !isValidChannel(channel)) {
      throw new ValidationError(`Unknown notification channel: ${channel}`);
    }
    const body = (await request.json()) as { enabled?: unknown };
    if (typeof body?.enabled !== "boolean") {
      throw new ValidationError("Body must include boolean 'enabled'");
    }
    upsertUserSubscription(userId, kind, channel, body.enabled);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e) {
    return handleError(e);
  }
}

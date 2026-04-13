import { authenticateRequest } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { getVapidKeys } from "@/lib/notifications/vapid.ts";
import {
  upsertSubscription,
  deleteSubscription,
} from "@/db/queries/push-subscriptions.ts";

export async function handleGetVapidKey(req: Request): Promise<Response> {
  try {
    await authenticateRequest(req);
    const keys = getVapidKeys();
    return Response.json({ publicKey: keys.publicKey });
  } catch (e) {
    return handleError(e);
  }
}

export async function handlePushSubscribe(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { endpoint, p256dh, auth } = await req.json();

    if (!endpoint || !p256dh || !auth) {
      return Response.json({ error: "Missing endpoint, p256dh, or auth" }, { status: 400 });
    }

    upsertSubscription(userId, endpoint, p256dh, auth);
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

export async function handlePushUnsubscribe(req: Request): Promise<Response> {
  try {
    await authenticateRequest(req);
    const { endpoint } = await req.json();

    if (!endpoint) {
      return Response.json({ error: "Missing endpoint" }, { status: 400 });
    }

    deleteSubscription(endpoint);
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

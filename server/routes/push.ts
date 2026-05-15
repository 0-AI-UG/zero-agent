import { authenticateRequest } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { getVapidKeys } from "@/lib/notifications/vapid.ts";
import {
  upsertSubscription,
  deleteSubscription,
  deleteAllSubscriptionsByUser,
  getSubscriptionsByUserId,
} from "@/db/queries/push-subscriptions.ts";
import { dispatch } from "@/lib/notifications/dispatcher.ts";

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

export async function handleNotificationTest(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const result = await dispatch({
      userIds: [userId],
      kind: "test",
      title: "Zero Agent",
      body: "Test notification — delivery is working.",
      url: "/",
    });
    const perUser = result.perUser[userId];
    return Response.json({
      ok: true,
      delivered: result.delivered,
      availability: perUser?.availability,
      skipped: perUser?.skipped ?? [],
      failed: perUser?.failed ?? [],
    });
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

/**
 * Account-level push status. `subscribed` reflects whether *any* of the
 * user's devices have an active subscription. The notifications UI is keyed
 * off this so the toggle reads the same on every device.
 */
export async function handlePushStatus(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const subs = getSubscriptionsByUserId(userId);
    return Response.json({ subscribed: subs.length > 0, deviceCount: subs.length });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * Disable push for the entire account by removing every subscription row.
 * Each device's local `pushManager.unsubscribe()` is best-effort and runs
 * client-side after this returns.
 */
export async function handlePushDisableAll(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const removed = deleteAllSubscriptionsByUser(userId);
    return Response.json({ ok: true, removed });
  } catch (e) {
    return handleError(e);
  }
}

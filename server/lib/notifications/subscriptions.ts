/**
 * Subscription resolution.
 *
 * Default-on with explicit opt-out: if no row exists in
 * user_notification_subscriptions for (user, kind, channel) - and the
 * channel is currently available - the notification fires. An explicit
 * `enabled = 0` row silences the kind×channel.
 *
 * Precedence: exact (kind, channel) → wildcard (kind='*', channel) → default.
 */

import { isKindChannelEnabled } from "@/db/queries/user-notification-subscriptions.ts";
import { isUserConnected } from "@/lib/http/ws.ts";
import { getSubscriptionsByUserId } from "@/db/queries/push-subscriptions.ts";
import { getLinkByUserId } from "@/db/queries/user-telegram-links.ts";
import { db } from "@/db/index.ts";
import { isFeatureEnabled } from "@/lib/email-global/mailbox.ts";

export type DispatchChannel = "ws" | "push" | "telegram" | "email";

export interface ChannelAvailability {
  ws: boolean;
  push: boolean;
  telegram: boolean;
  email: boolean;
}

function userHasEmailAddress(userId: string): boolean {
  if (!isFeatureEnabled()) return false;
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
  return !!user?.username && /@/.test(user.username);
}

export function getChannelAvailability(userId: string): ChannelAvailability {
  return {
    ws: isUserConnected(userId),
    push: getSubscriptionsByUserId(userId).length > 0,
    telegram: !!getLinkByUserId(userId),
    email: userHasEmailAddress(userId),
  };
}

/**
 * Decide which channels should receive a given (user, kind) event.
 * Only returns channels that are both allowed by subscription rules AND
 * currently available.
 */
export function resolveDispatchChannels(
  userId: string,
  kind: string
): DispatchChannel[] {
  return resolveDispatchChannelsDetailed(userId, kind).accepted;
}

export type SkipReason =
  | "unavailable"
  | "opted-out";

export interface ResolvedChannels {
  accepted: DispatchChannel[];
  skipped: Array<{ channel: DispatchChannel; reason: SkipReason }>;
  availability: ChannelAvailability;
}

/**
 * Same as `resolveDispatchChannels` but also returns the per-channel skip
 * reasons and the raw availability snapshot - used by the dispatcher to
 * surface "why was nothing delivered?" diagnostics back to callers (CLI
 * `zero notification send` prints these so users can see when a channel was
 * silenced because it isn't configured / connected).
 */
export function resolveDispatchChannelsDetailed(
  userId: string,
  kind: string
): ResolvedChannels {
  const avail = getChannelAvailability(userId);
  const accepted: DispatchChannel[] = [];
  const skipped: Array<{ channel: DispatchChannel; reason: SkipReason }> = [];

  for (const channel of ["ws", "push", "telegram", "email"] as const) {
    if (!avail[channel]) {
      skipped.push({ channel, reason: "unavailable" });
      continue;
    }
    const explicit = isKindChannelEnabled(userId, kind, channel);
    if (explicit === false) {
      skipped.push({ channel, reason: "opted-out" });
      continue;
    }
    accepted.push(channel);
  }

  return { accepted, skipped, availability: avail };
}

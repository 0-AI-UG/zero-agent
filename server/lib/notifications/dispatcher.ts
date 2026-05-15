/**
 * Notification dispatcher - fans a single logical notification out across
 * per-user channels (ws/push/telegram), honoring subscription opt-out.
 *
 * When `requestResponse` is provided, the dispatcher also creates a
 * pending_responses group (one row per target user) and returns a handle
 * whose promise resolves when any user responds on any channel.
 *
 * Telegram delivery is a no-op stub in Stage 2 - the real implementation
 * lands with `TelegramProvider.sendNotification` in Stage 5. The Stage 2
 * dispatcher leaves `telegram` out of `delivered` until the provider is
 * registered.
 */

import { log } from "@/lib/utils/logger.ts";
import { broadcastToUser } from "@/lib/http/ws.ts";
import { sendPushToUser } from "@/lib/notifications/web-push.ts";
import { createPendingGroup } from "@/lib/pending-responses/store.ts";
import type {
  PendingRequesterContext,
  PendingRequesterKind,
  PendingResponseGroupHandle,
} from "@/lib/pending-responses/types.ts";
import {
  resolveDispatchChannelsDetailed,
  type DispatchChannel,
  type ChannelAvailability,
  type SkipReason,
} from "./subscriptions.ts";
import { isDispatchableKind } from "./kinds.ts";

const dLog = log.child({ module: "notifications/dispatcher" });

export interface DispatchAction {
  id: string;
  label: string;
}

export interface DispatchRequestResponse {
  prompt: string;
  timeoutMs: number;
  requesterKind: PendingRequesterKind;
  requesterContext: PendingRequesterContext;
}

export interface DispatchInput {
  userIds: string[];
  kind: string;
  title: string;
  body: string;
  url?: string;
  actions?: DispatchAction[];
  /** Project scope - used for pending response rows + push click-through context. */
  projectId?: string | null;
  /** Arbitrary metadata attached to the WS payload + pending row. */
  payload?: Record<string, unknown>;
  /** When present, creates a pending_responses group and returns a handle. */
  requestResponse?: DispatchRequestResponse;
  /**
   * Internal - when the caller has already created a pending_responses group
   * (so it can track waiters), reuse it instead of making a new one.
   * Mutually exclusive with `requestResponse`.
   */
  overridePending?: {
    groupId: string;
    rowIdByUser: Record<string, string>;
    requiresReply: boolean;
  };
}

export interface PerUserDispatch {
  /** Channels we actually delivered to. */
  delivered: DispatchChannel[];
  /** Channels we skipped before attempting delivery, with reason. */
  skipped: Array<{ channel: DispatchChannel; reason: SkipReason }>;
  /** Channels that were attempted but failed at the transport (e.g. WS not connected, push gateway error). */
  failed: DispatchChannel[];
  /** Raw per-channel availability snapshot for the user at dispatch time. */
  availability: ChannelAvailability;
}

export interface DispatchResult {
  /** Channels successfully delivered to (aggregated, deduped across users). */
  delivered: DispatchChannel[];
  /** Per-user channel breakdown - useful for surfacing "why nothing fired" to the caller. */
  perUser: Record<string, PerUserDispatch>;
  /** Present iff `requestResponse` was set. */
  pending?: {
    groupId: string;
    handle: PendingResponseGroupHandle;
  };
}

type TelegramNotifier = (
  userId: string,
  input: {
    pendingResponseId: string | null;
    title: string;
    body: string;
    url?: string;
    actions?: DispatchAction[];
    projectId?: string | null;
  }
) => Promise<boolean>;

let telegramNotifier: TelegramNotifier | null = null;
let emailNotifier: TelegramNotifier | null = null;

/**
 * Register the Telegram notifier (called from Stage 5 when the global
 * TelegramProvider is wired up). Until then, telegram dispatch is a no-op.
 */
export function registerTelegramNotifier(fn: TelegramNotifier): void {
  telegramNotifier = fn;
}

/** Register the email notifier — called when EmailProvider is wired at boot. */
export function registerEmailNotifier(fn: TelegramNotifier): void {
  emailNotifier = fn;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  if (!isDispatchableKind(input.kind)) {
    dLog.warn("refused dispatch for non-dispatchable kind", {
      kind: input.kind,
    });
    return { delivered: [], perUser: {} };
  }
  if (input.userIds.length === 0) {
    return { delivered: [], perUser: {} };
  }

  if (input.requestResponse && input.overridePending) {
    throw new Error(
      "dispatch: `requestResponse` and `overridePending` are mutually exclusive",
    );
  }

  // Optionally create pending group first so every channel can carry
  // the row id(s).
  let pending: DispatchResult["pending"];
  let pendingIdByUser: Record<string, string> = {};
  let requiresReply = false;
  let groupIdForChannels: string | null = null;
  if (input.requestResponse) {
    const created = createPendingGroup({
      targetUserIds: input.userIds,
      projectId: input.projectId ?? null,
      kind: input.kind,
      requesterKind: input.requestResponse.requesterKind,
      requesterContext: input.requestResponse.requesterContext,
      prompt: input.requestResponse.prompt,
      payload: input.payload,
      timeoutMs: input.requestResponse.timeoutMs,
    });
    pending = { groupId: created.groupId, handle: created.handle };
    pendingIdByUser = Object.fromEntries(
      created.rows.map((r) => [r.target_user_id, r.id])
    );
    requiresReply = true;
    groupIdForChannels = created.groupId;
  } else if (input.overridePending) {
    pendingIdByUser = { ...input.overridePending.rowIdByUser };
    requiresReply = input.overridePending.requiresReply;
    groupIdForChannels = input.overridePending.groupId;
  }

  const perUser: Record<string, PerUserDispatch> = {};
  const deliveredSet = new Set<DispatchChannel>();

  await Promise.all(
    input.userIds.map(async (userId) => {
      const resolved = resolveDispatchChannelsDetailed(userId, input.kind);
      const fired: DispatchChannel[] = [];
      const failed: DispatchChannel[] = [];

      for (const channel of resolved.accepted) {
        const ok = await deliverChannel(channel, userId, input, {
          pendingResponseId: pendingIdByUser[userId] ?? null,
          groupId: groupIdForChannels,
          requiresReply,
        });
        if (ok) {
          fired.push(channel);
          deliveredSet.add(channel);
        } else {
          failed.push(channel);
        }
      }
      perUser[userId] = {
        delivered: fired,
        skipped: resolved.skipped,
        failed,
        availability: resolved.availability,
      };
    })
  );

  if (deliveredSet.size === 0 && input.userIds.length > 0) {
    // Surface a structured warning so operators can diagnose "no channels"
    // outcomes (e.g. user toggled all channels on but isn't actually
    // connected/configured for any of them).
    dLog.warn("dispatch produced no deliveries", {
      kind: input.kind,
      targetUserCount: input.userIds.length,
      perUser: Object.fromEntries(
        Object.entries(perUser).map(([uid, info]) => [
          uid,
          {
            availability: info.availability,
            skipped: info.skipped,
            failed: info.failed,
          },
        ])
      ),
    });
  }

  return {
    delivered: [...deliveredSet],
    perUser,
    pending,
  };
}

async function deliverChannel(
  channel: DispatchChannel,
  userId: string,
  input: DispatchInput,
  ctx: {
    pendingResponseId: string | null;
    groupId: string | null;
    requiresReply: boolean;
  }
): Promise<boolean> {
  try {
    switch (channel) {
      case "ws": {
        const sent = broadcastToUser(userId, {
          type: "notification",
          kind: input.kind,
          title: input.title,
          body: input.body,
          url: input.url,
          actions: input.actions,
          payload: input.payload,
          requiresReply: ctx.requiresReply,
          responseId: ctx.pendingResponseId,
          groupId: ctx.groupId,
        });
        return sent > 0;
      }
      case "push": {
        const result = await sendPushToUser(userId, {
          title: input.title,
          body: input.body.slice(0, 300),
          url: input.url,
          tag: `${input.kind}-${ctx.pendingResponseId ?? "broadcast"}`,
        });
        return result.succeeded > 0;
      }
      case "telegram": {
        if (!telegramNotifier) return false;
        return await telegramNotifier(userId, {
          pendingResponseId: ctx.pendingResponseId,
          title: input.title,
          body: input.body,
          url: input.url,
          actions: input.actions,
          projectId: input.projectId ?? null,
        });
      }
      case "email": {
        if (!emailNotifier) return false;
        if (!input.projectId) return false;
        return await emailNotifier(userId, {
          pendingResponseId: ctx.pendingResponseId,
          title: input.title,
          body: input.body,
          url: input.url,
          actions: input.actions,
          projectId: input.projectId,
        });
      }
    }
  } catch (err) {
    dLog.warn("channel delivery failed", {
      channel,
      userId,
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Notification handler — notify project members.
 *
 * All channels (WS, push, Telegram) are routed through the notification
 * dispatcher, which honours per-user opt-out subscriptions. Telegram
 * delivery uses the global TelegramProvider registered at boot.
 *
 * When the caller sets `respond: true`, the dispatch creates a pending-
 * responses group (one row per project member) and the handler returns
 * the `groupId` immediately. The CLI then polls `zero notification response`
 * / `/api/runner-proxy/zero/notification/response` until the group resolves,
 * expires, or is cancelled. Polling is an explicit CLI call (not a held
 * request) so we don't hog unix-socket slots or collide with the proxy's
 * request timeout.
 */
import type { z } from "zod";
import { getProjectMembers } from "@/db/queries/members.ts";
import { dispatch, type PerUserDispatch } from "@/lib/notifications/dispatcher.ts";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds.ts";
import type { DispatchChannel } from "@/lib/notifications/subscriptions.ts";
import { getPendingResponsesByGroup } from "@/db/queries/pending-responses.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type { NotificationSendInput, NotificationResponseInput } from "zero/schemas";

const DEFAULT_RESPOND_TIMEOUT_MS = 5 * 60_000;

export async function handleNotificationSend(
  ctx: CliContext,
  input: z.infer<typeof NotificationSendInput>,
): Promise<Response> {
  const deliveredSet = new Set<DispatchChannel>();

  // Target list = project members ∪ {CLI invoker}. The invoker is included
  // explicitly because admins can run a session in a project they're not
  // enrolled in (verifyProjectAccess bypasses project_members for admins),
  // so they would otherwise miss their own `zero notification send` outputs.
  const members = getProjectMembers(ctx.projectId);
  const memberIds = Array.from(
    new Set([ctx.userId, ...members.map((m) => m.user_id)]),
  );
  const respond = input.respond === true;
  const timeoutMs = input.timeoutMs ?? DEFAULT_RESPOND_TIMEOUT_MS;

  let groupId: string | null = null;
  let lastDispatchPerUser: Record<string, PerUserDispatch> | undefined;

  // WS + push fanout via dispatcher (per-user subscription aware).
  if (memberIds.length > 0) {
    const result = await dispatch({
      userIds: memberIds,
      kind: NOTIFICATION_KINDS.CLI_REQUEST,
      title: "Zero Agent",
      body: input.text,
      url: `/projects/${ctx.projectId}`,
      projectId: ctx.projectId,
      requestResponse: respond
        ? {
            prompt: input.text,
            timeoutMs,
            requesterKind: "cli",
            requesterContext: {
              userId: ctx.userId,
              projectId: ctx.projectId,
              chatId: ctx.chatId,
            },
          }
        : undefined,
    });
    for (const ch of result.delivered) deliveredSet.add(ch);
    groupId = result.pending?.groupId ?? null;
    lastDispatchPerUser = result.perUser;

    // We don't `await` the group handle here - CLI polls `message/response`.
    // Detach the promise so Node doesn't whine about an unhandled rejection
    // when the group expires/cancels before the CLI next polls.
    result.pending?.handle.wait().catch(() => {});
  }

  // When nothing was delivered, surface why per user so the CLI can print
  // an actionable message instead of a bare "no channels".
  let diagnostics: Array<{
    userId: string;
    availability: { ws: boolean; push: boolean; telegram: boolean };
    skipped: Array<{ channel: string; reason: string }>;
    failed: string[];
  }> | undefined;
  if (deliveredSet.size === 0 && memberIds.length > 0) {
    diagnostics = memberIds.map((uid) => {
      const info = lastDispatchPerUser?.[uid];
      return {
        userId: uid,
        availability: info?.availability ?? { ws: false, push: false, telegram: false },
        skipped: info?.skipped ?? [],
        failed: info?.failed ?? [],
      };
    });
  }

  return ok({
    delivered: [...deliveredSet],
    respond,
    groupId,
    timeoutMs: respond ? timeoutMs : undefined,
    diagnostics,
  });
}

/**
 * Poll a pending response group by id. Returns one of:
 *   - { status: "pending" }
 *   - { status: "resolved", response: { text, via } }
 *   - { status: "expired" }
 *   - { status: "cancelled" }
 *
 * If the groupId doesn't exist (or has no rows), returns `not_found`.
 */
export async function handleNotificationResponse(
  ctx: CliContext,
  input: z.infer<typeof NotificationResponseInput>,
): Promise<Response> {
  const rows = getPendingResponsesByGroup(input.groupId);
  if (rows.length === 0) return fail("not_found", "pending response not found", 404);

  // Only the caller's project is allowed to poll - containers are already
  // scoped to a single project via CliContext, so this is a hard invariant.
  if (rows[0]!.project_id && rows[0]!.project_id !== ctx.projectId) {
    return fail("forbidden", "pending response belongs to another project", 403);
  }

  const resolved = rows.find((r) => r.status === "resolved");
  if (resolved) {
    return ok({
      status: "resolved",
      response: {
        text: resolved.response_text ?? "",
        via: resolved.response_via ?? "unknown",
      },
    });
  }
  // If every row is non-pending and none resolved, surface the most terminal
  // state (expired > cancelled). If any row is still pending, we're pending.
  const stillPending = rows.some((r) => r.status === "pending");
  if (stillPending) return ok({ status: "pending" });
  if (rows.some((r) => r.status === "expired")) return ok({ status: "expired" });
  return ok({ status: "cancelled" });
}

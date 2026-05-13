/**
 * Email ChatProvider — registers with the ChatProvider registry and wires
 * the notification dispatcher's email hook.
 *
 * Per-project mailboxes: the dispatcher's notification context includes a
 * projectId. We send notifications from that project's mailbox to the
 * targeted user's email address (taken from `users.username` if it looks
 * like an email).
 *
 * `isLinkedForUser` returns true when at least one email-enabled project
 * has this user as a member AND the user has an address-shaped username.
 * That keeps email out of the dispatch fan-out when delivery isn't possible.
 */
import { log } from "@/lib/utils/logger.ts";
import { db } from "@/db/index.ts";
import {
  registerProvider,
  type ChatProvider,
  type NotificationPayload,
  type ProviderIncomingMessage,
  type ProviderSendContent,
  type ProviderSendResult,
} from "@/lib/chat-providers/index.ts";
import { registerEmailNotifier } from "@/lib/notifications/dispatcher.ts";
import {
  isFeatureEnabled,
  registerInboundHandler,
  sendForProject,
} from "@/lib/email-global/mailbox.ts";
import { newMessageIdLocalPart } from "@/lib/email-global/addressing.ts";
import { handleIncomingEmail } from "./router.ts";
import { formatNotificationEmail } from "./format.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import type { ParsedInbound } from "@/lib/email-global/parser.ts";

const eLog = log.child({ module: "chat-providers/email/provider" });

function userEmailAddress(userId: string): string | null {
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
  return user?.username && /@/.test(user.username) ? user.username : null;
}

function userHasEmailProject(userId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = ?
         AND p.email_enabled = 1
         AND p.email_address IS NOT NULL
         AND p.email_password_enc IS NOT NULL
       LIMIT 1`,
    )
    .get(userId);
  return !!row;
}

export const EmailProvider: ChatProvider = {
  name: "email",

  isAvailable(): boolean {
    return isFeatureEnabled();
  },

  isLinkedForUser(userId: string): boolean {
    return isFeatureEnabled() && userHasEmailProject(userId) && !!userEmailAddress(userId);
  },

  async handleIncoming(_msg: ProviderIncomingMessage): Promise<void> {
    // The mailbox registry calls handleIncomingEmail(projectId, parsed)
    // directly; ChatProvider.handleIncoming isn't used for the email path.
    throw new Error("EmailProvider.handleIncoming is not invoked — inbound flows through the mailbox registry");
  },

  async send(_userId: string, _content: ProviderSendContent): Promise<ProviderSendResult> {
    return { ok: false, error: "use sendNotification or sendProjectEmail" };
  },

  async sendNotification(userId: string, payload: NotificationPayload): Promise<ProviderSendResult> {
    const projectId = payload.projectId;
    if (!projectId) return { ok: false, error: "email notifications require projectId" };
    const project = getProjectById(projectId);
    if (!project || project.email_enabled !== 1 || !project.email_address) {
      return { ok: false, error: "project email not configured" };
    }
    const recipient = userEmailAddress(userId);
    if (!recipient) return { ok: false, error: "user has no email address" };

    const at = project.email_address.lastIndexOf("@");
    const domain = at > 0 ? project.email_address.slice(at + 1) : "localhost";

    const { subject, text, html } = formatNotificationEmail(payload);
    const messageId = `<${newMessageIdLocalPart()}@${domain}>`;
    const from = `${project.email_from_name || project.name} <${project.email_address}>`;

    const result = await sendForProject(projectId, {
      from,
      to: [recipient],
      subject,
      text,
      html,
      messageId,
    });
    return { ok: result.ok, messageId: result.messageId, error: result.error };
  },
};

export function registerEmailProvider(): void {
  registerProvider(EmailProvider);
  registerInboundHandler(async (projectId, inbound: ParsedInbound) => {
    await handleIncomingEmail(projectId, inbound);
  });
  registerEmailNotifier(async (userId, input) => {
    const result = await EmailProvider.sendNotification(userId, {
      pendingResponseId: input.pendingResponseId,
      title: input.title,
      body: input.body,
      url: input.url,
      actions: input.actions,
      projectId: input.projectId ?? null,
    });
    return result.ok;
  });
  eLog.info("email provider registered");
}

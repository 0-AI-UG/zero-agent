/**
 * Email CLI handlers — project-scoped list/read/send/search.
 *
 * `send` covers both cold outreach (no inReplyToId) and replies (server
 * derives recipients + threading from the parent row).
 */
import type { z } from "zod";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type {
  EmailListInput,
  EmailReadInput,
  EmailSendInput,
  EmailSearchInput,
} from "zero/schemas";
import {
  listEmailMessages,
  searchEmailMessages,
  getEmailMessageById,
} from "@/db/queries/email-messages.ts";
import type { EmailMessageRow } from "@/db/types.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { sendProjectEmail } from "@/lib/chat-providers/email/router.ts";

function rowToSummary(row: EmailMessageRow) {
  const to = (() => {
    try { return JSON.parse(row.to_addrs) as string[]; } catch { return []; }
  })();
  return {
    id: row.id,
    direction: row.direction,
    threadKey: row.thread_key,
    subject: row.subject,
    from: row.from_addr,
    to,
    receivedAt: row.received_at,
    hasAttachments: !!row.attachments && row.attachments !== "[]",
  };
}

function rowToMessage(row: EmailMessageRow) {
  const attachments = (() => {
    if (!row.attachments) return [];
    try { return JSON.parse(row.attachments) as Array<{ path: string; name: string; mime: string; sizeBytes: number }>; } catch { return []; }
  })();
  return {
    ...rowToSummary(row),
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments,
    inReplyTo: row.in_reply_to,
    references: row.references_hdr,
  };
}

export async function handleEmailList(
  ctx: CliContext,
  input: z.infer<typeof EmailListInput>,
): Promise<Response> {
  const rows = listEmailMessages({
    projectId: ctx.projectId,
    unread: input.unread,
    threadKey: input.threadKey,
    from: input.from,
    since: input.since,
    limit: input.limit,
  });
  return ok({ messages: rows.map(rowToSummary) });
}

export async function handleEmailRead(
  ctx: CliContext,
  input: z.infer<typeof EmailReadInput>,
): Promise<Response> {
  const row = getEmailMessageById(input.id);
  if (!row || row.project_id !== ctx.projectId) {
    return fail("not_found", "email not found", 404);
  }
  return ok(rowToMessage(row));
}

export async function handleEmailSend(
  ctx: CliContext,
  input: z.infer<typeof EmailSendInput>,
): Promise<Response> {
  const project = getProjectById(ctx.projectId);
  if (!project) return fail("not_found", "project not found", 404);
  if (project.email_enabled !== 1) return fail("forbidden", "email not enabled for this project", 403);

  // Reply path: derive `to` from parent if caller didn't supply real recipients.
  let to = input.to;
  if (input.inReplyToId) {
    const parent = getEmailMessageById(input.inReplyToId);
    if (!parent || parent.project_id !== ctx.projectId) {
      return fail("not_found", "parent message not found", 404);
    }
    if (to.length === 1 && to[0] === "_") {
      to = [parent.from_addr];
    }
  }

  const result = await sendProjectEmail({
    projectId: ctx.projectId,
    to,
    subject: input.subject,
    body: input.body,
    inReplyToId: input.inReplyToId ?? null,
    context: input.context ?? null,
  });
  if (!result.ok) return fail("send_failed", result.error ?? "send failed", 400);
  return ok(result);
}

export async function handleEmailSearch(
  ctx: CliContext,
  input: z.infer<typeof EmailSearchInput>,
): Promise<Response> {
  const rows = searchEmailMessages(ctx.projectId, input.query, input.limit);
  return ok({ messages: rows.map(rowToSummary) });
}

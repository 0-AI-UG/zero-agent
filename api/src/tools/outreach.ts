import { z } from "zod";
import { tool } from "ai";
import {
  insertOutreachMessage,
  getMessagesByLead,
  getApprovedMessagesByProject,
  getMessageById,
  updateMessageStatus,
  recordReply,
} from "@/db/queries/outreach-messages.ts";
import { getLeadById, updateLead } from "@/db/queries/leads.ts";
import { getProjectById } from "@/db/queries/projects.ts";

import { formatOutreachMessage } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:outreach" });

export function createOutreachTools(projectId: string) {
  return {
    sendDirectMessage: tool({
      description:
        "Draft and store an outreach message for a lead. If approval is required, the message is stored as 'pending' for user review. Otherwise it is stored as 'approved' and will be sent by the next automation run.",
      inputSchema: z.object({
        leadId: z.string().describe("The lead ID to message."),
        channel: z.enum(["direct_message", "comment", "email", "manual"]).optional()
          .describe("Channel to send on. If not specified, defaults based on lead's platform."),
        subject: z.string().optional().describe("Subject line (for email)."),
        content: z.string().describe("Message content to send to the lead."),
      }),
      execute: async ({ leadId, channel, subject, content }) => {
        const project = getProjectById(projectId);
        if (!project) {
          throw new Error("Project not found");
        }

        toolLog.info("sendDirectMessage", { projectId, leadId, channel });

        const lead = getLeadById(leadId);
        if (!lead || lead.project_id !== projectId) {
          throw new Error("Lead not found");
        }

        const resolvedChannel = channel ?? (lead.platform === "email" ? "email" : lead.platform ? "direct_message" : "manual");
        const resolvedSubject = subject ?? "";

        const needsApproval = !!project.outreach_approval_required;

        const message = insertOutreachMessage({
          leadId,
          projectId,
          channel: resolvedChannel,
          subject: resolvedSubject,
          body: content,
          status: needsApproval ? "pending" : "approved",
        });

        return formatOutreachMessage(message);
      },
    }),

    getOutreachHistory: tool({
      description:
        "Get the outreach message history for a specific lead, including any replies they sent back. Check the replyBody field on each message to see what the lead responded.",
      inputSchema: z.object({
        leadId: z.string().describe("The lead ID to get history for."),
      }),
      execute: async ({ leadId }) => {
        const lead = getLeadById(leadId);
        if (!lead || lead.project_id !== projectId) {
          throw new Error("Lead not found");
        }

        const allMessages = getMessagesByLead(leadId);
        const totalMessages = allMessages.length;
        const messages = allMessages.slice(-20);
        return {
          messages: messages.map(formatOutreachMessage),
          totalMessages,
          ...(totalMessages > 20 && { showing: 20 }),
        };
      },
    }),

    getApprovedMessages: tool({
      description:
        "Fetch all approved outreach messages for this project, enriched with lead info (platform, handle, profileUrl, email). Use this to get messages that need to be sent via browser or email.",
      inputSchema: z.object({}),
      execute: async () => {
        const approved = getApprovedMessagesByProject(projectId);
        if (approved.length === 0) {
          return { messages: [] };
        }

        const messages = approved.map((msg) => {
          const lead = getLeadById(msg.lead_id);
          return {
            ...formatOutreachMessage(msg),
            lead: lead ? {
              platform: lead.platform,
              handle: lead.platform_handle,
              profileUrl: lead.profile_url,
              email: lead.email,
              name: lead.name,
            } : null,
          };
        });

        return { messages };
      },
    }),

    updateOutreachStatus: tool({
      description:
        "Update the status of an outreach message after sending (or failing to send). Updates the message status and the lead's status accordingly — marks lead as 'contacted' on success, appends error to lead notes on failure.",
      inputSchema: z.object({
        messageId: z.string().describe("The outreach message ID to update."),
        status: z.enum(["sent", "failed"]).describe("The new status."),
        error: z.string().optional().describe("Error message if status is 'failed'."),
      }),
      execute: async ({ messageId, status, error }) => {
        const msg = getMessageById(messageId);
        if (!msg || msg.project_id !== projectId) {
          throw new Error("Message not found");
        }

        toolLog.info("updateOutreachStatus", { projectId, messageId, status });

        const now = new Date().toISOString();
        updateMessageStatus(msg.id, status, {
          sentAt: status === "sent" ? now : undefined,
          error,
        });

        const lead = getLeadById(msg.lead_id);
        if (lead) {
          if (status === "sent" && lead.status === "new") {
            updateLead(lead.id, { status: "contacted" });
          }
          if (status === "failed" && error) {
            const timestamp = now.split("T")[0];
            const entry = `\n\n---\n**${timestamp}**: Send failed (${msg.channel}): ${error}`;
            const newNotes = (lead.notes || "").trimEnd() + entry;
            updateLead(lead.id, { notes: newNotes });
          }
        }

        return { messageId, status, error };
      },
    }),

    recordOutreachReply: tool({
      description:
        "Record a reply received from a lead on an outreach message. Updates the message status to 'replied' and the lead status to 'replied'.",
      inputSchema: z.object({
        messageId: z.string().describe("The outreach message ID that was replied to."),
        replyBody: z.string().describe("The reply content from the lead."),
      }),
      execute: async ({ messageId, replyBody }) => {
        const msg = getMessageById(messageId);
        if (!msg || msg.project_id !== projectId) {
          throw new Error("Message not found");
        }

        toolLog.info("recordOutreachReply", { projectId, messageId });

        const updated = recordReply(msg.id, replyBody);

        const lead = getLeadById(msg.lead_id);
        if (lead) {
          updateLead(lead.id, { status: "replied" });
        }

        return formatOutreachMessage(updated);
      },
    }),
  };
}

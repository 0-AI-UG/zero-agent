import { z } from "zod";
import { tool } from "ai";
import {
  insertLead,
  getLeadsByProject,
  getLeadsForFollowUp,
  getLeadsForEnrichment,
  getLeadById,
  updateLead as updateLeadQuery,
} from "@/db/queries/leads.ts";
import { formatLead } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:leads" });

export function createLeadTools(projectId: string) {
  return {
    saveLead: tool({
      description:
        "Save a new lead to the project's lead list. Use this when the user mentions a potential prospect or asks you to record someone.",
      inputSchema: z.object({
        name: z.string().describe("The lead's name or handle."),
        source: z
          .string()
          .optional()
          .describe(
            "Where the lead was found (e.g., 'social media comment', 'DM inquiry', 'website').",
          ),
        notes: z
          .string()
          .optional()
          .describe(
            "Any relevant notes about the lead — their situation, concerns, what they said.",
          ),
        followUpDate: z
          .string()
          .optional()
          .describe("Suggested follow-up date in YYYY-MM-DD format."),
        platform: z
          .string()
          .optional()
          .describe("The platform where the lead was found (e.g., 'linkedin', 'twitter', 'instagram')."),
        platformHandle: z
          .string()
          .optional()
          .describe("The lead's handle on the platform (e.g., '@username')."),
        profileUrl: z
          .string()
          .optional()
          .describe("Link to the lead's profile."),
        interest: z
          .string()
          .optional()
          .describe("What product/service the lead showed interest in."),
        priority: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe(
            "Lead priority. High = asked about pricing/buying. Medium = engaged with content. Low = casual interaction.",
          ),
        tags: z
          .string()
          .optional()
          .describe("Comma-separated tags for categorization (e.g., 'pricing,DM,warm')."),
        email: z
          .string()
          .optional()
          .describe("The lead's email address for email outreach."),
        score: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe(
            "Lead score from 0-100. Higher = more likely to convert. Based on intent signals, engagement level, profile quality, and fit with the product. Leave empty if unsure — can be set later via enrichment.",
          ),
      }),
      execute: async ({ name, source, notes, followUpDate, platform, platformHandle, profileUrl, interest, priority, tags, score, email }) => {
        toolLog.info("saveLead", { projectId, name });
        try {
          const lead = insertLead(projectId, {
            name,
            source,
            notes,
            email,
            followUpDate,
            platform,
            platformHandle,
            profileUrl,
            interest,
            priority,
            tags,
            score,
          });
          toolLog.info("saveLead success", { projectId, leadId: lead.id });
          return { id: lead.id, name: lead.name, priority: lead.priority, score: lead.score };
        } catch (err) {
          toolLog.error("saveLead failed", err, { projectId, name });
          throw err;
        }
      },
    }),

    updateLead: tool({
      description:
        "Update an existing lead's status, notes, priority, or other fields. Use listLeads first to find the lead ID if needed. When changing status, last_interaction is auto-updated.",
      inputSchema: z.object({
        id: z.string().describe("The lead ID to update."),
        status: z
          .enum(["new", "contacted", "replied", "converted", "dropped"])
          .optional()
          .describe("New status for the lead."),
        notes: z
          .string()
          .optional()
          .describe(
            "Additional notes to append to the lead's existing notes. These are appended, not replaced.",
          ),
        email: z
          .string()
          .optional()
          .describe("Updated email address for the lead."),
        followUpDate: z
          .string()
          .optional()
          .describe("Updated follow-up date in YYYY-MM-DD format."),
        platform: z
          .string()
          .optional()
          .describe("Updated platform name."),
        platformHandle: z
          .string()
          .optional()
          .describe("Updated platform handle."),
        profileUrl: z
          .string()
          .optional()
          .describe("Updated profile URL."),
        interest: z
          .string()
          .optional()
          .describe("Updated product/service interest."),
        priority: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Updated priority level."),
        tags: z
          .string()
          .optional()
          .describe("Updated comma-separated tags."),
        score: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe(
            "Updated lead score (0-100). Set this after enrichment or when new intent signals are observed.",
          ),
      }),
      execute: async ({ id, status, notes, email, followUpDate, platform, platformHandle, profileUrl, interest, priority, tags, score }) => {
        toolLog.info("updateLead", { projectId, leadId: id, status });
        try {
          const existing = getLeadById(id);
          if (!existing || existing.project_id !== projectId) {
            throw new Error("Lead not found");
          }

          // Append notes to existing instead of replacing
          let resolvedNotes = notes;
          if (notes && existing.notes) {
            resolvedNotes = existing.notes.trimEnd() + "\n\n" + notes;
          }

          const lead = updateLeadQuery(id, {
            status,
            notes: resolvedNotes,
            email,
            followUpDate,
            platform,
            platformHandle,
            profileUrl,
            interest,
            priority,
            tags,
            score,
          });
          toolLog.info("updateLead success", { projectId, leadId: id });
          return formatLead(lead);
        } catch (err) {
          toolLog.error("updateLead failed", err, { projectId, leadId: id });
          throw err;
        }
      },
    }),

    appendLeadNote: tool({
      description:
        "Append a timestamped markdown note to a lead's notes. Used for logging events like send failures, status changes, or follow-up reminders.",
      inputSchema: z.object({
        id: z.string().describe("The lead ID."),
        note: z.string().describe("The note text to append."),
      }),
      execute: async ({ id, note }) => {
        const existing = getLeadById(id);
        if (!existing || existing.project_id !== projectId) {
          throw new Error("Lead not found");
        }
        const timestamp = new Date().toISOString().split("T")[0];
        const entry = `\n\n---\n**${timestamp}**: ${note}`;
        const newNotes = (existing.notes || "").trimEnd() + entry;
        const lead = updateLeadQuery(id, { notes: newNotes });
        return formatLead(lead);
      },
    }),

    listLeads: tool({
      description:
        "List all leads in this project, optionally filtered by status. Returns a summary view by default (id, name, status, priority, score, platform, platformHandle). Use verbose=true to get full details including notes.",
      inputSchema: z.object({
        status: z
          .enum(["new", "contacted", "replied", "converted", "dropped"])
          .optional()
          .describe("Filter leads by status. Omit to list all leads. Ignored when filter is set."),
        filter: z
          .enum(["due_for_followup", "needs_enrichment"])
          .optional()
          .describe(
            "Special filter (overrides status). 'due_for_followup' = leads with overdue follow_up_date or contacted >3 days without reply. 'needs_enrichment' = new leads with profile_url but no score.",
          ),
        verbose: z
          .boolean()
          .optional()
          .describe("Set to true to return full lead details including notes. Defaults to summary view."),
      }),
      execute: async ({ status, filter, verbose }) => {
        toolLog.debug("listLeads", { projectId, status, filter, verbose });
        const leads =
          filter === "due_for_followup"
            ? getLeadsForFollowUp(projectId)
            : filter === "needs_enrichment"
              ? getLeadsForEnrichment(projectId)
              : getLeadsByProject(projectId, status);
        toolLog.debug("listLeads result", { projectId, count: leads.length });

        if (verbose) {
          return { count: leads.length, leads: leads.map(formatLead) };
        }

        // Summary view — lightweight fields only
        return {
          count: leads.length,
          leads: leads.map((lead) => ({
            id: lead.id,
            name: lead.name,
            status: lead.status,
            priority: lead.priority,
            score: lead.score,
            platform: lead.platform,
            platformHandle: lead.platform_handle,
          })),
        };
      },
    }),
  };
}

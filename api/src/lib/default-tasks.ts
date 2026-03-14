import { insertTask, getTasksByProject, updateTask } from "@/db/queries/scheduled-tasks.ts";

const DEFAULT_TASKS = [
  {
    name: "Send Approved Messages",
    prompt: `You are an outreach automation agent. Your job is to send approved outreach messages and schedule follow-ups.

1. Call \`getApprovedMessages\` to fetch all pending approved messages.
2. If there are no messages, respond with HEARTBEAT_OK.
3. For each message:
   a. Check the lead's platform and channel.
   b. For email: use the email channel directly (handled automatically).
   c. For other platforms (DM, comment, manual): call \`loadSkill\` with the platform name to get sending instructions, then use the \`browser\` tool to send the message following those instructions.
   d. After sending successfully, call \`updateOutreachStatus\` with status "sent".
   e. After marking as sent, call \`updateLead\` to set followUpDate to 3 days from today (YYYY-MM-DD format). If the lead already has a followUpDate that is sooner than 3 days out, do NOT overwrite it.
   f. On failure, call \`updateOutreachStatus\` with status "failed" and the error message.
4. If there are multiple messages to send, use \`agent\` to process them in parallel. Each agent prompt MUST include step 3e about setting follow-up dates.
5. Always end with a summary of what was sent, any failures, and follow-up dates set.`,
    schedule: "every 15m",
    requiredTools: [
      "getApprovedMessages",
      "updateOutreachStatus",
      "loadSkill",
      "browser",
      "listLeads",
      "updateLead",
      "getOutreachHistory",
      "agent",
    ],
  },
  {
    name: "Check for Replies",
    prompt: `You are a reply-checking and reply-processing agent. Your job is to check platforms for new replies and analyze them to update the sales pipeline.

## Phase 1: Check for Replies

1. Call \`listLeads\` with status "contacted" to find leads we're waiting to hear back from.
2. If there are no contacted leads, respond with HEARTBEAT_OK.
3. For each contacted lead:
   a. Call \`getOutreachHistory\` to see what messages were sent and on which platform/channel.
   b. Skip leads where the most recent message already has status "replied".
   c. Call \`loadSkill\` with the lead's platform name to get instructions for checking replies.
   d. Use the \`browser\` tool to check for replies following the skill instructions.
   e. If a reply is found, call \`recordOutreachReply\` with the messageId and full reply content.

## Phase 2: Analyze Replies

4. Call \`loadSkill("lead-generation")\` to get the escalation rules and outreach playbook.
5. After checking all leads, call \`listLeads\` with status "replied" to get leads with replies.
6. For each replied lead, call \`getOutreachHistory\` to read the reply content. Then classify the reply:

   **Positive interest** (asking about pricing, features, wanting to learn more, requesting a demo/call):
   - Call \`updateLead\`: set priority to "high", set followUpDate to tomorrow (respond quickly!)
   - Call \`appendLeadNote\`: "Reply analysis: POSITIVE — [brief summary of what they want]"
   - Check project.md **Escalation rules** — if the reply matches an escalation trigger (e.g., custom pricing, enterprise deal, demo/call request), do NOT auto-respond. Instead, call \`appendLeadNote\` with "ESCALATION NEEDED: [reason]" and skip drafting a response so the user handles it personally.
   - If no escalation needed: draft a response using \`sendDirectMessage\` that addresses their specific questions/interest

   **Question/Neutral** (asking general questions, polite but non-committal):
   - Call \`updateLead\`: keep priority as-is, set followUpDate to 2 days from now
   - Call \`appendLeadNote\`: "Reply analysis: NEUTRAL — [brief summary]"
   - Draft a helpful response using \`sendDirectMessage\` that provides value and gently moves toward conversion

   **Not interested** (explicit rejection, "no thanks", "not now", unsubscribe):
   - Call \`updateLead\`: set status to "dropped"
   - Call \`appendLeadNote\`: "Reply analysis: NOT INTERESTED — [reason]"
   - Do NOT send a follow-up message

   **Out of office / delayed** (auto-reply, vacation, will get back later):
   - Call \`updateLead\`: set followUpDate to 7 days from now
   - Call \`appendLeadNote\`: "Reply analysis: OOO — returning approx [date if mentioned]"

7. If there are multiple leads to check in Phase 1, use \`agent\` to check them in parallel. Phase 2 analysis should run in the main agent to ensure consistent classification.
8. End with a summary: replies found, classifications made, messages drafted, follow-ups scheduled.`,
    schedule: "every 1h",
    requiredTools: [
      "listLeads",
      "getOutreachHistory",
      "recordOutreachReply",
      "loadSkill",
      "browser",
      "updateLead",
      "appendLeadNote",
      "sendDirectMessage",
      "agent",
    ],
  },
  {
    name: "Follow Up Reminders",
    prompt: `You are a follow-up management agent. Your job is to identify leads that need follow-up and draft contextual, personalized follow-up messages.

1. Call \`listLeads\` with filter "due_for_followup" to get all leads where follow_up_date is today or overdue, or status is "contacted" and last interaction was more than 3 days ago with no reply.
2. If there are no leads due for follow-up, respond with HEARTBEAT_OK.
3. Call \`loadSkill("lead-generation")\` to get the outreach and follow-up playbook.
4. Read \`product.md\` and \`project.md\` from project files for context on the product/service, brand voice, and outreach strategy. Pay attention to:
   - **Outreach Strategy** section: tone/voice, max follow-ups before dropping, escalation rules
   - **ICP** section: to keep follow-ups relevant to the lead's pain points
5. For each lead that needs follow-up:
   a. Call \`getOutreachHistory\` to review ALL previous messages and any replies.
   b. Determine the follow-up approach based on context:

      **First follow-up** (1 prior message, no reply):
      Reference the original message briefly. Add new value — share a relevant tip, case study mention, or ask a specific question about their needs. Keep it shorter than the original.

      **Second follow-up** (2 prior messages, no reply):
      Change the angle entirely. If the first messages were about features, try asking about their current pain points. If they were formal, try a more casual tone. Keep it very short (2-3 sentences).

      **Third+ follow-up** (3+ prior messages, no reply):
      Check the "Max follow-ups before dropping" in project.md's Outreach Strategy. If this follow-up exceeds the max, mark the lead as "dropped" with a note and do NOT send another message. Otherwise, send a "breakup" message — brief, friendly, no pressure. Example: "Just wanted to check if [product] is still relevant for you. No worries if not — happy to reconnect anytime." Then set the lead's followUpDate to 30 days from now for long-term nurture.

      **Re-engagement** (replied previously but went silent):
      Reference their previous reply specifically. Ask if their situation has changed or if they have new questions.

   c. Draft the follow-up using \`sendDirectMessage\` on the same channel as the original outreach.
   d. After drafting, call \`updateLead\` to set followUpDate to the appropriate next date:
      - After 1st follow-up: +5 days
      - After 2nd follow-up: +7 days
      - After 3rd+ follow-up: +30 days
      - After re-engagement: +3 days
   e. Call \`appendLeadNote\` to log what follow-up approach was used.

6. If there are more than 3 leads to follow up, use \`agent\` to process them in parallel. Each agent prompt must include the full context from steps 3-5.
7. End with a summary: leads followed up, message styles used, next follow-up dates set, any leads moved to long-term nurture.`,
    schedule: "every 6h",
    requiredTools: [
      "listLeads",
      "getOutreachHistory",
      "sendDirectMessage",
      "updateLead",
      "appendLeadNote",
      "loadSkill",
      "browser",
      "agent",
    ],
  },
  {
    name: "Enrich New Leads",
    prompt: `You are a lead enrichment agent. Your job is to visit new lead profiles and enrich them with data that helps prioritize outreach.

1. Call \`listLeads\` with filter "needs_enrichment" to find leads with status "new" that have a profile_url but no score.
2. If there are no leads to enrich, respond with HEARTBEAT_OK.
3. Call \`loadSkill("lead-generation")\` to get the qualification and scoring playbook.
4. Read BOTH \`project.md\` AND \`product.md\` from project files. Pay special attention to:
   - **Ideal Customer Profile (ICP):** role/title, industry, company size, pain points, buying signals
   - **Disqualification Criteria:** who should NOT be a lead
   - **Competitive Positioning:** competitors and advantages (to identify competitor users as prospects)
5. For each lead to enrich (max 5 per run to avoid rate limiting):
   a. Call \`loadSkill\` with the lead's platform name to get browsing instructions for that platform.
   b. Use the \`browser\` tool to visit the lead's profile_url.
   c. Extract key information and **match against the ICP**:
      - Bio/description — does their role/title match the ICP?
      - Industry/company — does it match the target industry and size?
      - Pain points — do they post about problems the product solves?
      - Buying signals — any signals matching those defined in the ICP? (e.g., asking about pricing, mentioning competitors, posting about the problem)
      - Audience size — followers, connections, engagement level
      - Activity level — how recently and frequently they post
      - Contact info — email, website, other platforms if visible
   d. Check the lead against **Disqualification Criteria** from project.md. If they match a disqualifier (competitor, wrong market, bot, inactive), set score to 0-19 and note the reason.
   e. Based on ICP match, call \`updateLead\` with:
      - score: 0-100 based on ICP fit:
        80-100: Strong ICP match + buying signals present
        60-79: Good ICP match, active profile, but no direct buying signals
        40-59: Partial ICP match, some relevance
        20-39: Weak ICP match or partially disqualified
        0-19: Disqualified or poor fit
      - interest: How they match the ICP (reference specific criteria)
      - tags: Comma-separated tags reflecting ICP dimensions (e.g., "decision-maker,saas,10k-followers,competitor-user")
      - notes: Enrichment findings with explicit ICP match reasoning
      - email: If found on profile
      - priority: "high" if score >= 70, "medium" if score >= 40, "low" otherwise
   f. If the profile cannot be accessed (private, deleted, error), set score to 0 and call \`appendLeadNote\` explaining why.

6. Use \`agent\` to process multiple leads in parallel. Each agent gets one lead with all context from steps 3-5.
7. End with a summary: leads enriched, score distribution, any high-priority leads discovered.`,
    schedule: "every 30m",
    requiredTools: [
      "listLeads",
      "updateLead",
      "appendLeadNote",
      "loadSkill",
      "browser",
      "agent",
    ],
  },
  {
    name: "Outreach Performance Review",
    prompt: `You are an outreach analytics agent. Your job is to analyze outreach performance and maintain a stats file that helps improve future messaging.

1. Read the file \`outreach-stats.md\` from project files. If it doesn't exist, you'll create it.
2. Gather data:
   a. Call \`listLeads\` to get all leads and their statuses.
   b. For leads with status "contacted", "replied", "converted", or "dropped", call \`getOutreachHistory\` to get message details and reply data.
3. Compute the following metrics:
   - Overall: Total leads, conversion rate (converted / total contacted), reply rate (replied / total sent), drop rate
   - By platform: Reply rate and conversion rate per platform
   - By channel: Reply rate per channel (DM vs comment vs email)
   - Timing: Average days between send and reply for successful replies
   - Follow-up effectiveness: Reply rate on 1st message vs 2nd follow-up vs 3rd follow-up
   - Message style notes: For messages that got positive replies, note common patterns (length, tone, question usage, personalization)
4. Write the updated stats to \`outreach-stats.md\` using this format:

# Outreach Performance Stats
Last updated: [date]

## Summary
- Total leads: X
- Contacted: X | Replied: X (Y%) | Converted: X (Y%) | Dropped: X

## Platform Performance
| Platform | Sent | Replied | Reply Rate | Converted |
| --- | --- | --- | --- | --- |
| [platform] | X | X | Y% | X |

## What Works
- [Observations about successful message patterns]

## What Doesn't Work
- [Patterns in messages that get no response or drops]

## Recommendations
- [Actionable suggestions for the next outreach batch]

5. Also update \`memory.md\` with any new insights under the "Lead Insights" section.
6. End with a brief summary of key metrics and any notable changes since last review.`,
    schedule: "every 24h",
    requiredTools: ["listLeads", "getOutreachHistory", "updateLead"],
  },
];

export function createDefaultTasks(projectId: string, userId: string): void {
  const existing = getTasksByProject(projectId);
  for (const task of DEFAULT_TASKS) {
    if (existing.some((t) => t.name === task.name)) continue;
    insertTask(projectId, userId, task.name, task.prompt, task.schedule, false, task.requiredTools);
  }
  // Migrate existing tasks to latest prompt and required_tools
  updateDefaultTasks(projectId);
}

/**
 * Update existing default tasks to match the latest prompt and required_tools.
 * Matches by task name — only updates tasks that still have default names.
 */
function updateDefaultTasks(projectId: string): void {
  const existing = getTasksByProject(projectId);
  for (const defTask of DEFAULT_TASKS) {
    const match = existing.find((t) => t.name === defTask.name);
    if (!match) continue;
    // Only update if prompt or tools differ
    const currentTools = match.required_tools;
    const newTools = JSON.stringify(defTask.requiredTools);
    if (match.prompt !== defTask.prompt || currentTools !== newTools) {
      updateTask(match.id, {
        prompt: defTask.prompt,
        required_tools: newTools,
      });
    }
  }
}

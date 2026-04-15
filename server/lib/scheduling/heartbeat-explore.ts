import { generateText } from "@/lib/openrouter/text.ts";
import type { Message } from "@/lib/messages/types.ts";
import { getEnrichModelId } from "@/lib/providers/index.ts";
import { readFromS3, writeToS3 } from "@/lib/s3.ts";
import { extractConversationText } from "@/lib/conversation/message-utils.ts";
import { log } from "@/lib/utils/logger.ts";

const hbLog = log.child({ module: "heartbeat-explore" });

const MAX_EXPLORE_ITEMS = 5;
const EXPLORE_HEADER = "## Explore";

function parseExploreItems(heartbeatRaw: string): { before: string; items: string[] } {
  const exploreIdx = heartbeatRaw.indexOf(EXPLORE_HEADER);
  if (exploreIdx === -1) {
    return { before: heartbeatRaw.trimEnd(), items: [] };
  }

  const before = heartbeatRaw.slice(0, exploreIdx).trimEnd();
  const exploreSection = heartbeatRaw.slice(exploreIdx + EXPLORE_HEADER.length);
  const items: string[] = [];

  for (const line of exploreSection.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed);
    }
  }

  return { before, items };
}

function renderHeartbeat(before: string, items: string[]): string {
  let out = before;
  if (items.length > 0) {
    out += `\n\n${EXPLORE_HEADER}\n\n`;
    out += items.join("\n") + "\n";
  }
  return out;
}

/**
 * Post-conversation hook: detect knowledge gaps and append them
 * as explore items to HEARTBEAT.md for autonomous investigation.
 */
export async function detectExploreItems(
  projectId: string,
  messages: Message[],
): Promise<void> {
  const conversationText = extractConversationText(messages, 10);

  if (conversationText.length < 50) {
    hbLog.debug("conversation too short for explore detection", { projectId });
    return;
  }

  // Read existing heartbeat
  let existingRaw = "";
  try {
    existingRaw = await readFromS3(`projects/${projectId}/HEARTBEAT.md`);
  } catch {
    hbLog.debug("no existing HEARTBEAT.md", { projectId });
  }

  const { before, items: existingItems } = parseExploreItems(existingRaw);

  // Don't add more if already at cap
  if (existingItems.length >= MAX_EXPLORE_ITEMS) {
    hbLog.debug("explore items at cap, skipping", { projectId, count: existingItems.length });
    return;
  }

  const existingText = existingRaw || "(empty)";

  const callLLM = () =>
    generateText({
      model: getEnrichModelId(),
      system: `You identify knowledge gaps and unanswered questions from conversations that an AI agent could investigate autonomously during its next heartbeat check.

Output format: one item per line, prefixed with "- [ ] "
Rules:
- Only suggest items achievable with web search, file reading, or data analysis
- Items should be specific and actionable (not vague like "learn more about X")
- Don't duplicate items already in the heartbeat checklist
- Max 2 new items
- If no meaningful gaps exist, output exactly: NONE`,
      messages: `## Current heartbeat checklist
${existingText}

## Recent conversation
${conversationText}`,
    });

  let result: Awaited<ReturnType<typeof callLLM>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await callLLM();
      break;
    } catch (error) {
      hbLog.warn("explore detection LLM call failed", {
        projectId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      } else {
        hbLog.error("explore detection failed after 3 attempts, skipping", { projectId });
        return;
      }
    }
  }

  const text = result!.text.trim();
  if (text === "NONE" || text.length === 0) {
    hbLog.debug("no explore items detected", { projectId });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const newItems: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [ ] ") && trimmed.length > 6) {
      const itemText = trimmed.slice(6).trim();
      // Dedup: skip if existing item contains same text (case-insensitive)
      const isDuplicate = existingItems.some(
        (existing) =>
          existing.toLowerCase().includes(itemText.toLowerCase()) ||
          itemText.toLowerCase().includes(existing.replace(/^- \[.\] /, "").replace(/ \(added:.*\)$/, "").toLowerCase()),
      );
      if (!isDuplicate) {
        newItems.push(`- [ ] ${itemText} (added: ${today})`);
      }
    }
  }

  if (newItems.length === 0) {
    hbLog.debug("no new explore items after dedup", { projectId });
    return;
  }

  // Merge and cap
  const allItems = [...existingItems, ...newItems].slice(-MAX_EXPLORE_ITEMS);

  const newHeartbeat = renderHeartbeat(before, allItems);
  await writeToS3(`projects/${projectId}/HEARTBEAT.md`, newHeartbeat);

  hbLog.info("explore items added to heartbeat", {
    projectId,
    newItems: newItems.length,
    totalExploreItems: allItems.length,
  });
}

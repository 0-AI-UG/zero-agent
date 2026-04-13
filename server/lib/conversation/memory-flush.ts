import { generateText } from "ai";
import type { UIMessage } from "ai";
import { getEnrichModel } from "@/lib/providers/index.ts";
import { readFromS3, writeToS3 } from "@/lib/s3.ts";
import { extractConversationText } from "@/lib/conversation/message-utils.ts";
import { embedEntries } from "@/lib/search/vectors.ts";
import { log } from "@/lib/utils/logger.ts";

const memLog = log.child({ module: "memory-flush" });

const MEMORY_SECTIONS = [
  "facts",
  "preferences",
  "decisions",
  "entities",
] as const;

type MemorySection = (typeof MEMORY_SECTIONS)[number];

const SECTION_HEADERS: Record<MemorySection, string> = {
  facts: "## Facts",
  preferences: "## Preferences",
  decisions: "## Decisions",
  entities: "## Entities",
};

/** Parse existing MEMORY.md into section -> entries map */
function parseMemory(
  raw: string,
): Record<MemorySection, string[]> {
  const sections: Record<MemorySection, string[]> = {
    facts: [],
    preferences: [],
    decisions: [],
    entities: [],
  };

  let current: MemorySection | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    // Match section headers
    for (const [key, header] of Object.entries(SECTION_HEADERS)) {
      if (trimmed === header) {
        current = key as MemorySection;
        break;
      }
    }

    // Collect bullet entries under current section
    if (current && trimmed.startsWith("- ")) {
      sections[current].push(trimmed.slice(2));
    }
  }

  return sections;
}

/** Render sections back to MEMORY.md format */
function renderMemory(sections: Record<MemorySection, string[]>): string {
  let out = "# Memory\n";

  for (const key of MEMORY_SECTIONS) {
    out += `\n${SECTION_HEADERS[key]}\n\n`;
    if (sections[key].length === 0) {
      out += "_No entries yet._\n";
    } else {
      for (const entry of sections[key]) {
        out += `- ${entry}\n`;
      }
    }
  }

  return out;
}

/** Parse the LLM text response into memory items */
function parseMemoryResponse(text: string): { section: MemorySection; content: string }[] {
  const items: { section: MemorySection; content: string }[] = [];
  const validSections = new Set<string>(MEMORY_SECTIONS);

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "NONE") continue;

    // Expected format: "section: content"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const section = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const content = trimmed.slice(colonIdx + 1).trim();

    if (validSections.has(section) && content.length > 0) {
      items.push({ section: section as MemorySection, content });
    }
  }

  return items;
}

const MAX_MEMORY_ENTRIES = 100;

/**
 * Flush extracted learnings directly into MEMORY.md.
 * Called incrementally during compaction (Phase 3) - no LLM call needed
 * since learnings are already extracted by the anchor extraction prompt.
 */
export async function flushLearnings(
  projectId: string,
  learnings: string[],
): Promise<void> {
  if (learnings.length === 0) return;

  let existingRaw = "";
  try {
    existingRaw = await readFromS3(`projects/${projectId}/MEMORY.md`);
  } catch {
    // No existing memory
  }

  const sections = parseMemory(existingRaw);

  for (const learning of learnings) {
    // Route learnings to the facts section
    const isDuplicate = sections.facts.some(
      (existing) =>
        existing.toLowerCase().includes(learning.toLowerCase()) ||
        learning.toLowerCase().includes(existing.toLowerCase()),
    );
    if (!isDuplicate) {
      sections.facts.push(learning);
    }
  }

  // Cap total entries
  const totalEntries = Object.values(sections).flat().length;
  if (totalEntries > MAX_MEMORY_ENTRIES) {
    for (const key of MEMORY_SECTIONS) {
      const max = Math.ceil(MAX_MEMORY_ENTRIES / MEMORY_SECTIONS.length);
      if (sections[key].length > max) {
        sections[key] = sections[key].slice(-max);
      }
    }
  }

  const newMemoryMd = renderMemory(sections);
  await writeToS3(`projects/${projectId}/MEMORY.md`, newMemoryMd);

  // Embed for semantic retrieval
  const allEntries: { id: string; text: string }[] = [];
  for (const key of MEMORY_SECTIONS) {
    for (let i = 0; i < sections[key].length; i++) {
      allEntries.push({ id: `${key}:${i}`, text: `[${key}] ${sections[key][i]}` });
    }
  }
  if (allEntries.length > 0) {
    await embedEntries(projectId, "memory", allEntries).catch((err) =>
      memLog.warn("learning embedding failed", { projectId, error: String(err) }),
    );
  }

  memLog.info("learnings flushed", { projectId, count: learnings.length });
}

/**
 * Run after a conversation finishes. Extracts key facts/preferences/decisions
 * from the recent messages and merges them into MEMORY.md.
 */
export async function flushConversationMemory(
  projectId: string,
  messages: UIMessage[],
): Promise<void> {
  // Only analyze the last 10 messages to keep cost/latency low
  const conversationText = extractConversationText(messages, 10);

  if (conversationText.length < 50) {
    memLog.debug("conversation too short for memory flush", { projectId });
    return;
  }

  // Read existing memory
  let existingRaw = "";
  try {
    existingRaw = await readFromS3(`projects/${projectId}/MEMORY.md`);
  } catch {
    memLog.debug("no existing MEMORY.md", { projectId });
  }

  const existingSections = parseMemory(existingRaw);
  const existingBullets = Object.values(existingSections).flat().join("\n");

  // Ask LLM to extract new memories (with retry for transient API errors)
  const callLLM = () =>
    generateText({
      model: getEnrichModel(),
      system: `You extract important information from conversations. Output new memory entries, one per line, in the format:
section: content

Valid sections: facts, preferences, decisions, entities

Categories:
- facts: Concrete facts about the user, their business, market, or product
- preferences: User preferences for workflow, communication, content style
- decisions: Strategic decisions made during the conversation
- entities: Structured facts about specific things (APIs, services, configs, people)

Rules:
- Only extract information worth remembering across conversations
- Each entry: one line, format "section: content"
- Do NOT duplicate information already in existing memory
- If nothing new to remember, output exactly: NONE
- Maximum 5 new items`,
      prompt: `## Existing Memory Entries
${existingBullets || "(empty)"}

## Recent Conversation
${conversationText}`,
    });

  let result: Awaited<ReturnType<typeof callLLM>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await callLLM();
      break;
    } catch (error) {
      memLog.warn("memory flush LLM call failed", {
        projectId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      } else {
        memLog.error("memory flush failed after 3 attempts, skipping", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  const text = result!.text.trim();
  if (text === "NONE" || text.length === 0) {
    memLog.debug("no new memories extracted", { projectId });
    return;
  }

  const items = parseMemoryResponse(text);
  if (items.length === 0) {
    memLog.debug("no parseable memories in response", { projectId });
    return;
  }

  // Merge new items into existing sections
  for (const item of items) {
    const section = existingSections[item.section];
    // Simple dedup: skip if an existing entry contains the same content
    const isDuplicate = section.some(
      (existing) =>
        existing.toLowerCase().includes(item.content.toLowerCase()) ||
        item.content.toLowerCase().includes(existing.toLowerCase()),
    );
    if (!isDuplicate) {
      section.push(item.content);
    }
  }

  // Cap total entries
  const totalEntries = Object.values(existingSections).flat().length;
  if (totalEntries > MAX_MEMORY_ENTRIES) {
    memLog.warn("memory entries exceed cap, truncating oldest", {
      projectId,
      total: totalEntries,
    });
    // Trim from each section proportionally
    for (const key of MEMORY_SECTIONS) {
      const max = Math.ceil(MAX_MEMORY_ENTRIES / MEMORY_SECTIONS.length);
      if (existingSections[key].length > max) {
        existingSections[key] = existingSections[key].slice(-max);
      }
    }
  }

  const newMemoryMd = renderMemory(existingSections);
  await writeToS3(`projects/${projectId}/MEMORY.md`, newMemoryMd);

  // Embed all memory entries for semantic retrieval
  const allEntries: { id: string; text: string }[] = [];
  for (const key of MEMORY_SECTIONS) {
    for (let i = 0; i < existingSections[key].length; i++) {
      allEntries.push({ id: `${key}:${i}`, text: `[${key}] ${existingSections[key][i]}` });
    }
  }
  if (allEntries.length > 0) {
    await embedEntries(projectId, "memory", allEntries).catch((err) =>
      memLog.warn("memory embedding failed", { projectId, error: String(err) }),
    );
  }

  memLog.info("memory flushed", {
    projectId,
    newItems: items.length,
    totalEntries: Object.values(existingSections).flat().length,
  });
}

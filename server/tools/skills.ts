import { z } from "zod";
import { tool } from "ai";
import { loadFullSkill, checkGating } from "@/lib/skills/loader.ts";
import { events } from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:skills" });

export function createSkillTools(projectId: string, chatId?: string) {
  return {
    loadSkill: tool({
      description:
        "Load a skill's full instructions by name. Call this when you need platform-specific guidance (e.g., how to use LinkedIn, Instagram, etc.). The skill index in your system prompt shows available skills.",
      inputSchema: z.object({
        name: z.string().describe("The skill name to load (from the skills index)."),
      }),
      execute: async ({ name }) => {
        toolLog.info("loadSkill", { projectId, name });
        try {
          const skill = await loadFullSkill(projectId, name);
          if (!skill) {
            return { error: `Skill "${name}" not found or failed to load.` };
          }

          const gating = checkGating(skill.metadata);
          if (!gating.ok) {
            return {
              error: `Skill "${name}" has unmet requirements: ${gating.missing.join(", ")}`,
            };
          }

          events.emit("skill.loaded", { projectId, skillName: name, chatId: chatId ?? "" });

          return {
            name: skill.name,
            version: skill.metadata.version,
            instructions: skill.instructions,
            files: skill.files,
          };
        } catch (err) {
          toolLog.error("loadSkill failed", err, { projectId, name });
          return { error: `Failed to load skill "${name}".` };
        }
      },
    }),
  };
}

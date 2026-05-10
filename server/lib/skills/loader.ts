/**
 * Filesystem-backed skills reader. Walks `<projectDir>/.pi/skills/` and
 * parses each SKILL.md frontmatter for the install UI.
 *
 * Pi loads skills natively at startup via the `skills: ["./skills"]`
 * entry in `.pi/settings.json` — there is no longer any runtime
 * "inject skill into prompt" path on zero's side.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import which from "which";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { parseSkillMd } from "./parser.ts";
import type { LoadedSkill, SkillMetadata, SkillSummary } from "./types.ts";
import { log } from "@/lib/utils/logger.ts";

const skillLog = log.child({ module: "skills" });

function skillsRoot(projectId: string): string {
  return path.join(projectDirFor(projectId), ".pi", "skills");
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function getSkillSummaries(projectId: string): Promise<SkillSummary[]> {
  const root = skillsRoot(projectId);
  const entries = await readDirSafe(root);

  const summaries: SkillSummary[] = [];
  for (const name of entries) {
    const skillMd = path.join(root, name, "SKILL.md");
    try {
      const stat = await fs.stat(path.join(root, name));
      if (!stat.isDirectory()) continue;
      const content = await fs.readFile(skillMd, "utf-8");
      const { frontmatter } = parseSkillMd(content);
      summaries.push({
        name: frontmatter.name || name,
        description: frontmatter.description || "",
        metadata: frontmatter.metadata,
      });
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        skillLog.error("failed to read skill", err, { skillMd });
      }
    }
  }
  return summaries;
}

export async function loadFullSkill(
  projectId: string,
  name: string,
): Promise<LoadedSkill | null> {
  const dir = path.join(skillsRoot(projectId), name);
  const skillMd = path.join(dir, "SKILL.md");

  let content: string;
  try {
    content = await fs.readFile(skillMd, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }

  const { frontmatter, body } = parseSkillMd(content);
  const allEntries = await readDirSafe(dir);
  const files = allEntries.filter((f) => f !== "SKILL.md");

  return {
    ...frontmatter,
    instructions: body,
    files,
  };
}

export function checkGating(metadata: SkillMetadata): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const envVar of metadata.requires.env) {
    if (!process.env[envVar]) missing.push(`env:${envVar}`);
  }
  for (const bin of metadata.requires.bins) {
    if (!which.sync(bin, { nothrow: true })) missing.push(`bin:${bin}`);
  }
  return { ok: missing.length === 0, missing };
}

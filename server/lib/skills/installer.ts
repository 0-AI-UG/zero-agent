/**
 * Filesystem-canonical skill installer.
 *
 * Skills live at `<projectDir>/.pi/skills/<name>/`. Pi auto-discovers them
 * via the `skills: ["./skills"]` entry in `.pi/settings.json`. Zero just
 * writes the files and records minimal provenance in the `skills` table
 * for the install UI.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { parseSkillMd } from "./parser.ts";
import { insertSkill, deleteSkill } from "@/db/queries/skills.ts";
import { events } from "@/lib/scheduling/events.ts";
import { log } from "@/lib/utils/logger.ts";
import type { SkillFrontmatter } from "./types.ts";

const installLog = log.child({ module: "skills:installer" });

interface SkillFile {
  /** relative filename, e.g. "SKILL.md" or "prompts/search.md" */
  path: string;
  content: string;
}

export interface InstallResult {
  name: string;
  description: string;
  skillDir: string;
  metadata: SkillFrontmatter["metadata"];
}

function skillsRoot(projectId: string): string {
  return path.join(projectDirFor(projectId), ".pi", "skills");
}

export async function installSkillFiles(
  projectId: string,
  skillName: string,
  files: SkillFile[],
  source?: string,
): Promise<InstallResult> {
  const skillDir = path.join(skillsRoot(projectId), skillName);
  await fs.mkdir(skillDir, { recursive: true });

  for (const file of files) {
    const target = path.join(skillDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf-8");
  }

  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) throw new Error("SKILL.md is required");
  const { frontmatter } = parseSkillMd(skillMd.content);
  const resolvedName = frontmatter.name || skillName;

  try {
    insertSkill(projectId, {
      name: resolvedName,
      description: frontmatter.description,
      s3Key: source ?? `local:${skillName}`,
      metadata: JSON.stringify(frontmatter.metadata),
    });
  } catch {
    // UNIQUE — already recorded; the disk copy was just refreshed.
  }

  installLog.info("skill installed", { projectId, name: resolvedName, skillDir });
  events.emit("skill.installed", { projectId, skillName: resolvedName, source: skillDir });

  return {
    name: resolvedName,
    description: frontmatter.description,
    skillDir,
    metadata: frontmatter.metadata,
  };
}

export async function uninstallSkill(projectId: string, skillName: string): Promise<void> {
  const skillDir = path.join(skillsRoot(projectId), skillName);
  try {
    await fs.rm(skillDir, { recursive: true, force: true });
  } catch (err) {
    installLog.error("failed to remove skill dir", err, { skillDir });
  }

  deleteSkill(projectId, skillName);
  installLog.info("skill uninstalled", { projectId, name: skillName });
  events.emit("skill.uninstalled", { projectId, skillName });
}

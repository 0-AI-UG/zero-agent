import { writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { insertFile, getFilesByFolderPath, deleteFilesByFolderPath } from "@/db/queries/files.ts";
import { createFolder, getFolderByPath, deleteFoldersByPathPrefix } from "@/db/queries/folders.ts";
import { insertSkill, deleteSkill } from "@/db/queries/skills.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import { parseSkillMd } from "./parser.ts";
import { invalidateSummaryCache } from "./loader.ts";
import type { SkillFrontmatter } from "./types.ts";
import { events } from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";

const installLog = log.child({ module: "skills:installer" });

interface SkillFile {
  path: string; // relative filename, e.g. "SKILL.md" or "prompts/search.md"
  content: string;
}

function ensureFolder(projectId: string, path: string, name: string): void {
  const existing = getFolderByPath(projectId, path);
  if (!existing) {
    createFolder(projectId, path, name);
  }
}

export interface InstallResult {
  name: string;
  description: string;
  s3Key: string;
  metadata: SkillFrontmatter["metadata"];
}

export async function installSkillFiles(
  projectId: string,
  skillName: string,
  files: SkillFile[],
): Promise<InstallResult> {
  // Ensure /skills/ folder exists
  ensureFolder(projectId, "/skills/", "skills");

  // Ensure /skills/{name}/ folder exists
  ensureFolder(projectId, `/skills/${skillName}/`, skillName);

  // Write each file to S3 and create file DB entries
  for (const file of files) {
    const s3Key = `projects/${projectId}/skills/${skillName}/${file.path}`;
    const parts = file.path.split("/");
    const folderPath = parts.length > 1
      ? `/skills/${skillName}/${parts.slice(0, -1).join("/")}/`
      : `/skills/${skillName}/`;
    const mimeType = file.path.endsWith(".md") ? "text/markdown"
      : file.path.endsWith(".html") ? "text/html"
      : "text/plain";
    const sizeBytes = Buffer.from(file.content, "utf-8").byteLength;

    // Ensure all ancestor subfolders exist (e.g., /skills/{name}/a/, /skills/{name}/a/b/)
    if (parts.length > 1) {
      let currentPath = `/skills/${skillName}/`;
      for (const segment of parts.slice(0, -1)) {
        currentPath += segment + "/";
        ensureFolder(projectId, currentPath, segment);
      }
    }

    await writeToS3(s3Key, file.content);
    const fileRow = insertFile(projectId, s3Key, file.path, mimeType, sizeBytes, folderPath);
    indexFileContent(fileRow.id, projectId, file.path, file.content);
  }

  // Parse SKILL.md for metadata
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) {
    throw new Error("SKILL.md is required");
  }
  const { frontmatter } = parseSkillMd(skillMd.content);

  const s3Key = `projects/${projectId}/skills/${skillName}/SKILL.md`;
  const resolvedName = frontmatter.name || skillName;

  // Upsert skills table
  try {
    insertSkill(projectId, {
      name: resolvedName,
      description: frontmatter.description,
      s3Key,
      metadata: JSON.stringify(frontmatter.metadata),
    });
  } catch {
    // UNIQUE constraint — skill already exists
  }

  invalidateSummaryCache(projectId);
  installLog.info("skill installed", { projectId, name: resolvedName });
  events.emit("skill.installed", { projectId, skillName: resolvedName, source: s3Key });

  return {
    name: resolvedName,
    description: frontmatter.description,
    s3Key,
    metadata: frontmatter.metadata,
  };
}

export async function uninstallSkill(projectId: string, skillName: string): Promise<void> {
  const folderPath = `/skills/${skillName}/`;

  // Delete files from S3
  const files = getFilesByFolderPath(projectId, folderPath);
  for (const file of files) {
    try {
      await deleteFromS3(file.s3_key);
    } catch (err) {
      installLog.error("failed to delete file from S3", err, { s3Key: file.s3_key });
    }
  }

  // Delete file records
  deleteFilesByFolderPath(projectId, folderPath);

  // Delete folder entries
  deleteFoldersByPathPrefix(projectId, folderPath);

  // Delete skills table entry
  deleteSkill(projectId, skillName);

  invalidateSummaryCache(projectId);
  installLog.info("skill uninstalled", { projectId, name: skillName });
  events.emit("skill.uninstalled", { projectId, skillName });
}


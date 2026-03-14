import { readFromS3 } from "@/lib/s3.ts";
import { getSkillFiles, getSkillFileByName, getFilesByFolder } from "@/db/queries/files.ts";
import { getSkillsByProject, getSkillByName } from "@/db/queries/skills.ts";
import { getPublishedByProject, getPublishedSkillByName } from "@/db/queries/published-skills.ts";
import { parseSkillMd } from "./parser.ts";
import type { SkillSummary, LoadedSkill, SkillMetadata, SkillSource } from "./types.ts";
import { log } from "@/lib/logger.ts";

const skillLog = log.child({ module: "skills" });

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  summaries: SkillSummary[];
  expiresAt: number;
}

const summaryCache = new Map<string, CacheEntry>();

export async function getSkillSummaries(projectId: string): Promise<SkillSummary[]> {
  const cached = summaryCache.get(projectId);
  if (cached && Date.now() < cached.expiresAt) return cached.summaries;

  const rows = getSkillFiles(projectId);
  if (rows.length === 0) {
    const entry: CacheEntry = { summaries: [], expiresAt: Date.now() + CACHE_TTL_MS };
    summaryCache.set(projectId, entry);
    return [];
  }

  // Build a map of skill name -> source from the skills table
  const skillRows = getSkillsByProject(projectId);
  const sourceMap = new Map(skillRows.map((r) => [r.name, r.source as SkillSource]));
  const publishedMap = getPublishedByProject(projectId);

  const summaries = await Promise.all(
    rows.map(async (row): Promise<SkillSummary | null> => {
      try {
        const content = await readFromS3(row.s3_key);
        const { frontmatter } = parseSkillMd(content);
        // Derive skill name from folder path: /skills/{name}/ -> name
        const name = row.folder_path.split("/").filter(Boolean)[1]!;
        const resolvedName = frontmatter.name || name;
        return {
          name: resolvedName,
          description: frontmatter.description || "",
          metadata: frontmatter.metadata,
          s3Key: row.s3_key,
          source: sourceMap.get(resolvedName) ?? "user",
          published: publishedMap.has(resolvedName),
          downloads: publishedMap.get(resolvedName) ?? 0,
        };
      } catch (err) {
        skillLog.error("failed to parse skill", err, { s3Key: row.s3_key });
        return null;
      }
    }),
  );

  const valid = summaries.filter((s): s is SkillSummary => s !== null);
  summaryCache.set(projectId, { summaries: valid, expiresAt: Date.now() + CACHE_TTL_MS });
  return valid;
}

export async function loadFullSkill(projectId: string, name: string): Promise<LoadedSkill | null> {
  const row = getSkillFileByName(projectId, name);
  if (!row) return null;

  skillLog.info("loading full skill", { projectId, name, s3Key: row.s3_key });

  try {
    const content = await readFromS3(row.s3_key);
    const { frontmatter, body } = parseSkillMd(content);

    // List helper files from files DB
    const folderPath = `/skills/${name}/`;
    const fileRows = getFilesByFolder(projectId, folderPath);
    const files = fileRows
      .filter((f) => f.filename !== "SKILL.md")
      .map((f) => f.filename);

    const skillRow = getSkillByName(projectId, name);
    const publishedRow = getPublishedSkillByName(name);

    return {
      ...frontmatter,
      s3Key: row.s3_key,
      source: (skillRow?.source as SkillSource) ?? "user",
      published: publishedRow?.project_id === projectId,
      downloads: publishedRow?.downloads ?? 0,
      instructions: body,
      files,
    };
  } catch (err) {
    skillLog.error("failed to load skill", err, { projectId, name });
    return null;
  }
}

export function checkGating(metadata: SkillMetadata): { ok: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const envVar of metadata.requires.env) {
    if (!process.env[envVar]) {
      missing.push(`env:${envVar}`);
    }
  }

  for (const bin of metadata.requires.bins) {
    if (!Bun.which(bin)) {
      missing.push(`bin:${bin}`);
    }
  }

  return { ok: missing.length === 0, missing };
}

import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, publishSkillSchema, installCommunitySkillSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { getSkillFileByName } from "@/db/queries/files.ts";
import {
  getPublishedSkills,
  getPublishedSkillByName,
  insertPublishedSkill,
  incrementDownloads,
  deletePublishedSkill,
} from "@/db/queries/published-skills.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { getFilesByFolderPath } from "@/db/queries/files.ts";
import { parseSkillMd } from "@/lib/skills/parser.ts";
import { installSkillFiles } from "@/lib/skills/installer.ts";
import { NotFoundError } from "@/lib/errors.ts";
import { log } from "@/lib/logger.ts";

const communityLog = log.child({ module: "routes:community" });

type ProjectRequest = Request & { params: { projectId: string } };
type SkillNameRequest = Request & { params: { name: string } };

function formatPublishedSkill(row: {
  id: string;
  name: string;
  description: string;
  s3_key: string;
  metadata: string | null;
  publisher_id: string;
  downloads: number;
  published_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    publisherId: row.publisher_id,
    downloads: row.downloads,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export async function handleListCommunitySkills(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);

    const url = new URL(request.url);
    const q = url.searchParams.get("q") || undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    const rows = getPublishedSkills(q, limit, offset);
    return Response.json(
      { skills: rows.map(formatPublishedSkill) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetCommunitySkill(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);
    const { name } = (request as SkillNameRequest).params;

    const row = getPublishedSkillByName(name);
    if (!row) throw new NotFoundError(`Community skill "${name}" not found`);

    let content: string | null = null;
    try {
      content = await readFromS3(row.s3_key);
    } catch {
      // Publisher deleted the skill — clean up the listing
      deletePublishedSkill(name, row.publisher_id);
      throw new NotFoundError(`Skill "${name}" is no longer available`);
    }

    return Response.json(
      { skill: { ...formatPublishedSkill(row), content } },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePublishSkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as ProjectRequest).params;
    verifyProjectAccess(projectId, userId);

    const { name } = await validateBody(request, publishSkillSchema);

    const skillFile = getSkillFileByName(projectId, name);
    if (!skillFile) throw new NotFoundError(`Skill "${name}" not found in this project`);

    // Read SKILL.md for metadata
    const content = await readFromS3(skillFile.s3_key);
    const { frontmatter } = parseSkillMd(content);

    // Upsert published_skills row — points to the publisher's own S3 files
    const published = insertPublishedSkill({
      name,
      description: frontmatter.description,
      s3Key: skillFile.s3_key,
      metadata: JSON.stringify(frontmatter.metadata),
      publisherId: userId,
      projectId,
    });

    communityLog.info("skill published", { name, userId, projectId });

    return Response.json(
      { skill: formatPublishedSkill(published) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInstallCommunitySkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as ProjectRequest).params;
    verifyProjectAccess(projectId, userId);

    const { name } = await validateBody(request, installCommunitySkillSchema);

    const published = getPublishedSkillByName(name);
    if (!published) throw new NotFoundError(`Community skill "${name}" not found`);

    // Read all files from the publisher's project S3
    const sourceFiles = getFilesByFolderPath(published.project_id, `/skills/${name}/`);
    if (sourceFiles.length === 0) {
      // Publisher deleted the skill — clean up the listing
      deletePublishedSkill(name, published.publisher_id);
      throw new NotFoundError(`Skill "${name}" is no longer available`);
    }

    let files: { path: string; content: string }[];
    try {
      files = await Promise.all(
        sourceFiles.map(async (f) => ({
          path: f.filename,
          content: await readFromS3(f.s3_key),
        })),
      );
    } catch {
      // S3 files gone — clean up the listing
      deletePublishedSkill(name, published.publisher_id);
      throw new NotFoundError(`Skill "${name}" is no longer available`);
    }

    const result = await installSkillFiles(projectId, name, files, "community");
    incrementDownloads(name);

    communityLog.info("community skill installed", { name, projectId });

    return Response.json(
      {
        skill: {
          name: result.name,
          description: result.description,
          s3Key: result.s3Key,
          metadata: result.metadata,
          source: result.source,
        },
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpublishSkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { name } = (request as SkillNameRequest).params;

    const deleted = deletePublishedSkill(name, userId);
    if (!deleted) throw new NotFoundError(`Community skill "${name}" not found or you are not the publisher`);

    communityLog.info("skill unpublished", { name, userId });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

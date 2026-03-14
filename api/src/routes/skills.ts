import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import {
  validateBody,
  installSkillSchema,
  discoverSkillsSchema,
  installFromGithubSchema,
} from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { parseSkillMd } from "@/lib/skills/parser.ts";
import { loadFullSkill, getSkillSummaries } from "@/lib/skills/loader.ts";
import { installSkillFiles, uninstallSkill, loadBuiltInSkill } from "@/lib/skills/installer.ts";
import { parseGitHubUrl, discoverSkills, fetchSkillFiles } from "@/lib/skills/github.ts";
import { getSkillFileByName } from "@/db/queries/files.ts";
import { NotFoundError } from "@/lib/errors.ts";
import { log } from "@/lib/logger.ts";
import type { InstallResult } from "@/lib/skills/installer.ts";

const skillLog = log.child({ module: "routes:skills" });

type SkillsRequest = Request & { params: { projectId: string } };
type SkillByNameRequest = Request & { params: { projectId: string; name: string } };

function formatInstallResult(result: InstallResult) {
  return {
    name: result.name,
    description: result.description,
    s3Key: result.s3Key,
    metadata: result.metadata,
    source: result.source,
  };
}

export async function handleListSkills(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as SkillsRequest).params;
    verifyProjectAccess(projectId, userId);

    const summaries = await getSkillSummaries(projectId);
    return Response.json(
      { skills: summaries },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleListAvailableSkills(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as SkillsRequest).params;
    verifyProjectAccess(projectId, userId);

    const { readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const skillsDir = resolve(import.meta.dir, "../../../skills");

    const summaries = await getSkillSummaries(projectId);
    const installedNames = new Set(summaries.map((s) => s.name));

    const available: { name: string; description: string; metadata: Record<string, unknown> }[] = [];

    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (installedNames.has(entry.name)) continue;

        try {
          const skillMdPath = `${skillsDir}/${entry.name}/SKILL.md`;
          const file = Bun.file(skillMdPath);
          const content = await file.text();
          const { frontmatter } = parseSkillMd(content);

          available.push({
            name: frontmatter.name,
            description: frontmatter.description,
            metadata: frontmatter.metadata as unknown as Record<string, unknown>,
          });
        } catch {
          // Skip directories without valid SKILL.md
        }
      }
    } catch {
      // skills directory doesn't exist
    }

    return Response.json({ available }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInstallSkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as SkillsRequest).params;
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, installSkillSchema);

    let result: InstallResult;

    if ("builtIn" in body) {
      const files = await loadBuiltInSkill(body.builtIn);
      result = await installSkillFiles(projectId, body.builtIn, files, "built-in");
    } else {
      const { frontmatter } = parseSkillMd(body.content);
      const files = [{ path: "SKILL.md", content: body.content }];
      result = await installSkillFiles(projectId, frontmatter.name, files, "user");
    }

    skillLog.info("skill installed", { projectId, name: result.name });

    return Response.json(
      { skill: formatInstallResult(result) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDiscoverSkills(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as SkillsRequest).params;
    verifyProjectAccess(projectId, userId);

    const { url } = await validateBody(request, discoverSkillsSchema);
    const { owner, repo, branch, path } = parseGitHubUrl(url);
    const skills = await discoverSkills(owner, repo, branch, path);

    // Filter out already-installed skills
    const summaries = await getSkillSummaries(projectId);
    const installedNames = new Set(summaries.map((s) => s.name));
    const available = skills.filter((s) => !installedNames.has(s.name));

    return Response.json({ skills: available }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInstallFromGithub(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as SkillsRequest).params;
    verifyProjectAccess(projectId, userId);

    const { url, skills: skillNames } = await validateBody(request, installFromGithubSchema);
    const { owner, repo, branch, path } = parseGitHubUrl(url);

    const discovered = await discoverSkills(owner, repo, branch, path);
    const toInstall = discovered.filter((s) => skillNames.includes(s.name));

    const installed: InstallResult[] = [];
    for (const skill of toInstall) {
      const files = await fetchSkillFiles(owner, repo, branch, skill.path);
      const result = await installSkillFiles(projectId, skill.name, files, "github");
      installed.push(result);
    }

    return Response.json(
      { installed: installed.map(formatInstallResult) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetSkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, name } = (request as SkillByNameRequest).params;
    verifyProjectAccess(projectId, userId);

    const skill = await loadFullSkill(projectId, name);
    if (!skill) {
      throw new NotFoundError(`Skill "${name}" not found`);
    }

    return Response.json(
      { skill },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteSkill(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, name } = (request as SkillByNameRequest).params;
    verifyProjectAccess(projectId, userId);

    const existing = getSkillFileByName(projectId, name);
    if (!existing) {
      throw new NotFoundError(`Skill "${name}" not found`);
    }

    await uninstallSkill(projectId, name);
    skillLog.info("skill uninstalled", { projectId, name });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import {
  validateBody,
  publishMarketplaceSchema,
  installMarketplaceSchema,
  addReferenceSchema,
} from "@/lib/validation.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import {
  getMarketplaceItems,
  getMarketplaceItemById,
  getMarketplaceItemsByNames,
  insertMarketplaceItem,
  incrementMarketplaceDownloads,
  deleteMarketplaceItem,
} from "@/db/queries/marketplace.ts";
import {
  addReference,
  removeReference,
  getReferences,
} from "@/db/queries/marketplace-references.ts";
import { wouldCreateCycle } from "@/lib/marketplace/dependency-graph.ts";
import { resolveDependencyChain } from "@/lib/marketplace/dependency-resolver.ts";
import { getSkillFileByName, getFilesByFolderPath } from "@/db/queries/files.ts";
import { getTaskById } from "@/db/queries/scheduled-tasks.ts";
import { insertTask } from "@/db/queries/scheduled-tasks.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { parseSkillMd } from "@/lib/skills/parser.ts";
import { installSkillFiles, loadBuiltInSkill } from "@/lib/skills/installer.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import { log } from "@/lib/logger.ts";
import type { MarketplaceItemRow } from "@/db/types.ts";

const mktLog = log.child({ module: "routes:marketplace" });

type ProjectRequest = Request & { params: { projectId: string } };
type IdRequest = Request & { params: { id: string } };
type IdTargetRequest = Request & { params: { id: string; targetId: string } };

function formatItem(row: MarketplaceItemRow) {
  const refs = getReferences(row.id);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    // Skill fields
    s3Key: row.s3_key,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    // Template fields
    prompt: row.prompt,
    schedule: row.schedule,
    requiredTools: row.required_tools ? JSON.parse(row.required_tools) as string[] : null,
    // Common
    category: row.category,
    publisherId: row.publisher_id,
    projectId: row.project_id,
    downloads: row.downloads,
    publishedAt: toUTC(row.published_at),
    updatedAt: toUTC(row.updated_at),
    references: refs.map((r) => ({
      targetId: r.target_id,
      targetName: r.target_name,
      targetType: r.target_type,
      referenceType: r.reference_type,
    })),
  };
}

function formatItemLight(row: MarketplaceItemRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    prompt: row.prompt,
    schedule: row.schedule,
    requiredTools: row.required_tools ? JSON.parse(row.required_tools) as string[] : null,
    category: row.category,
    publisherId: row.publisher_id,
    projectId: row.project_id,
    downloads: row.downloads,
    publishedAt: toUTC(row.published_at),
    updatedAt: toUTC(row.updated_at),
  };
}

// GET /api/marketplace
export async function handleListMarketplace(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);

    const url = new URL(request.url);
    const type = url.searchParams.get("type") as "skill" | "template" | null;
    const q = url.searchParams.get("q") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    const rows = getMarketplaceItems({
      type: type ?? undefined,
      search: q,
      category,
      limit,
      offset,
    });

    return Response.json(
      { items: rows.map(formatItemLight) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// GET /api/marketplace/:id
export async function handleGetMarketplaceItem(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);
    const { id } = (request as IdRequest).params;

    const row = getMarketplaceItemById(id);
    if (!row) throw new NotFoundError("Marketplace item not found");

    return Response.json(
      { item: formatItem(row) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/projects/:pid/marketplace/publish
export async function handlePublishMarketplace(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as ProjectRequest).params;
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, publishMarketplaceSchema);

    let item: MarketplaceItemRow;

    if (body.type === "skill") {
      if (!body.skillName) throw new ValidationError("skillName is required for skill publish");

      const skillFile = getSkillFileByName(projectId, body.skillName);
      if (!skillFile) throw new NotFoundError(`Skill "${body.skillName}" not found in this project`);

      const content = await readFromS3(skillFile.s3_key);
      const { frontmatter } = parseSkillMd(content);

      item = insertMarketplaceItem({
        type: "skill",
        name: body.skillName,
        description: frontmatter.description,
        s3Key: skillFile.s3_key,
        metadata: JSON.stringify(frontmatter.metadata),
        publisherId: userId,
        projectId,
      });
    } else {
      if (!body.taskId) throw new ValidationError("taskId is required for template publish");

      const task = getTaskById(body.taskId);
      if (!task || task.project_id !== projectId) {
        throw new NotFoundError("Task not found in this project");
      }

      item = insertMarketplaceItem({
        type: "template",
        name: body.name ?? task.name,
        description: body.description ?? task.prompt.slice(0, 200),
        prompt: task.prompt,
        schedule: task.schedule,
        requiredTools: task.required_tools ? JSON.parse(task.required_tools) : null,
        category: body.category ?? "general",
        publisherId: userId,
        projectId,
      });

      // Auto-resolve references from task's required_skills
      if (task.required_skills) {
        const skillNames = JSON.parse(task.required_skills) as string[];
        if (skillNames.length > 0) {
          const found = getMarketplaceItemsByNames(skillNames);
          for (const s of found) {
            addReference(item.id, s.id, "mandatory");
          }
        }
      }
    }

    // Add explicit references
    if (body.references) {
      for (const ref of body.references) {
        if (wouldCreateCycle(item.id, ref.targetId)) {
          throw new ValidationError(`Adding reference to "${ref.targetId}" would create a circular dependency`);
        }
        addReference(item.id, ref.targetId, ref.referenceType);
      }
    }

    mktLog.info("published to marketplace", { type: body.type, name: item.name, userId, projectId });

    return Response.json(
      { item: formatItem(item) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/projects/:pid/marketplace/install
export async function handleInstallMarketplace(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as ProjectRequest).params;
    verifyProjectAccess(projectId, userId);

    const { itemId, confirm } = await validateBody(request, installMarketplaceSchema);

    const rootItem = getMarketplaceItemById(itemId);
    if (!rootItem) throw new NotFoundError("Marketplace item not found");

    const chain = resolveDependencyChain(itemId, projectId);

    // Preview mode — return what would be installed
    if (!confirm) {
      return Response.json(
        {
          preview: true,
          toInstall: chain.toInstall.map(formatItemLight),
          alreadyInstalled: chain.alreadyInstalled,
        },
        { headers: corsHeaders },
      );
    }

    // Install all items in topological order (dependencies first)
    const installed: { name: string; type: string }[] = [];

    for (const item of chain.toInstall) {
      if (item.type === "skill") {
        await installSkillItem(item, projectId);
      } else {
        installTemplateItem(item, projectId, userId);
      }
      incrementMarketplaceDownloads(item.id);
      installed.push({ name: item.name, type: item.type });
    }

    mktLog.info("installed from marketplace", { rootItem: rootItem.name, installed, projectId });

    return Response.json(
      { installed, alreadyInstalled: chain.alreadyInstalled },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

async function installSkillItem(item: MarketplaceItemRow, projectId: string) {
  // For built-in skills, load from disk
  if (item.s3_key === "built-in") {
    const files = await loadBuiltInSkill(item.name);
    await installSkillFiles(projectId, item.name, files, "built-in");
    return;
  }

  // Community skills — read source files from publisher's project
  const sourceFiles = getFilesByFolderPath(item.project_id, `/skills/${item.name}/`);
  if (sourceFiles.length === 0) {
    throw new NotFoundError(`Skill "${item.name}" source files are no longer available`);
  }

  const files = await Promise.all(
    sourceFiles.map(async (f) => ({
      path: f.filename,
      content: await readFromS3(f.s3_key),
    })),
  );

  await installSkillFiles(projectId, item.name, files, "community");
}

function installTemplateItem(item: MarketplaceItemRow, projectId: string, userId: string) {
  const requiredTools = item.required_tools ? JSON.parse(item.required_tools) as string[] : undefined;

  // Resolve references to skill names for local task storage
  const refs = getReferences(item.id);
  const skillNames = refs
    .filter((r) => r.reference_type === "mandatory" && r.target_type === "skill")
    .map((r) => r.target_name);

  insertTask(
    projectId,
    userId,
    item.name,
    item.prompt!,
    item.schedule!,
    true,
    requiredTools,
    skillNames.length > 0 ? skillNames : undefined,
  );
}

// DELETE /api/marketplace/:id
export async function handleDeleteMarketplaceItem(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as IdRequest).params;

    const item = getMarketplaceItemById(id);
    if (!item) throw new NotFoundError("Marketplace item not found");

    const deleted = deleteMarketplaceItem(item.name, userId);
    if (!deleted) throw new NotFoundError("Item not found or you are not the publisher");

    mktLog.info("unpublished from marketplace", { name: item.name, userId });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/marketplace/:id/references
export async function handleAddReference(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id: sourceId } = (request as IdRequest).params;

    const source = getMarketplaceItemById(sourceId);
    if (!source) throw new NotFoundError("Source item not found");
    if (source.publisher_id !== userId && source.publisher_id !== "system") {
      throw new ValidationError("Only the publisher can add references");
    }

    const { targetId, referenceType } = await validateBody(request, addReferenceSchema);

    const target = getMarketplaceItemById(targetId);
    if (!target) throw new NotFoundError("Target item not found");

    if (wouldCreateCycle(sourceId, targetId)) {
      throw new ValidationError("Adding this reference would create a circular dependency");
    }

    addReference(sourceId, targetId, referenceType);

    return Response.json(
      { success: true },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// DELETE /api/marketplace/:id/references/:targetId
export async function handleRemoveReference(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id: sourceId, targetId } = (request as IdTargetRequest).params;

    const source = getMarketplaceItemById(sourceId);
    if (!source) throw new NotFoundError("Source item not found");
    if (source.publisher_id !== userId && source.publisher_id !== "system") {
      throw new ValidationError("Only the publisher can remove references");
    }

    const removed = removeReference(sourceId, targetId);
    if (!removed) throw new NotFoundError("Reference not found");

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// GET /api/marketplace/suggest-references?q=...
export async function handleSuggestReferences(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);

    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";

    if (!q) {
      return Response.json({ items: [] }, { headers: corsHeaders });
    }

    const rows = getMarketplaceItems({ search: q, limit: 10 });
    return Response.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          description: r.description,
        })),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

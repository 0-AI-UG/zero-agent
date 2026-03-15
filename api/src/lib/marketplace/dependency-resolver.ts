import { getMarketplaceItemById } from "@/db/queries/marketplace.ts";
import { getMandatoryTargetIds } from "@/db/queries/marketplace-references.ts";
import { getSkillsByProject } from "@/db/queries/skills.ts";
import { getTasksByProject } from "@/db/queries/scheduled-tasks.ts";
import type { MarketplaceItemRow } from "@/db/types.ts";

export interface DependencyChain {
  /** Items that need to be installed, in topological order (dependencies first). */
  toInstall: MarketplaceItemRow[];
  /** Names of items already installed in the project. */
  alreadyInstalled: string[];
}

/**
 * Resolves the full dependency chain for a marketplace item using DFS
 * in topological order. Only follows mandatory references.
 */
export function resolveDependencyChain(
  rootId: string,
  projectId: string,
): DependencyChain {
  const installedSkills = getSkillsByProject(projectId);
  const installedTasks = getTasksByProject(projectId);
  const installedSkillNames = new Set(installedSkills.map((s) => s.name));
  const installedTaskNames = new Set(installedTasks.map((t) => t.name));

  const toInstall: MarketplaceItemRow[] = [];
  const alreadyInstalled: string[] = [];
  const visited = new Set<string>();

  function visit(itemId: string) {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    // Visit dependencies first (topological)
    const deps = getMandatoryTargetIds(itemId);
    for (const depId of deps) {
      visit(depId);
    }

    const item = getMarketplaceItemById(itemId);
    if (!item) return;

    const isInstalled =
      (item.type === "skill" && installedSkillNames.has(item.name)) ||
      (item.type === "template" && installedTaskNames.has(item.name));

    if (isInstalled) {
      alreadyInstalled.push(item.name);
    } else {
      toInstall.push(item);
    }
  }

  visit(rootId);

  return { toInstall, alreadyInstalled };
}

import { getMandatoryTargetIds } from "@/db/queries/marketplace-references.ts";

/**
 * Checks if adding an edge (sourceId → targetId) would create a cycle
 * in the mandatory dependency graph. Uses DFS from targetId — if we can
 * reach sourceId by following outgoing mandatory edges, the new edge
 * would create a cycle.
 *
 * Only mandatory references participate; recommendations are advisory.
 */
export function wouldCreateCycle(sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;

  const visited = new Set<string>();
  const stack = [targetId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const children = getMandatoryTargetIds(current);
    for (const child of children) {
      if (!visited.has(child)) {
        stack.push(child);
      }
    }
  }

  return false;
}

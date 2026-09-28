/**
 * subagentTree — spawn-tree math for the sub-agent timeline cards.
 *
 * A fan-out is a tree, but the timeline is a flat arrival-ordered list. These
 * pure helpers recover the structure from each card's `parentAgentId` so a
 * collapsed row can say how much work hangs beneath it ("+4") and an expanded
 * one can show where it sits ("main › backend › api-builder").
 *
 * Depth alone is not enough: two sibling subtrees both report depth 2 for their
 * children, so counting by depth attributes a grandchild to the wrong parent.
 * The parent link is what makes this correct.
 *
 * Kept out of the component (no React) so the traversal is testable and so a
 * cycle — which a malformed event stream could produce — provably terminates.
 */

export interface SubagentNode {
  agentId: string;
  role: string;
  parentAgentId?: string;
}

/** Label for the root of the tree — the main agent, which has no card. */
export const ROOT_LABEL = "main";

/**
 * How many agents sit anywhere beneath `agentId` (children, grandchildren, …).
 *
 * Walks downward from the target rather than upward from every node, so cost is
 * proportional to the subtree, not the square of the timeline.
 */
export function descendantCount(agentId: string, nodes: SubagentNode[]): number {
  if (!agentId) return 0;

  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    const parent = n.parentAgentId;
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(n.agentId);
    else childrenOf.set(parent, [n.agentId]);
  }

  let count = 0;
  const queue = [...(childrenOf.get(agentId) ?? [])];
  // A malformed stream could make a node its own ancestor; `seen` guarantees
  // this terminates instead of hanging the render.
  const seen = new Set<string>([agentId]);

  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    count++;
    const kids = childrenOf.get(id);
    if (kids) queue.push(...kids);
  }

  return count;
}

/**
 * Role labels from the main agent down to `agentId`, inclusive.
 *
 * Returns e.g. ["main", "backend", "api-builder"]. A card whose parent hasn't
 * arrived yet (events can interleave) still gets a path — it just starts at the
 * highest ancestor actually present, so the UI degrades to a shorter path
 * rather than rendering nothing.
 */
export function lineagePath(agentId: string, nodes: SubagentNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.agentId, n]));
  const path: string[] = [];
  const seen = new Set<string>();

  let cursor: string | undefined = agentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    path.unshift(node.role || cursor);
    cursor = node.parentAgentId;
  }

  return [ROOT_LABEL, ...path];
}

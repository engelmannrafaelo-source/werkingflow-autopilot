// =============================================================================
// load_graph_from_yaml() — YAML string → Graph
// =============================================================================
// Parses MASTER.yaml format into our Graph data structure.
// Nodes are assigned to subfigs based on their `figs` field.

import type { Graph, Subfig, ArchNode, ArchEdge, GraphYaml, SubfigYaml, ClassDef, QuickFilter } from './types';

/**
 * Parse a YAML object (already parsed from YAML string) into a Graph.
 * The server sends the parsed JSON — no need for js-yaml on the client.
 */
export function loadGraphFromYaml(data: GraphYaml): Graph {
  const classDefs: ClassDef[] = data.class_defs || [];
  const quickFilters: QuickFilter[] = data.quick_filters || [];
  const nodes: ArchNode[] = data.nodes || [];
  const edges: ArchEdge[] = data.edges || [];

  // Build subfig tree from YAML structure
  function buildSubfig(yamlSubfig: SubfigYaml): Subfig {
    const subfig: Subfig = {
      annotation: yamlSubfig.annotation,
      nodes: [],
      edges: [],
      subfigs: (yamlSubfig.subfigs || []).map(buildSubfig),
    };
    return subfig;
  }

  const subfigs: Subfig[] = (data.subfigs || []).map(buildSubfig);

  // Assign nodes to subfigs based on their `figs` field
  // figs can be "Industriegebiet/Produktionshallen" → nested path
  function assignNodeToSubfig(node: ArchNode, subfigList: Subfig[]): boolean {
    const figs = node.figs || '';
    for (const subfig of subfigList) {
      // Exact match
      if (figs === subfig.annotation) {
        subfig.nodes.push(node);
        return true;
      }
      // Path match: "Industriegebiet/Produktionshallen" matches subfig "Produktionshallen" inside "Industriegebiet"
      if (figs.startsWith(subfig.annotation + '/') || figs.startsWith(subfig.annotation)) {
        // Try to assign to a child subfig
        const remainingPath = figs.slice(subfig.annotation.length + 1);
        if (remainingPath && assignNodeToPath(node, subfig.subfigs, remainingPath)) {
          return true;
        }
        // If no child match, assign to this subfig
        if (figs === subfig.annotation) {
          subfig.nodes.push(node);
          return true;
        }
      }
      // Try children
      if (assignNodeToSubfig(node, subfig.subfigs)) return true;
    }
    return false;
  }

  function assignNodeToPath(node: ArchNode, subfigList: Subfig[], remainingPath: string): boolean {
    for (const subfig of subfigList) {
      if (remainingPath === subfig.annotation) {
        subfig.nodes.push(node);
        return true;
      }
      if (remainingPath.startsWith(subfig.annotation + '/')) {
        const nextPath = remainingPath.slice(subfig.annotation.length + 1);
        if (assignNodeToPath(node, subfig.subfigs, nextPath)) return true;
      }
    }
    return false;
  }

  // Assign each node
  for (const node of nodes) {
    if (!assignNodeToSubfig(node, subfigs)) {
      // Node doesn't match any subfig — add to first top-level subfig as fallback
      if (subfigs.length > 0) {
        subfigs[0].nodes.push(node);
      }
    }
  }

  // Assign edges to subfigs based on source node location
  // Edges live in the subfig of their source node
  function findSubfigForNode(nodeId: string, subfigList: Subfig[]): Subfig | null {
    for (const subfig of subfigList) {
      if (subfig.nodes.some(n => n.id === nodeId)) return subfig;
      const child = findSubfigForNode(nodeId, subfig.subfigs);
      if (child) return child;
    }
    return null;
  }

  for (const edge of edges) {
    const sourceSubfig = findSubfigForNode(edge.source, subfigs);
    if (sourceSubfig) {
      sourceSubfig.edges.push(edge);
    } else if (subfigs.length > 0) {
      // Fallback: add to first subfig
      subfigs[0].edges.push(edge);
    }
  }

  // Validation
  const nodeIds = new Set(nodes.map(n => n.id));
  const duplicates = nodes.length - nodeIds.size;
  if (duplicates > 0) {
    console.warn(`[yaml-import] ${duplicates} duplicate node IDs detected`);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      console.warn(`[yaml-import] Edge source "${edge.source}" not found in nodes`);
    }
    if (!nodeIds.has(edge.target)) {
      console.warn(`[yaml-import] Edge target "${edge.target}" not found in nodes`);
    }
  }

  return {
    class_defs: classDefs,
    subfigs,
    quick_filters: quickFilters,
  };
}

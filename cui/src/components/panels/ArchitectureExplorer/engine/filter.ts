// =============================================================================
// filter_graph() — Ported from EnergyMermaidTool.py:383-514
// =============================================================================
// OR-of-ANDs filter with 1-hop neighbor expansion.
// Never mutates the original graph — returns a deep copy.

import type { Graph, Subfig, ArchNode, ArchEdge, FilterResult } from './types';

/** Parse "class_name=app AND figs=produktion OR id=infisical" → OR-of-ANDs */
function parseFilterString(filterStr: string): Record<string, string>[][] {
  const orParts = filterStr.split(/\s+OR\s+/i);
  return orParts.map(orPart => {
    const andParts = orPart.split(/\s+AND\s+/i);
    return andParts.map(andPart => {
      const eqIdx = andPart.indexOf('=');
      if (eqIdx < 1) throw new Error(`Invalid filter condition: "${andPart}"`);
      const key = andPart.slice(0, eqIdx).trim();
      const value = andPart.slice(eqIdx + 1).trim();
      return { [key]: value };
    });
  });
}

/** Check if a node matches a single {key: value} criterion (substring match for strings) */
function matchesSingleCriteria(node: ArchNode, criteria: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(criteria)) {
    const nodeValue = (node as unknown as Record<string, unknown>)[key];
    if (nodeValue === undefined || nodeValue === null) return false;
    if (typeof nodeValue === 'string' && nodeValue.includes(value)) return true;
    if (nodeValue === value) return true;
  }
  return false;
}

/** Check if a node matches the OR-of-ANDs criteria list */
function matchesCriteria(node: ArchNode, criteriaList: Record<string, string>[][]): boolean {
  for (const andCriteria of criteriaList) {
    if (andCriteria.every(single => matchesSingleCriteria(node, single))) return true;
  }
  return false;
}

/** Deep clone a graph */
function deepCloneGraph(graph: Graph): Graph {
  return JSON.parse(JSON.stringify(graph));
}

/** Recursively collect matching node IDs from subfigs */
function collectMatchingNodeIds(
  subfigs: Subfig[],
  criteriaList: Record<string, string>[][],
  ids: string[]
): void {
  for (const subfig of subfigs) {
    for (const node of subfig.nodes) {
      if (matchesCriteria(node, criteriaList)) {
        ids.push(node.id);
      }
    }
    collectMatchingNodeIds(subfig.subfigs, criteriaList, ids);
  }
}

/** Recursively find edges connected to filtered nodes + discover neighbor nodes */
function findConnectedEdgesAndNodes(
  subfigs: Subfig[],
  filteredNodeIds: Set<string>,
  connectedEdges: ArchEdge[],
  connectedNodes: Set<string>
): void {
  for (const subfig of subfigs) {
    for (const edge of subfig.edges) {
      if (filteredNodeIds.has(edge.source) || filteredNodeIds.has(edge.target)) {
        connectedEdges.push(edge);
        connectedNodes.add(edge.source);
        connectedNodes.add(edge.target);
      }
    }
    findConnectedEdgesAndNodes(subfig.subfigs, filteredNodeIds, connectedEdges, connectedNodes);
  }
}

/** Update subfig: keep only connected nodes/edges, prune empty children */
function updateSubfig(subfig: Subfig, connectedNodes: Set<string>): void {
  subfig.nodes = subfig.nodes.filter(n => connectedNodes.has(n.id));
  subfig.edges = subfig.edges.filter(e => connectedNodes.has(e.source) && connectedNodes.has(e.target));
  subfig.subfigs = subfig.subfigs.filter(child => {
    updateSubfig(child, connectedNodes);
    return child.nodes.length > 0 || child.subfigs.length > 0;
  });
}

/** Remove empty subfigs recursively (bottom-up) */
function clearEmptySubfigs(subfig: Subfig): boolean {
  const childrenToKeep: Subfig[] = [];
  for (const child of subfig.subfigs) {
    if (!clearEmptySubfigs(child)) {
      childrenToKeep.push(child);
    }
  }
  subfig.subfigs = childrenToKeep;
  return subfig.nodes.length === 0 && subfig.subfigs.length === 0;
}

/**
 * Filter a graph by a filter string.
 * Returns a NEW graph (deep copy) containing only matching nodes + 1-hop neighbors.
 *
 * Filter syntax: "key=value AND key2=value2 OR key3=value3"
 * - OR splits into groups, AND within groups
 * - Values are substring-matched for strings
 */
export function filterGraph(graph: Graph, filterStr: string): FilterResult {
  if (!filterStr.trim()) {
    return { graph: deepCloneGraph(graph), matchedNodeIds: new Set() };
  }

  const criteriaList = parseFilterString(filterStr);
  const clone = deepCloneGraph(graph);

  // Phase 1: Collect directly matching node IDs
  const matchedIds: string[] = [];
  collectMatchingNodeIds(clone.subfigs, criteriaList, matchedIds);
  const matchedNodeIds = new Set(matchedIds);

  // Phase 2: Expand to connected edges + neighbor nodes (1-hop)
  const connectedEdges: ArchEdge[] = [];
  const connectedNodes = new Set(matchedIds);
  findConnectedEdgesAndNodes(clone.subfigs, matchedNodeIds, connectedEdges, connectedNodes);

  // Phase 3: Prune graph to only connected nodes/edges
  for (const subfig of clone.subfigs) {
    updateSubfig(subfig, connectedNodes);
  }

  // Phase 4: Remove empty subfigs
  clone.subfigs = clone.subfigs.filter(subfig => {
    return !clearEmptySubfigs(subfig);
  });

  return { graph: clone, matchedNodeIds };
}

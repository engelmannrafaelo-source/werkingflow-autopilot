// =============================================================================
// merge_graph() — Ported from EnergyMermaidTool.py:933-1114
// =============================================================================
// 3-Way Merge: oldslave (before edit) vs slave (after edit) vs master (current)
// - New nodes/edges in slave → ADD to master
// - Changed nodes/edges in slave → UPDATE in master
// - Deleted nodes/edges from slave → DELETE from master

import type { Graph, Subfig, ArchNode, ArchEdge, MergeChanges, MergeResult } from './types';

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** Recursively find a node by ID in a subfig tree */
function findNode(subfig: Subfig, id: string): ArchNode | null {
  for (const node of subfig.nodes) {
    if (node.id === id) return node;
  }
  for (const child of subfig.subfigs) {
    const result = findNode(child, id);
    if (result) return result;
  }
  return null;
}

/** Recursively find a node in all subfigs of a graph */
function findNodeInGraph(graph: Graph, id: string): ArchNode | null {
  for (const subfig of graph.subfigs) {
    const result = findNode(subfig, id);
    if (result) return result;
  }
  return null;
}

/** Recursively find an edge by source+target in a subfig tree */
function findEdge(subfig: Subfig, source: string, target: string): ArchEdge | null {
  for (const edge of subfig.edges) {
    if (edge.source === source && edge.target === target) return edge;
  }
  for (const child of subfig.subfigs) {
    const result = findEdge(child, source, target);
    if (result) return result;
  }
  return null;
}

function findEdgeInGraph(graph: Graph, source: string, target: string): ArchEdge | null {
  for (const subfig of graph.subfigs) {
    const result = findEdge(subfig, source, target);
    if (result) return result;
  }
  return null;
}

/** Recursively remove a node by ID from a subfig tree */
function removeNodeFromSubfig(subfig: Subfig, id: string): boolean {
  const idx = subfig.nodes.findIndex(n => n.id === id);
  if (idx >= 0) {
    subfig.nodes.splice(idx, 1);
    return true;
  }
  for (const child of subfig.subfigs) {
    if (removeNodeFromSubfig(child, id)) return true;
  }
  return false;
}

/** Recursively remove an edge from a subfig tree */
function removeEdgeFromSubfig(subfig: Subfig, source: string, target: string): boolean {
  const idx = subfig.edges.findIndex(e => e.source === source && e.target === target);
  if (idx >= 0) {
    subfig.edges.splice(idx, 1);
    return true;
  }
  for (const child of subfig.subfigs) {
    if (removeEdgeFromSubfig(child, source, target)) return true;
  }
  return false;
}

/** Collect all node IDs from a graph */
function collectAllNodeIds(graph: Graph): Set<string> {
  const ids = new Set<string>();
  function walk(subfigs: Subfig[]) {
    for (const s of subfigs) {
      for (const n of s.nodes) ids.add(n.id);
      walk(s.subfigs);
    }
  }
  walk(graph.subfigs);
  return ids;
}

/** Collect all edges from a graph as "source->target" keys */
function collectAllEdgeKeys(graph: Graph): Set<string> {
  const keys = new Set<string>();
  function walk(subfigs: Subfig[]) {
    for (const s of subfigs) {
      for (const e of s.edges) keys.add(`${e.source}->${e.target}`);
      walk(s.subfigs);
    }
  }
  walk(graph.subfigs);
  return keys;
}

/** Recursively merge slave changes into master, comparing against oldslave */
function recursiveMerge(
  masterSubfig: Subfig,
  slaveSubfig: Subfig,
  oldslaveSubfig: Subfig,
  masterGraph: Graph,
  changes: MergeChanges
): void {
  // Handle nodes
  for (const sNode of slaveSubfig.nodes) {
    const osNode = findNode(oldslaveSubfig, sNode.id);
    const mNode = findNodeInGraph(masterGraph, sNode.id);

    if (!osNode && !mNode) {
      // New node — add to master
      masterSubfig.nodes.push(deepClone(sNode));
      changes.added_nodes.push(sNode.id);
    } else if (osNode && mNode) {
      // Existing node — check for changes
      if (osNode.label !== sNode.label) {
        mNode.label = sNode.label;
        changes.modified_nodes.push(sNode.id);
      }
      if (osNode.class_name !== sNode.class_name) {
        mNode.class_name = sNode.class_name;
        if (!changes.modified_nodes.includes(sNode.id)) {
          changes.modified_nodes.push(sNode.id);
        }
      }
    }
  }

  // Handle deleted nodes
  for (const osNode of oldslaveSubfig.nodes) {
    if (!findNode(slaveSubfig, osNode.id)) {
      // Deleted in slave — remove from master
      for (const ms of masterGraph.subfigs) {
        if (removeNodeFromSubfig(ms, osNode.id)) break;
      }
      changes.deleted_nodes.push(osNode.id);
    }
  }

  // Handle new edges
  for (const sEdge of slaveSubfig.edges) {
    if (!findEdge(oldslaveSubfig, sEdge.source, sEdge.target)) {
      masterSubfig.edges.push(deepClone(sEdge));
      changes.added_edges.push([sEdge.source, sEdge.target]);
    }
  }

  // Handle modified edges
  for (const sEdge of slaveSubfig.edges) {
    const osEdge = findEdge(oldslaveSubfig, sEdge.source, sEdge.target);
    if (osEdge) {
      const mEdge = findEdgeInGraph(masterGraph, sEdge.source, sEdge.target);
      if (mEdge) {
        let modified = false;
        if (osEdge.label !== sEdge.label) { mEdge.label = sEdge.label; modified = true; }
        if (osEdge.style !== sEdge.style) { mEdge.style = sEdge.style; modified = true; }
        if (modified) changes.modified_edges.push([sEdge.source, sEdge.target]);
      }
    }
  }

  // Handle deleted edges
  for (const osEdge of oldslaveSubfig.edges) {
    if (!findEdge(slaveSubfig, osEdge.source, osEdge.target)) {
      for (const ms of masterGraph.subfigs) {
        if (removeEdgeFromSubfig(ms, osEdge.source, osEdge.target)) break;
      }
      changes.deleted_edges.push([osEdge.source, osEdge.target]);
    }
  }

  // Recurse into child subfigs
  for (const sChild of slaveSubfig.subfigs) {
    const osChild = oldslaveSubfig.subfigs.find(s => s.annotation === sChild.annotation);
    let mChild = masterSubfig.subfigs.find(s => s.annotation === sChild.annotation);
    if (!mChild) {
      mChild = { annotation: sChild.annotation, nodes: [], edges: [], subfigs: [] };
      masterSubfig.subfigs.push(mChild);
    }
    const emptySubfig: Subfig = { annotation: '', nodes: [], edges: [], subfigs: [] };
    recursiveMerge(mChild, sChild, osChild || emptySubfig, masterGraph, changes);
  }
}

/** Remove duplicate edges in a subfig tree */
function removeDuplicateEdges(subfig: Subfig): void {
  const seen = new Set<string>();
  subfig.edges = subfig.edges.filter(e => {
    const key = `${e.source}->${e.target}:${e.label || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const child of subfig.subfigs) {
    removeDuplicateEdges(child);
  }
}

/**
 * 3-Way merge: Compare oldslave→slave changes, apply them to master.
 *
 * @param master - Current master graph
 * @param slave - Edited branch (after changes)
 * @param oldslave - Original branch (before changes, snapshot at filter time)
 * @returns Merged graph + change summary
 */
export function mergeGraph(master: Graph, slave: Graph, oldslave: Graph): MergeResult {
  const masterCopy = deepClone(master);
  const slaveCopy = deepClone(slave);
  const oldslaveCopy = deepClone(oldslave);

  const changes: MergeChanges = {
    added_nodes: [],
    modified_nodes: [],
    deleted_nodes: [],
    added_edges: [],
    modified_edges: [],
    deleted_edges: [],
  };

  // Merge each slave subfig into master
  for (const sSubfig of slaveCopy.subfigs) {
    const osSubfig = oldslaveCopy.subfigs.find(s => s.annotation === sSubfig.annotation);
    let mSubfig = masterCopy.subfigs.find(s => s.annotation === sSubfig.annotation);
    if (!mSubfig) {
      mSubfig = { annotation: sSubfig.annotation, nodes: [], edges: [], subfigs: [] };
      masterCopy.subfigs.push(mSubfig);
    }
    const emptySubfig: Subfig = { annotation: '', nodes: [], edges: [], subfigs: [] };
    recursiveMerge(mSubfig, sSubfig, osSubfig || emptySubfig, masterCopy, changes);
  }

  // Clean up duplicate edges
  for (const subfig of masterCopy.subfigs) {
    removeDuplicateEdges(subfig);
  }

  // Generate summary
  const messages: string[] = [];
  if (changes.added_nodes.length) messages.push(`${changes.added_nodes.length} nodes added`);
  if (changes.modified_nodes.length) messages.push(`${changes.modified_nodes.length} nodes modified`);
  if (changes.deleted_nodes.length) messages.push(`${changes.deleted_nodes.length} nodes deleted`);
  if (changes.added_edges.length) messages.push(`${changes.added_edges.length} edges added`);
  if (changes.modified_edges.length) messages.push(`${changes.modified_edges.length} edges modified`);
  if (changes.deleted_edges.length) messages.push(`${changes.deleted_edges.length} edges deleted`);

  return {
    graph: masterCopy,
    summary: messages.length > 0 ? messages.join('; ') : 'No changes merged.',
    changes,
  };
}

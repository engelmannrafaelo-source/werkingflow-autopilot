// =============================================================================
// Architecture Graph — Type Definitions
// =============================================================================
// Ported from RLB Mermaid Tool (EnergyMermaidTool.py)
// Adapted for WerkIngFlow city metaphor architecture visualization.

interface NodeMetadata {
  metaphor?: string;
  description?: string;
  port?: number;
  path?: string;
  [key: string]: unknown;
}

export interface ArchNode {
  id: string;
  label: string;
  class_name?: string;
  figs?: string;
  metadata?: NodeMetadata;
}

export interface ArchEdge {
  source: string;
  target: string;
  label?: string;
  style?: EdgeStyle;
}

export type EdgeStyle = 'hauptstrasse' | 'nebenstrasse' | 'bruecke' | 'lieferroute';

export interface Subfig {
  annotation: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  subfigs: Subfig[];
}

export interface ClassDef {
  class_name: string;
  properties: {
    fill: string;
    stroke: string;
    color?: string;
  };
}

export interface QuickFilter {
  label: string;
  filter: string;
}

export interface Graph {
  class_defs: ClassDef[];
  subfigs: Subfig[];
  quick_filters?: QuickFilter[];
}

/** Raw YAML structure before node assignment to subfigs */
export interface GraphYaml {
  class_defs: ClassDef[];
  quick_filters?: QuickFilter[];
  subfigs: SubfigYaml[];
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export interface SubfigYaml {
  annotation: string;
  subfigs?: SubfigYaml[];
  nodes?: ArchNode[];
  edges?: ArchEdge[];
}

export interface FilterResult {
  graph: Graph;
  matchedNodeIds: Set<string>;
}

interface MergeChanges {
  added_nodes: string[];
  modified_nodes: string[];
  deleted_nodes: string[];
  added_edges: [string, string][];
  modified_edges: [string, string][];
  deleted_edges: [string, string][];
}

interface MergeResult {
  graph: Graph;
  summary: string;
  changes: MergeChanges;
}

// =============================================================================
// graph_to_mermaid() — Graph → Mermaid syntax string
// =============================================================================
// Generates Mermaid flowchart syntax from our Graph data structure.
// Uses Mermaid v11 theme configuration for dark mode styling.

import type { Graph, Subfig, ArchEdge, EdgeStyle } from './types';

/** Map edge style to Mermaid connector syntax */
function edgeConnector(style?: EdgeStyle): string {
  switch (style) {
    case 'hauptstrasse': return ' ==> ';
    case 'nebenstrasse': return ' --> ';
    case 'bruecke':      return ' -.-> ';
    case 'lieferroute':  return ' ====> ';
    default:             return ' --> ';
  }
}

/** Generate Mermaid edge line */
function edgeLine(edge: ArchEdge): string {
  const connector = edgeConnector(edge.style);
  if (edge.label) {
    // Insert label into connector: A -->|label| B
    const mid = connector.trim();
    return `    ${edge.source} ${mid}|${edge.label}| ${edge.target}`;
  }
  return `    ${edge.source}${connector}${edge.target}`;
}

/** Generate Mermaid node line */
function nodeLine(node: { id: string; label: string; class_name?: string }): string {
  const escaped = node.label.replace(/"/g, '#quot;');
  let line = `    ${node.id}["${escaped}"]`;
  if (node.class_name) {
    line += `:::${node.class_name}`;
  }
  return line;
}

/** Recursively render subfig as Mermaid subgraph */
function renderSubfig(subfig: Subfig, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}subgraph ${subfig.annotation}`);

  // Render nested subfigs first
  for (const child of subfig.subfigs) {
    lines.push(renderSubfig(child, indent + '    '));
  }

  // Render nodes
  for (const node of subfig.nodes) {
    lines.push(`${indent}    ${node.id}["${node.label.replace(/"/g, '#quot;')}"]${node.class_name ? ':::' + node.class_name : ''}`);
  }

  // Render edges within this subfig
  for (const edge of subfig.edges) {
    lines.push(`${indent}${edgeLine(edge)}`);
  }

  lines.push(`${indent}end`);
  return lines.join('\n');
}

/**
 * Convert a Graph to a Mermaid flowchart string.
 * Includes theme configuration for dark mode.
 */
export function graphToMermaid(graph: Graph): string {
  const lines: string[] = [];

  // Mermaid v11 theme configuration (dark mode)
  lines.push('%%{');
  lines.push('  init: {');
  lines.push("    'theme': 'dark',");
  lines.push("    'themeVariables': {");
  lines.push("      'fontSize': '14px',");
  lines.push("      'fontFamily': 'ui-monospace, monospace',");
  lines.push("      'primaryColor': '#2d2d2d',");
  lines.push("      'primaryTextColor': '#e0e0e0',");
  lines.push("      'primaryBorderColor': '#555',");
  lines.push("      'lineColor': '#888',");
  lines.push("      'secondaryColor': '#333',");
  lines.push("      'tertiaryColor': '#1e1e1e',");
  lines.push("      'clusterBkg': '#1a1a2e',");
  lines.push("      'clusterBorder': '#444'");
  lines.push('    },');
  lines.push("    'flowchart': {");
  lines.push("      'curve': 'basis'");
  lines.push('    }');
  lines.push('  }');
  lines.push('}%%');
  lines.push('');

  // Graph direction
  lines.push('graph TD');
  lines.push('');

  // Class definitions
  for (const cd of graph.class_defs) {
    const props = Object.entries(cd.properties)
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    lines.push(`    classDef ${cd.class_name} ${props}`);
  }
  lines.push('');

  // Subgraphs with nodes
  for (const subfig of graph.subfigs) {
    lines.push(renderSubfig(subfig, '    '));
    lines.push('');
  }

  // Collect all edges from all subfigs (flatten)
  const allEdges: ArchEdge[] = [];
  function collectEdges(subfigs: Subfig[]) {
    for (const s of subfigs) {
      allEdges.push(...s.edges);
      collectEdges(s.subfigs);
    }
  }
  collectEdges(graph.subfigs);

  // Render unique edges at the top level (avoid duplicates from subfig rendering)
  // The edges inside subgraphs are for data association; render all connections at root
  // Actually, edges are already rendered inside subfigs above. We skip root-level dedup.

  return lines.join('\n');
}

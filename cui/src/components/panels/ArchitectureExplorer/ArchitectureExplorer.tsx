import { useArchGraph } from './hooks/useArchGraph';
import { useArchStatus } from './hooks/useArchStatus';
import MermaidRenderer from './renderers/MermaidRenderer';
import FilterBar from './components/FilterBar';
import Breadcrumb from './components/Breadcrumb';
import type { Subfig, ArchNode } from './engine/types';
import { getPathConfig } from '../../../utils/paths';
import PanelLoader from '../shared/PanelLoader';

export default function ArchitectureExplorer() {
  const {
    graph,
    filteredGraph,
    mermaidContent,
    filterHistory,
    activeFilter,
    loading,
    error,
    applyFilter,
    navigateTo,
    undo,
    reset,
    handleNodeClick,
    canUndo,
    activeSubgraph,
    availableSubgraphs,
    drillInto,
    drillOut,
  } = useArchGraph();

  const { status, loading: statusLoading } = useArchStatus(30000);

  if (loading) {
    return <PanelLoader message="Loading architecture graph..." />;
  }

  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef9a9a', fontSize: 12, padding: 20 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Architecture Explorer Error</div>
          <div>{error}</div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--tn-text-muted)' }}>
            Check that MASTER.yaml exists and the server route is mounted.
          </div>
        </div>
      </div>
    );
  }

  if (!graph || !filteredGraph) return null;

  // Count nodes in filtered graph
  let nodeCount = 0;
  let edgeCount = 0;
  function countElements(subfigs: Subfig[]) {
    for (const s of subfigs) {
      nodeCount += s.nodes.length;
      edgeCount += s.edges.length;
      countElements(s.subfigs);
    }
  }
  countElements(filteredGraph.subfigs);

  // Collect all nodes for metadata lookup (for file preview navigation)
  function collectNodes(subfigs: Subfig[]): ArchNode[] {
    const nodes: ArchNode[] = [];
    for (const s of subfigs) {
      nodes.push(...s.nodes);
      nodes.push(...collectNodes(s.subfigs));
    }
    return nodes;
  }
  const allNodes = collectNodes(filteredGraph.subfigs);

  // Handle node click: drill into sub-graph if available, open file preview if metadata.path, else filter
  const onNodeClick = (nodeId: string) => {
    // Check if this node has a sub-graph available
    if (!activeSubgraph && availableSubgraphs.includes(nodeId)) {
      drillInto(nodeId);
      return;
    }

    // Check if node has metadata.path for file preview navigation
    const node = allNodes.find(n => n.id === nodeId);
    if (node?.metadata?.path) {
      // Resolve the path relative to the app root
      let fullPath = node.metadata.path;
      if (activeSubgraph === 'engelmann') {
        fullPath = `${getPathConfig().werkingflowProductionDir}/apps/engelmann/${node.metadata.path}`;
      }
      // Send file-preview control message to CUI
      try {
        fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'file-preview',
            payload: { path: fullPath },
          }),
        }).catch(() => { /* best effort */ });
      } catch { /* best effort */ }
    }

    // Always also apply the filter for drill-down
    handleNodeClick(nodeId);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
      {/* Sub-graph indicator */}
      {activeSubgraph && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          fontSize: 10,
          background: 'var(--tn-bg-accent, #2a2a3a)',
          borderBottom: '1px solid var(--tn-border)',
          color: 'var(--tn-blue, #4fc3f7)',
        }}>
          <span
            onClick={drillOut}
            style={{ cursor: 'pointer', opacity: 0.8 }}
            title="Back to Master Graph"
          >
            ← Master
          </span>
          <span style={{ color: 'var(--tn-text-muted)', opacity: 0.5 }}>|</span>
          <span style={{ fontWeight: 600 }}>{activeSubgraph}</span>
          <span style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>Sub-Graph</span>
        </div>
      )}

      {/* Filter Bar */}
      <FilterBar
        quickFilters={graph.quick_filters || []}
        activeFilter={activeFilter}
        onApplyFilter={applyFilter}
        onReset={activeSubgraph ? drillOut : reset}
        onUndo={undo}
        canUndo={canUndo}
      />

      {/* Breadcrumb */}
      <Breadcrumb
        filterHistory={filterHistory}
        onNavigate={navigateTo}
      />

      {/* Status bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '3px 10px',
        fontSize: 9,
        color: 'var(--tn-text-muted)',
        borderBottom: '1px solid var(--tn-border)',
        opacity: 0.7,
      }}>
        <span>{nodeCount} Nodes, {edgeCount} Edges</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {status && (
            <span>
              <span style={{ color: status.healthy === status.total ? '#81c784' : '#ffb74d' }}>
                {status.healthy}/{status.total}
              </span>
              {' '}online
            </span>
          )}
          {statusLoading && <span style={{ opacity: 0.5 }}>...</span>}
          <span>{filteredGraph.subfigs.length} Viertel</span>
        </span>
      </div>

      {/* Mermaid Diagram */}
      <MermaidRenderer
        mermaidContent={mermaidContent}
        onNodeClick={onNodeClick}
        portStatus={status?.ports}
      />
    </div>
  );
}

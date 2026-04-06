import { useState, useEffect, useCallback, useRef } from 'react';
import type { Graph } from '../engine/types';
import { loadGraphFromYaml } from '../engine/yaml-import';
import { filterGraph } from '../engine/filter';
import { graphToMermaid } from '../engine/mermaid-export';

interface UseArchGraphResult {
  /** Full unfiltered graph */
  graph: Graph | null;
  /** Currently displayed (filtered) graph */
  filteredGraph: Graph | null;
  /** Mermaid string for current filtered graph */
  mermaidContent: string;
  /** Current filter history */
  filterHistory: string[];
  /** Currently active filter string */
  activeFilter: string;
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Apply a filter string */
  applyFilter: (filter: string) => void;
  /** Navigate to a specific point in filter history (-1 = reset) */
  navigateTo: (index: number) => void;
  /** Undo last filter */
  undo: () => void;
  /** Reset to full graph */
  reset: () => void;
  /** Handle node click — applies id= filter */
  handleNodeClick: (nodeId: string) => void;
  /** Can undo? */
  canUndo: boolean;
  /** Currently viewing a sub-graph (null = master) */
  activeSubgraph: string | null;
  /** Available sub-graphs (app IDs that have .yaml files) */
  availableSubgraphs: string[];
  /** Drill into an app's internal architecture sub-graph */
  drillInto: (appId: string) => void;
  /** Return to master graph */
  drillOut: () => void;
}

export function useArchGraph(): UseArchGraphResult {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [filteredGraph, setFilteredGraph] = useState<Graph | null>(null);
  const [mermaidContent, setMermaidContent] = useState('');
  const [filterHistory, setFilterHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSubgraph, setActiveSubgraph] = useState<string | null>(null);
  const [availableSubgraphs, setAvailableSubgraphs] = useState<string[]>([]);

  const graphRef = useRef<Graph | null>(null);
  const masterGraphRef = useRef<Graph | null>(null);
  const masterFilterHistory = useRef<string[]>([]);

  // Fetch master graph on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch('/api/architecture/graph').then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      fetch('/api/architecture/subgraphs').then(res => res.ok ? res.json() : { subgraphs: [] }),
    ])
      .then(([graphData, subData]) => {
        if (cancelled) return;
        const g = loadGraphFromYaml(graphData);
        graphRef.current = g;
        masterGraphRef.current = g;
        setGraph(g);
        setFilteredGraph(g);
        setMermaidContent(graphToMermaid(g));
        setAvailableSubgraphs(subData.subgraphs || []);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[useArchGraph] fetch error:', err);
        setError(err.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  /** Apply all filters in history sequentially to get the final filtered graph */
  const applyFiltersFromHistory = useCallback((history: string[]) => {
    const g = graphRef.current;
    if (!g) return;

    if (history.length === 0) {
      setFilteredGraph(g);
      setMermaidContent(graphToMermaid(g));
      return;
    }

    // Apply filters sequentially
    let current = g;
    for (const filter of history) {
      const result = filterGraph(current, filter);
      current = result.graph;
    }

    setFilteredGraph(current);
    setMermaidContent(graphToMermaid(current));
  }, []);

  const applyFilter = useCallback((filter: string) => {
    if (!filter.trim()) return;
    const newHistory = [...filterHistory, filter];
    setFilterHistory(newHistory);
    applyFiltersFromHistory(newHistory);
  }, [filterHistory, applyFiltersFromHistory]);

  const navigateTo = useCallback((index: number) => {
    if (index < 0) {
      // Reset
      setFilterHistory([]);
      applyFiltersFromHistory([]);
      return;
    }
    const newHistory = filterHistory.slice(0, index + 1);
    setFilterHistory(newHistory);
    applyFiltersFromHistory(newHistory);
  }, [filterHistory, applyFiltersFromHistory]);

  const undo = useCallback(() => {
    if (filterHistory.length === 0) return;
    const newHistory = filterHistory.slice(0, -1);
    setFilterHistory(newHistory);
    applyFiltersFromHistory(newHistory);
  }, [filterHistory, applyFiltersFromHistory]);

  const reset = useCallback(() => {
    setFilterHistory([]);
    applyFiltersFromHistory([]);
  }, [applyFiltersFromHistory]);

  const handleNodeClick = useCallback((nodeId: string) => {
    applyFilter(`id=${nodeId}`);
  }, [applyFilter]);

  /** Drill into a sub-graph */
  const drillInto = useCallback(async (appId: string) => {
    setLoading(true);
    // Save master graph state
    masterFilterHistory.current = filterHistory;

    try {
      const res = await fetch(`/api/architecture/subgraph/${appId}`);
      if (!res.ok) throw new Error(`No sub-graph for ${appId}`);
      const data = await res.json();
      const subGraph = loadGraphFromYaml(data);
      graphRef.current = subGraph;
      setGraph(subGraph);
      setFilteredGraph(subGraph);
      setMermaidContent(graphToMermaid(subGraph));
      setFilterHistory([]);
      setActiveSubgraph(appId);
      setLoading(false);
    } catch (err) {
      console.warn(`[useArchGraph] sub-graph load failed for ${appId}:`, err);
      // Fall back to id= filter on master graph
      setLoading(false);
      applyFilter(`id=${appId}`);
    }
  }, [filterHistory, applyFilter]);

  /** Drill out to master graph */
  const drillOut = useCallback(() => {
    const master = masterGraphRef.current;
    if (!master) return;

    graphRef.current = master;
    setGraph(master);
    setActiveSubgraph(null);

    // Restore master filter history
    const history = masterFilterHistory.current;
    setFilterHistory(history);
    applyFiltersFromHistory(history);
  }, [applyFiltersFromHistory]);

  return {
    graph,
    filteredGraph,
    mermaidContent,
    filterHistory,
    activeFilter: filterHistory[filterHistory.length - 1] || '',
    loading,
    error,
    applyFilter,
    navigateTo,
    undo,
    reset,
    handleNodeClick,
    canUndo: filterHistory.length > 0,
    activeSubgraph,
    availableSubgraphs,
    drillInto,
    drillOut,
  };
}

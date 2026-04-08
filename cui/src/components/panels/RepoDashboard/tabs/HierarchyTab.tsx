import React, { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

interface HierarchyNode {
  id: string;
  name: string;
  level: number;
  isGit: boolean;
  diskSize: { bytes: number; human: string };
  lastModified: string;
  ageColor: string;
}

interface HierarchyLink {
  source: string;
  target: string;
  value: number;
}

interface HierarchyData {
  sankey: {
    nodes: HierarchyNode[];
    links: HierarchyLink[];
  };
  totalSize: { bytes: number; human: string };
  nodeCount: number;
  scannedAt: string;
}

/**
 * HierarchyTab - Sankey-style visualization of /root/projekte folder structure
 * Shows hierarchical flow from left (root) to right (subdirectories)
 * with color-coded age indicators and interactive drill-down
 */
export default function HierarchyTab() {
  const [data, setData] = useState<HierarchyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/repo-dashboard/hierarchy', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.warn('[RepoHierarchy] fetch failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch hierarchy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" data-ai-id="hierarchy-loading">
        <Loader2 className="animate-spin text-blue-400" size={32} />
        <span className="ml-3 text-gray-400">Scanning folder hierarchy...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full" data-ai-id="hierarchy-error">
        <div className="text-red-400 text-center">
          <p className="font-semibold">Error loading hierarchy</p>
          <p className="text-sm text-gray-500 mt-2">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full" data-ai-id="hierarchy-empty">
        <span className="text-gray-500">No data available</span>
      </div>
    );
  }

  // Group nodes by level
  const nodesByLevel = new Map<number, HierarchyNode[]>();
  data.sankey.nodes.forEach(node => {
    if (!nodesByLevel.has(node.level)) {
      nodesByLevel.set(node.level, []);
    }
    nodesByLevel.get(node.level)!.push(node);
  });

  const maxLevel = Math.max(...data.sankey.nodes.map(n => n.level));

  // Get human-readable age
  const getAge = (lastModified: string): string => {
    const now = Date.now();
    const modified = new Date(lastModified).getTime();
    const ageMs = now - modified;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    if (ageDays < 1) return 'today';
    if (ageDays === 1) return 'yesterday';
    if (ageDays < 7) return `${ageDays}d ago`;
    if (ageDays < 30) return `${Math.floor(ageDays / 7)}w ago`;
    if (ageDays < 365) return `${Math.floor(ageDays / 30)}mo ago`;
    return `${Math.floor(ageDays / 365)}y ago`;
  };

  // Get links for a node
  const getNodeLinks = (nodeId: string) => {
    return {
      incoming: data.sankey.links.filter(l => l.target === nodeId),
      outgoing: data.sankey.links.filter(l => l.source === nodeId),
    };
  };

  return (
    <div className="p-6 h-full overflow-auto" data-ai-id="hierarchy-tab">
      {/* Header */}
      <div className="mb-6" data-ai-id="hierarchy-header">
        <h3 className="text-xl font-semibold text-gray-200">
          Folder Hierarchy - Sankey View
        </h3>
        <p className="text-sm text-gray-400 mt-1">
          {data.nodeCount} folders • {data.totalSize.human} total • Scanned {new Date(data.scannedAt).toLocaleTimeString()}
        </p>
      </div>

      {/* Color Legend */}
      <div className="mb-6 flex items-center gap-4 text-xs" data-ai-id="hierarchy-legend">
        <span className="text-gray-400">Age:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: '#9ece6a' }}></div>
          <span className="text-gray-300">&lt; 1 week</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: '#e0af68' }}></div>
          <span className="text-gray-300">&lt; 1 month</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: '#ff9e64' }}></div>
          <span className="text-gray-300">&lt; 3 months</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: '#f7768e' }}></div>
          <span className="text-gray-300">&lt; 6 months</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: '#565f89' }}></div>
          <span className="text-gray-300">&gt; 6 months</span>
        </div>
      </div>

      {/* Sankey Diagram - Column-based layout */}
      <div
        className="relative overflow-x-auto pb-8"
        data-ai-id="hierarchy-diagram"
        style={{ minHeight: '600px' }}
      >
        <div className="flex gap-12 items-start" style={{ minWidth: `${(maxLevel + 1) * 320}px` }}>
          {/* Render each level as a column */}
          {Array.from({ length: maxLevel + 1 }, (_, level) => {
            const nodesAtLevel = nodesByLevel.get(level) || [];

            return (
              <div
                key={level}
                className="flex flex-col gap-4"
                style={{ minWidth: '280px' }}
                data-ai-id={`hierarchy-level-${level}`}
              >
                {/* Level Header */}
                <div className="text-sm font-semibold text-gray-400 mb-2">
                  {level === 0 ? 'Root' : `Level ${level}`}
                </div>

                {/* Nodes at this level */}
                {nodesAtLevel.map(node => {
                  const links = getNodeLinks(node.id);
                  const isSelected = selectedNode === node.id;

                  return (
                    <div
                      key={node.id}
                      data-ai-id={`hierarchy-node-${node.id.replace(/\//g, '-')}`}
                      className={`
                        relative p-4 rounded-lg border-2 cursor-pointer transition-all
                        ${isSelected ? 'border-blue-500 shadow-lg shadow-blue-500/20' : 'border-transparent'}
                        hover:border-blue-400 hover:shadow-md
                      `}
                      style={{
                        backgroundColor: node.ageColor + '22', // 22 = ~13% opacity
                        borderColor: isSelected ? '#3b82f6' : node.ageColor + '44',
                      }}
                      onClick={() => setSelectedNode(isSelected ? null : node.id)}
                    >
                      {/* Node Header */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-gray-200 truncate flex items-center gap-2">
                            {node.isGit && <span className="text-xs">📦</span>}
                            {node.name}
                          </div>
                          <div className="text-xs text-gray-400 truncate mt-1">
                            {node.id || '/root/projekte'}
                          </div>
                        </div>
                      </div>

                      {/* Node Stats */}
                      <div className="flex items-center justify-between text-xs mt-3">
                        <span
                          className={`font-semibold ${
                            node.diskSize.bytes > 1e9 ? 'text-red-400' : 'text-gray-300'
                          }`}
                        >
                          {node.diskSize.human}
                        </span>
                        <span className="text-gray-400">{getAge(node.lastModified)}</span>
                      </div>

                      {/* Link Indicators */}
                      <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                        {links.incoming.length > 0 && (
                          <span>← {links.incoming.length} parent{links.incoming.length > 1 ? 's' : ''}</span>
                        )}
                        {links.outgoing.length > 0 && (
                          <span>{links.outgoing.length} child{links.outgoing.length > 1 ? 'ren' : ''} →</span>
                        )}
                      </div>

                      {/* Git indicator */}
                      {node.isGit && (
                        <div className="absolute top-2 right-2 text-xs bg-blue-900/50 text-blue-300 px-2 py-1 rounded">
                          Git
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Node Details */}
      {selectedNode && (
        <div
          className="mt-6 p-4 bg-gray-800 rounded-lg border border-gray-700"
          data-ai-id="hierarchy-node-details"
        >
          {(() => {
            const node = data.sankey.nodes.find(n => n.id === selectedNode);
            if (!node) return null;

            const links = getNodeLinks(node.id);

            return (
              <div>
                <h4 className="font-semibold text-gray-200 mb-3 flex items-center gap-2">
                  {node.isGit && <span>📦</span>}
                  {node.name}
                  <button
                    onClick={() => setSelectedNode(null)}
                    className="ml-auto text-xs text-gray-400 hover:text-gray-300"
                  >
                    Close ✕
                  </button>
                </h4>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-400">Path:</span>
                    <div className="text-gray-300 mt-1 font-mono text-xs">{node.id || '/root/projekte'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Size:</span>
                    <div className="text-gray-300 mt-1">{node.diskSize.human} ({node.diskSize.bytes.toLocaleString()} bytes)</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Last Modified:</span>
                    <div className="text-gray-300 mt-1">{new Date(node.lastModified).toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Age:</span>
                    <div className="text-gray-300 mt-1">{getAge(node.lastModified)}</div>
                  </div>
                  {node.isGit && (
                    <div className="col-span-2">
                      <span className="text-gray-400">Type:</span>
                      <div className="text-gray-300 mt-1">Git Repository 📦</div>
                    </div>
                  )}
                </div>

                {/* Connections */}
                {(links.incoming.length > 0 || links.outgoing.length > 0) && (
                  <div className="mt-4 pt-4 border-t border-gray-700">
                    {links.incoming.length > 0 && (
                      <div className="mb-3">
                        <span className="text-sm text-gray-400">Parent Folders:</span>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {links.incoming.map(link => {
                            const parent = data.sankey.nodes.find(n => n.id === link.source);
                            return parent ? (
                              <button
                                key={link.source}
                                onClick={() => setSelectedNode(link.source)}
                                className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded"
                              >
                                ← {parent.name}
                              </button>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}

                    {links.outgoing.length > 0 && (
                      <div>
                        <span className="text-sm text-gray-400">Child Folders:</span>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {links.outgoing.map(link => {
                            const child = data.sankey.nodes.find(n => n.id === link.target);
                            return child ? (
                              <button
                                key={link.target}
                                onClick={() => setSelectedNode(link.target)}
                                className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded"
                              >
                                {child.name} →
                              </button>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

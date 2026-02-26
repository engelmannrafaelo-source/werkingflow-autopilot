import { useState, useEffect } from 'react';

const API = '/api';

interface TeamNode {
  id: string;
  name: string;
  role: string;
  children: TeamNode[];
}

interface TeamOrgChartProps {
  onNodeClick?: (nodeId: string) => void;
  selectedNode?: string | null;
}

export default function TeamOrgChart({ onNodeClick, selectedNode }: TeamOrgChartProps) {
  const [orgChart, setOrgChart] = useState<TeamNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTeamStructure();
  }, []);

  async function loadTeamStructure() {
    try {
      const res = await fetch(`${API}/agents/team/structure`);
      if (!res.ok) throw new Error('Failed to load team structure');
      const data = await res.json();
      setOrgChart(data.orgChart || []);
    } catch (err) {
      console.error('Failed to load team structure:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 300,
        color: 'var(--tn-text-muted)',
        fontSize: 12
      }}>
        Loading org chart...
      </div>
    );
  }

  return (
    <div style={{
      padding: 20,
      overflow: 'auto'
    }}>
      <div style={{
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--tn-text)',
        marginBottom: 20
      }}>
        🏢 Team Organization
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20
      }}>
        {orgChart.map(root => (
          <TreeNode key={root.id} node={root} onNodeClick={onNodeClick} selectedNode={selectedNode} level={0} />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: TeamNode;
  onNodeClick?: (nodeId: string) => void;
  selectedNode?: string | null;
  level: number;
}

function TreeNode({ node, onNodeClick, selectedNode, level }: TreeNodeProps) {
  const hasChildren = node.children.length > 0;
  const isSelected = selectedNode === node.id;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 16
    }}>
      {/* Node Card */}
      <div
        onClick={() => onNodeClick?.(node.id)}
        style={{
          padding: '12px 16px',
          background: isSelected
            ? 'var(--tn-blue-dim)'
            : level === 0
              ? 'var(--tn-blue)'
              : 'var(--tn-surface)',
          border: `2px solid ${isSelected ? 'var(--tn-blue)' : level === 0 ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
          borderRadius: 8,
          minWidth: 180,
          textAlign: 'center',
          cursor: onNodeClick ? 'pointer' : 'default',
          transition: 'all 0.2s ease',
          boxShadow: isSelected
            ? '0 4px 12px rgba(0, 122, 255, 0.3)'
            : level === 0
              ? '0 2px 8px rgba(0, 122, 255, 0.2)'
              : 'none'
        }}
        onMouseEnter={(e) => {
          if (level > 0 && !isSelected) {
            e.currentTarget.style.background = 'var(--tn-surface-hover)';
            e.currentTarget.style.borderColor = 'var(--tn-border-hover)';
          }
        }}
        onMouseLeave={(e) => {
          if (level > 0 && !isSelected) {
            e.currentTarget.style.background = 'var(--tn-surface)';
            e.currentTarget.style.borderColor = 'var(--tn-border)';
          }
        }}
      >
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: level === 0 ? 'white' : 'var(--tn-text)',
          marginBottom: 4
        }}>
          {node.name}
        </div>
        <div style={{
          fontSize: 11,
          color: level === 0 ? 'rgba(255, 255, 255, 0.8)' : 'var(--tn-text-muted)'
        }}>
          {node.role}
        </div>
      </div>

      {/* Children */}
      {hasChildren && (
        <>
          {/* Connection Line */}
          <div style={{
            width: 2,
            height: 20,
            background: 'var(--tn-border)'
          }} />

          {/* Children Container */}
          <div style={{
            display: 'flex',
            gap: 40,
            alignItems: 'flex-start',
            position: 'relative'
          }}>
            {/* Horizontal Line */}
            {node.children.length > 1 && (
              <div style={{
                position: 'absolute',
                top: -10,
                left: '50%',
                transform: 'translateX(-50%)',
                width: `calc(100% - 40px)`,
                height: 2,
                background: 'var(--tn-border)'
              }} />
            )}

            {node.children.map(child => (
              <div key={child.id} style={{ position: 'relative' }}>
                {/* Vertical connector */}
                <div style={{
                  position: 'absolute',
                  top: -30,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 2,
                  height: 20,
                  background: 'var(--tn-border)'
                }} />
                <TreeNode node={child} onNodeClick={onNodeClick} selectedNode={selectedNode} level={level + 1} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

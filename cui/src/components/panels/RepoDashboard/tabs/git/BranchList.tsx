import React from 'react';
import type { GitBranch } from './types';

interface Props {
  branches: GitBranch[];
}

export function BranchList({ branches }: Props) {
  if (branches.length === 0) {
    return <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>No branches.</div>;
  }
  return (
    <div data-ai-id="branch-list" style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: 4 }}>
      {branches.map(b => (
        <div
          key={b.name}
          data-ai-id={`branch-${b.name}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            background: b.isCurrent ? 'rgba(158,206,106,0.08)' : 'transparent',
            borderLeft: b.isCurrent ? '2px solid var(--tn-green)' : '2px solid transparent',
            fontSize: 11,
            fontFamily: 'monospace',
          }}
        >
          <span style={{ width: 12, color: 'var(--tn-green)', flexShrink: 0 }}>
            {b.isCurrent ? '●' : ' '}
          </span>
          <span style={{
            color: b.isCurrent ? 'var(--tn-green)' : 'var(--tn-text)',
            fontWeight: b.isCurrent ? 600 : 400,
            flexShrink: 0,
          }}>
            {b.name}
          </span>
          {b.upstream && (
            <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
              → {b.upstream}{b.gone ? ' (gone)' : ''}
            </span>
          )}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {b.ahead > 0 && (
              <span style={{ fontSize: 10, color: 'var(--tn-cyan, #7dcfff)' }}>↑{b.ahead}</span>
            )}
            {b.behind > 0 && (
              <span style={{ fontSize: 10, color: 'var(--tn-yellow)' }}>↓{b.behind}</span>
            )}
          </div>
          <span style={{
            flex: 1,
            color: 'var(--tn-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {b.headHash} {b.headMsg}
          </span>
        </div>
      ))}
    </div>
  );
}

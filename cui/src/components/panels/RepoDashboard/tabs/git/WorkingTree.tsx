import React from 'react';
import type { GitFile, GitStatusResponse } from './types';

interface Props {
  status: GitStatusResponse | null;
}

const KIND_COLORS: Record<GitFile['kind'], string> = {
  staged: 'var(--tn-green)',
  unstaged: 'var(--tn-yellow)',
  untracked: 'var(--tn-red)',
  conflicted: 'var(--tn-magenta, #bb9af7)',
  mixed: 'var(--tn-cyan, #7dcfff)',
};

const KIND_GLYPH: Record<GitFile['kind'], string> = {
  staged: '+',
  unstaged: '~',
  untracked: '?',
  conflicted: '!',
  mixed: '±',
};

export function WorkingTree({ status }: Props) {
  if (!status) {
    return <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading status...</div>;
  }
  const { files, summary } = status;
  if (files.length === 0) {
    return (
      <div data-ai-id="working-tree-clean" style={{ padding: 16, color: 'var(--tn-green)', fontSize: 11, fontFamily: 'monospace' }}>
        ● Working tree clean
      </div>
    );
  }

  // Group by kind for readability
  const groups: Array<[GitFile['kind'], GitFile[]]> = [
    ['conflicted', files.filter(f => f.kind === 'conflicted')],
    ['staged', files.filter(f => f.kind === 'staged')],
    ['mixed', files.filter(f => f.kind === 'mixed')],
    ['unstaged', files.filter(f => f.kind === 'unstaged')],
    ['untracked', files.filter(f => f.kind === 'untracked')],
  ];

  return (
    <div data-ai-id="working-tree" style={{ fontSize: 11, fontFamily: 'monospace' }}>
      {/* Summary bar */}
      <div data-ai-id="working-tree-summary" style={{
        display: 'flex', gap: 12, padding: '6px 12px',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        fontSize: 10,
      }}>
        {summary.conflicted > 0 && <span style={{ color: KIND_COLORS.conflicted }}>{summary.conflicted} conflicted</span>}
        <span style={{ color: KIND_COLORS.staged }}>{summary.staged} staged</span>
        <span style={{ color: KIND_COLORS.unstaged }}>{summary.unstaged} unstaged</span>
        <span style={{ color: KIND_COLORS.untracked }}>{summary.untracked} untracked</span>
      </div>

      {groups.map(([kind, items]) => items.length === 0 ? null : (
        <div key={kind} data-ai-id={`working-tree-group-${kind}`} style={{ padding: '4px 0' }}>
          <div style={{
            padding: '2px 12px',
            fontSize: 9,
            color: 'var(--tn-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {kind} ({items.length})
          </div>
          {items.map(f => (
            <div key={`${kind}-${f.path}`} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '2px 12px',
              cursor: 'default',
            }}>
              <span style={{ color: KIND_COLORS[f.kind], width: 12, flexShrink: 0, textAlign: 'center', fontWeight: 700 }}>
                {KIND_GLYPH[f.kind]}
              </span>
              <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, flexShrink: 0, width: 20 }}>
                {f.x}{f.y}
              </span>
              <span style={{
                color: 'var(--tn-text)',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}>
                {f.path}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

import React, { useMemo } from 'react';
import type { GitCommit } from './types';

interface Props {
  commits: GitCommit[];
  refs: Record<string, string[]>;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
}

const ROW_HEIGHT = 26;
const LANE_WIDTH = 14;
const GRAPH_PADDING = 12;
const NODE_RADIUS = 4;

const LANE_COLORS = [
  'var(--tn-blue)',
  'var(--tn-green)',
  'var(--tn-magenta, #bb9af7)',
  'var(--tn-yellow)',
  'var(--tn-cyan, #7dcfff)',
  'var(--tn-red)',
];

interface LaidOutCommit {
  commit: GitCommit;
  row: number;
  lane: number;
  parentLanes: number[];
}

function assignLanes(commits: GitCommit[]): { rows: LaidOutCommit[]; totalLanes: number } {
  const lanes: (string | null)[] = []; // lanes[i] = sha of commit expected next at lane i (a parent)
  const laneOf = new Map<string, number>(); // sha -> lane
  const rows: LaidOutCommit[] = [];

  const takeLane = (sha: string | null): number => {
    let idx = lanes.indexOf(null);
    if (idx === -1) { idx = lanes.length; lanes.push(sha); }
    else { lanes[idx] = sha; }
    return idx;
  };

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let myLane = lanes.indexOf(c.sha);
    if (myLane === -1) {
      myLane = takeLane(null);
    }
    laneOf.set(c.sha, myLane);

    const firstParent = c.parents[0] || null;
    // If the first parent is already expected on another lane, free this lane.
    // Otherwise, set this lane to expect the first parent.
    if (firstParent && lanes.includes(firstParent)) {
      lanes[myLane] = null;
    } else {
      lanes[myLane] = firstParent;
    }

    const parentLanes: number[] = firstParent ? [myLane] : [];

    // Additional parents (merge commits)
    for (let p = 1; p < c.parents.length; p++) {
      const parentSha = c.parents[p];
      let pLane = lanes.indexOf(parentSha);
      if (pLane === -1) pLane = takeLane(parentSha);
      parentLanes.push(pLane);
    }

    rows.push({ commit: c, row: i, lane: myLane, parentLanes });
  }

  // Trim trailing empty lanes
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  const totalLanes = Math.max(1, lanes.length, ...rows.map(r => r.lane + 1));

  return { rows, totalLanes };
}

export function CommitGraph({ commits, refs, selectedSha, onSelect }: Props) {
  const { rows, totalLanes } = useMemo(() => assignLanes(commits), [commits]);
  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach(r => m.set(r.commit.sha, r.row));
    return m;
  }, [rows]);

  if (commits.length === 0) {
    return <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>No commits.</div>;
  }

  const graphWidth = GRAPH_PADDING + totalLanes * LANE_WIDTH + GRAPH_PADDING;
  const totalHeight = rows.length * ROW_HEIGHT;

  const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;

  return (
    <div data-ai-id="commit-graph" style={{ display: 'flex', flexDirection: 'column', fontSize: 11, fontFamily: 'monospace' }}>
      <div style={{ display: 'flex' }}>
        {/* Graph column */}
        <div style={{ width: graphWidth, flexShrink: 0, position: 'relative', background: 'var(--tn-bg)' }}>
          <svg width={graphWidth} height={totalHeight} style={{ display: 'block' }}>
            {/* Edges (lines from commit to parents) */}
            {rows.map((r) => {
              const myY = r.row * ROW_HEIGHT + ROW_HEIGHT / 2;
              const myX = laneX(r.lane);
              return r.parentLanes.map((pLane, pIdx) => {
                const parentSha = r.commit.parents[pIdx];
                const parentRow = indexOf.get(parentSha);
                if (parentRow === undefined) {
                  // parent outside the visible window — line goes off-screen
                  const pX = laneX(pLane);
                  return (
                    <line
                      key={`e-${r.commit.sha}-${pIdx}`}
                      x1={myX} y1={myY}
                      x2={pX} y2={totalHeight}
                      stroke={LANE_COLORS[pLane % LANE_COLORS.length]}
                      strokeWidth={1.5}
                      strokeDasharray="3,2"
                    />
                  );
                }
                const pY = parentRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                const pX = laneX(pLane);
                if (myX === pX) {
                  return (
                    <line key={`e-${r.commit.sha}-${pIdx}`}
                      x1={myX} y1={myY} x2={pX} y2={pY}
                      stroke={LANE_COLORS[r.lane % LANE_COLORS.length]} strokeWidth={1.5}
                    />
                  );
                }
                // bent line: vertical, then horizontal at parent row
                const bendY = pY - ROW_HEIGHT / 2;
                return (
                  <path
                    key={`e-${r.commit.sha}-${pIdx}`}
                    d={`M ${myX} ${myY} L ${myX} ${bendY} Q ${myX} ${pY} ${myX + (pX > myX ? LANE_WIDTH / 2 : -LANE_WIDTH / 2)} ${pY} L ${pX} ${pY}`}
                    fill="none"
                    stroke={LANE_COLORS[pLane % LANE_COLORS.length]}
                    strokeWidth={1.5}
                  />
                );
              });
            })}

            {/* Nodes */}
            {rows.map((r) => {
              const cx = laneX(r.lane);
              const cy = r.row * ROW_HEIGHT + ROW_HEIGHT / 2;
              const isSelected = selectedSha === r.commit.sha;
              const isMerge = r.commit.parents.length > 1;
              return (
                <circle
                  key={`n-${r.commit.sha}`}
                  cx={cx} cy={cy}
                  r={isSelected ? NODE_RADIUS + 2 : NODE_RADIUS}
                  fill={isMerge ? 'var(--tn-bg)' : LANE_COLORS[r.lane % LANE_COLORS.length]}
                  stroke={LANE_COLORS[r.lane % LANE_COLORS.length]}
                  strokeWidth={isMerge ? 2 : 1}
                />
              );
            })}
          </svg>
        </div>

        {/* Commit info column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {rows.map((r) => {
            const c = r.commit;
            const commitRefs = refs[c.sha] || [];
            const isSelected = selectedSha === c.sha;
            return (
              <div
                key={c.sha}
                data-ai-id={`commit-row-${c.shortSha}`}
                onClick={() => onSelect(c.sha)}
                style={{
                  height: ROW_HEIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 8px',
                  cursor: 'pointer',
                  background: isSelected ? 'rgba(122,162,247,0.18)' : 'transparent',
                  borderLeft: isSelected ? '2px solid var(--tn-blue)' : '2px solid transparent',
                  overflow: 'hidden',
                }}
              >
                <span style={{ color: 'var(--tn-yellow)', fontWeight: 600, flexShrink: 0 }}>{c.shortSha}</span>
                {commitRefs.map(ref => (
                  <span
                    key={ref}
                    style={{
                      fontSize: 9,
                      padding: '1px 4px',
                      borderRadius: 2,
                      background: ref.startsWith('origin/') ? 'rgba(247,118,142,0.15)' : 'rgba(158,206,106,0.15)',
                      color: ref.startsWith('origin/') ? 'var(--tn-red)' : 'var(--tn-green)',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ref}
                  </span>
                ))}
                <span style={{
                  color: 'var(--tn-text)',
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {c.message}
                </span>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 10, flexShrink: 0 }}>
                  {c.author.split(' ')[0]}
                </span>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 10, flexShrink: 0, width: 80, textAlign: 'right' }}>
                  {formatRelative(c.date)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!d) return '';
  const sec = (Date.now() - d) / 1000;
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d`;
  if (sec < 86400 * 365) return `${Math.floor(sec / (86400 * 30))}mo`;
  return `${Math.floor(sec / (86400 * 365))}y`;
}

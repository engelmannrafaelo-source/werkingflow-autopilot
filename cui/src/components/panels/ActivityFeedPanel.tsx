import React, { useState, useEffect, useCallback } from 'react';
import { validateApiResponse } from '../../lib/validateApiResponse';

// ── Types ──────────────────────────────────────────────────────────────────

type ActivityType = 'feat' | 'fix' | 'chore' | 'refactor' | 'docs' | 'test' | 'style' | 'perf' | 'ci' | 'build' | 'revert' | 'commit';

interface ActivityEntry {
  type: ActivityType;
  message: string;
  author: string;
  date: string;
  hash?: string;
}

interface GroupedActivity {
  day: string;         // e.g. "2026-04-10"
  label: string;       // e.g. "Today", "Yesterday", "Apr 10"
  entries: ActivityEntry[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<ActivityType, string> = {
  feat:     '#9ece6a', // green
  fix:      '#f7768e', // red
  chore:    '#565f89', // grey
  refactor: '#7aa2f7', // blue
  docs:     '#7dcfff', // cyan
  test:     '#e0af68', // yellow
  style:    '#bb9af7', // purple
  perf:     '#ff9e64', // orange
  ci:       '#73daca', // teal
  build:    '#7aa2f7', // blue
  revert:   '#f7768e', // red
  commit:   '#565f89', // grey
};

const TYPE_LABEL: Record<ActivityType, string> = {
  feat:     'Feature',
  fix:      'Bugfix',
  chore:    'Chore',
  refactor: 'Refactor',
  docs:     'Docs',
  test:     'Test',
  style:    'Style',
  perf:     'Perf',
  ci:       'CI',
  build:    'Build',
  revert:   'Revert',
  commit:   'Commit',
};

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min

// ── Helpers ────────────────────────────────────────────────────────────────

function getDayLabel(isoDate: string): { day: string; label: string } {
  const d = new Date(isoDate);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const day = d.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let label: string;
  if (day === todayStr) label = 'Heute';
  else if (day === yesterdayStr) label = 'Gestern';
  else {
    label = d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
  }

  return { day, label };
}

function groupByDay(entries: ActivityEntry[]): GroupedActivity[] {
  const map = new Map<string, GroupedActivity>();

  for (const entry of entries) {
    const { day, label } = getDayLabel(entry.date);
    if (!map.has(day)) {
      map.set(day, { day, label, entries: [] });
    }
    map.get(day)!.entries.push(entry);
  }

  return Array.from(map.values());
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function stripConventionalPrefix(message: string): string {
  return message.replace(/^\w+(?:\([^)]*\))?!?:\s*/, '');
}

// ── Storage-Activity (cross-partner file changes) ──────────────────────────

interface StorageEntry {
  path: string;
  size: number;
  modified: string;
  owner: string;
}

// Map workspace IDs (used by frontend) → commit-app slugs (used by /activity).
// Engelmann splits one app across 3 workspaces; commits are tracked under one.
const WORKSPACE_TO_APP: Record<string, string> = {
  'engelmann-ai-hub': 'engelmann',
  'engelmann-developer': 'engelmann',
  'engelmann-dashboards': 'engelmann',
  'werkingsafety': 'werking-safety',
};

function formatRelTime(isoDate: string): string {
  const ageMs = Date.now() - new Date(isoDate).getTime();
  const min = Math.floor(ageMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.floor(h / 24);
  return `vor ${d} Tag${d > 1 ? 'en' : ''}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ──────────────────────────────────────────────────────────────

interface ActivityFeedPanelProps {
  app?: string;
}

export default function ActivityFeedPanel({ app }: ActivityFeedPanelProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [storage, setStorage] = useState<StorageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Workspace from URL or prop. Used as-is for storage-activity (workspace IDs);
  // mapped via WORKSPACE_TO_APP for commit-activity (app slugs in apps/).
  const resolvedWorkspace = app ?? (new URLSearchParams(window.location.search).get('app') ?? 'werking-energy');
  const resolvedApp = WORKSPACE_TO_APP[resolvedWorkspace] ?? resolvedWorkspace;

  const fetchActivity = useCallback(async () => {
    if (window.__cuiServerAlive === false) return;
    // Run both fetches in parallel — commit-history (git log) + storage-changes (file mtimes).
    const [commitRes, storageRes] = await Promise.allSettled([
      fetch(`/api/partner/activity?app=${encodeURIComponent(resolvedApp)}&limit=50`,
        { signal: AbortSignal.timeout(15000) }),
      fetch(`/api/partner/storage-activity?workspace=${encodeURIComponent(resolvedWorkspace)}&hours=72&limit=30`,
        { signal: AbortSignal.timeout(15000) }),
    ]);

    try {
      if (commitRes.status === 'fulfilled' && commitRes.value.ok) {
        const raw = await commitRes.value.json();
        const data = validateApiResponse<{ activity: ActivityEntry[] }>(raw, '/api/partner/activity', { activity: 'array' });
        setEntries(data.activity);
        setError(null);
      } else if (commitRes.status === 'fulfilled') {
        const body = await commitRes.value.json().catch(() => ({ error: `HTTP ${commitRes.value.status}` }));
        throw new Error(body.error ?? `HTTP ${commitRes.value.status}`);
      } else {
        throw commitRes.reason;
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.warn('[ActivityFeedPanel] commit fetch failed:', err);
        setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
      }
    }

    // Storage-activity is best-effort — failures don't block commits view.
    if (storageRes.status === 'fulfilled' && storageRes.value.ok) {
      try {
        const raw = await storageRes.value.json();
        if (Array.isArray(raw.files)) setStorage(raw.files);
      } catch (err) {
        console.warn('[ActivityFeedPanel] storage parse failed:', err);
      }
    }

    setLastRefresh(new Date());
    setLoading(false);
  }, [resolvedApp, resolvedWorkspace]);

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const groups = groupByDay(entries);

  return (
    <div
      data-ai-id="activity-feed-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--tn-surface)',
        fontFamily: 'monospace',
      }}
    >
      {/* Header */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: '2px solid var(--tn-border)',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
          ACTIVITY FEED
        </span>

        <span style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          fontFamily: 'monospace',
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: 3,
          padding: '2px 6px',
        }}>
          {resolvedApp}
        </span>

        {lastRefresh && (
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
            {lastRefresh.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}

        <button
          onClick={fetchActivity}
          style={{
            background: 'rgba(122,162,247,0.15)',
            border: '1px solid rgba(122,162,247,0.3)',
            borderRadius: 3,
            padding: '2px 8px',
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--tn-blue)',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && (
          <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
            Lade Aktivitäten…
          </div>
        )}

        {/* Storage Activity — what other partners (or Rafael on dev) wrote into shared-storage */}
        {!loading && storage.length > 0 && (
          <>
            <div style={{
              padding: '8px 12px 4px', fontSize: 10, fontWeight: 700,
              color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em',
              background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              Geteilter Speicher · letzte 72h ({storage.length})
            </div>
            {storage.slice(0, 15).map((s, idx) => (
              <div key={`storage-${idx}`} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '6px 12px', borderBottom: '1px solid var(--tn-border)',
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: '#7dcfff', flexShrink: 0, marginTop: 4,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 11, color: 'var(--tn-text)',
                    wordBreak: 'break-all', fontFamily: 'monospace',
                  }}>
                    {s.path}
                  </div>
                  <div style={{
                    display: 'flex', gap: 8, marginTop: 2,
                    fontSize: 9, color: 'var(--tn-text-muted)',
                  }}>
                    <span>{formatRelTime(s.modified)}</span>
                    <span style={{ opacity: 0.6 }}>·</span>
                    <span>{formatSize(s.size)}</span>
                    <span style={{ opacity: 0.6 }}>·</span>
                    <span>uid {s.owner}</span>
                  </div>
                </div>
              </div>
            ))}
            {storage.length > 15 && (
              <div style={{
                padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)',
                textAlign: 'center', fontStyle: 'italic',
                borderBottom: '1px solid var(--tn-border)',
              }}>
                + {storage.length - 15} weitere Dateien
              </div>
            )}
            <div style={{
              padding: '8px 12px 4px', fontSize: 10, fontWeight: 700,
              color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em',
              background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
              marginTop: 4,
            }}>
              Code-Änderungen · letzte 30 Tage
            </div>
          </>
        )}

        {!loading && error && (
          <div style={{ padding: 20, color: '#f7768e', fontSize: 12 }}>
            Fehler: {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && storage.length === 0 && (
          <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
            Keine Aktivitäten in den letzten 30 Tagen.
          </div>
        )}

        {!loading && !error && groups.map(group => (
          <div key={group.day}>
            {/* Day header */}
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--tn-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              background: 'var(--tn-bg-dark)',
              borderBottom: '1px solid var(--tn-border)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}>
              {group.label}
            </div>

            {/* Entries */}
            {group.entries.map((entry, idx) => {
              const color = TYPE_COLOR[entry.type];
              const label = TYPE_LABEL[entry.type];
              const shortMsg = stripConventionalPrefix(entry.message);

              return (
                <div
                  key={`${entry.hash ?? ''}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--tn-border)',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Timeline dot */}
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                    marginTop: 4,
                  }} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Type badge + message */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 9,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: `${color}22`,
                        color,
                        border: `1px solid ${color}55`,
                        flexShrink: 0,
                      }}>
                        {label}
                      </span>
                      <span style={{
                        fontSize: 11,
                        color: 'var(--tn-text)',
                        wordBreak: 'break-word',
                      }}>
                        {shortMsg}
                      </span>
                    </div>

                    {/* Meta: author, hash, time */}
                    <div style={{
                      display: 'flex',
                      gap: 8,
                      marginTop: 3,
                      fontSize: 9,
                      color: 'var(--tn-text-muted)',
                    }}>
                      <span>{entry.author}</span>
                      <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>{entry.hash ?? ''}</span>
                      <span>{formatTime(entry.date)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

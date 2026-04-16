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

// ── Component ──────────────────────────────────────────────────────────────

interface ActivityFeedPanelProps {
  app?: string;
}

export default function ActivityFeedPanel({ app }: ActivityFeedPanelProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Detect app from URL or prop
  const resolvedApp = app ?? (new URLSearchParams(window.location.search).get('app') ?? 'werking-energy');

  const fetchActivity = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await fetch(
        `/api/partner/activity?app=${encodeURIComponent(resolvedApp)}&limit=50`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const raw = await res.json();
      const data = validateApiResponse<{ activity: ActivityEntry[] }>(raw, '/api/partner/activity', { activity: 'array' });
      setEntries(data.activity);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.warn('[ActivityFeedPanel] fetch failed:', err);
        setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
      }
    } finally {
      setLoading(false);
    }
  }, [resolvedApp]);

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

        {!loading && error && (
          <div style={{ padding: 20, color: '#f7768e', fontSize: 12 }}>
            Fehler: {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
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

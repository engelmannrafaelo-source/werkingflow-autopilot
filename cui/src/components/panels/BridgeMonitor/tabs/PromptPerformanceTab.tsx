import { useState, useEffect, useCallback } from 'react';
import { validateApiResponse } from '../../../../lib/validateApiResponse';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts';
import { SafeChart } from '../../../shared/SafeChart';

// ─── Types ──────────────────────────────────────────────────────────

interface DurationStats {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

interface TokenStats {
  avg_input: number;
  avg_output: number;
  total_input: number;
  total_output: number;
}

interface AgentStat {
  app_id: string;
  agent_id: string;
  calls: number;
  successes: number;
  errors: number;
  timeouts: number;
  error_rate: number;
  duration_ms: DurationStats;
  tokens: TokenStats;
  models: Record<string, number>;
  last_call_ago_s: number | null;
  last_error: string | null;
  last_error_ago_s: number | null;
}

interface Summary {
  total_calls: number;
  total_agents: number;
  total_errors: number;
  overall_error_rate: number;
}

interface PerformanceData {
  agents: AgentStat[];
  summary: Summary;
  period_hours: number;
  raw_calls_stored?: number;
  _error?: string;
}

interface TimelinePoint {
  timestamp: number;
  calls: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  error_rate: number;
}

interface TimelineData {
  app_id: string;
  agent_id: string;
  timeline: TimelinePoint[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtAgo(seconds: number | null): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function errorColor(rate: number): string {
  if (rate >= 15) return 'var(--tn-red)';
  if (rate >= 5) return 'var(--tn-orange)';
  return 'var(--tn-green)';
}

function durationColor(ms: number): string {
  if (ms >= 60000) return 'var(--tn-red)';
  if (ms >= 15000) return 'var(--tn-orange)';
  return 'var(--tn-text)';
}

// Known agent labels for better readability
const AGENT_LABELS: Record<string, string> = {
  'gutachten-generate': 'Gutachten Generate',
  'conversation': 'Conversation (Chat)',
  'research': 'Research',
  'analyze-notes': 'Analyze Notes',
  'analyze-images': 'Analyze Images (Vision)',
  'content-plan': 'Content Plan',
  'ai-edit': 'AI Edit Agent',
  'help-agent': 'Help Agent',
  'generate-questions': 'Generate Questions',
  'analyze-smart': 'Smart Analysis',
  'analyze-autonomous': 'Autonomous Analysis',
  'iterate': 'Conversation Iterate',
  'inspect': 'File Inspect',
  'merge': 'File Merge',
  'image-analysis': 'Image Analysis',
  'generation': 'Generation',
  'editing': 'Editing',
  'smartEditing': 'Smart Editing',
  'correction': 'Correction',
};

const APP_COLORS: Record<string, string> = {
  'werking-report': 'var(--tn-blue)',
  'werking-energy': 'var(--tn-green)',
  'werking-safety': 'var(--tn-orange)',
  'engelmann': 'var(--tn-purple, #bb9af7)',
  'platform': 'var(--tn-text-muted)',
};

const BAR_COLORS = [
  'var(--tn-blue)',
  'var(--tn-green)',
  'var(--tn-purple, #bb9af7)',
  'var(--tn-orange)',
  'var(--tn-red)',
  'var(--tn-text-muted)',
  '#7dcfff',
  '#e0af68',
];

// ─── Component ──────────────────────────────────────────────────────

export default function PromptPerformanceTab() {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState(24);
  const [sortBy, setSortBy] = useState<'calls' | 'duration' | 'errors'>('calls');
  const [selectedAgent, setSelectedAgent] = useState<{ app_id: string; agent_id: string } | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (window.__cuiServerAlive !== true) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/bridge/metrics/prompt-performance?hours=${hours}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(await res.text());
      const raw = await res.json();
      if (raw._error) setError(raw._error);
      const validated = validateApiResponse<PerformanceData>(raw, '/api/bridge/metrics/prompt-performance', {
        agents: 'array',
        summary: 'object',
        period_hours: 'number',
        raw_calls_stored: { type: 'number', optional: true },
      });
      setData(validated);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  const fetchTimeline = useCallback(async (app_id: string, agent_id: string) => {
    setTimelineLoading(true);
    try {
      const res = await fetch(
        `/api/bridge/metrics/prompt-performance/timeline?app_id=${encodeURIComponent(app_id)}&agent_id=${encodeURIComponent(agent_id)}&hours=${hours}&bucket_minutes=${hours <= 6 ? 15 : hours <= 24 ? 30 : 60}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) throw new Error(await res.text());
      const rawTl = await res.json();
      const validatedTl = validateApiResponse<TimelineData>(rawTl, '/api/bridge/metrics/prompt-performance/timeline', {
        app_id: { type: 'string', optional: true },
        agent_id: { type: 'string', optional: true },
        timeline: 'array',
      });
      setTimeline(validatedTl);
    } catch {
      setTimeline(null);
    } finally {
      setTimelineLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => { clearInterval(interval); window.removeEventListener('cui-reconnected', onReconnect); };
  }, [fetchData]);

  // Sort agents
  const sortedAgents = data ? [...data.agents].sort((a, b) => {
    if (sortBy === 'calls') return b.calls - a.calls;
    if (sortBy === 'duration') return b.duration_ms.avg - a.duration_ms.avg;
    return b.error_rate - a.error_rate;
  }) : [];

  // Chart data: top 10 by avg duration
  const chartData = data
    ? [...data.agents]
        .sort((a, b) => b.duration_ms.avg - a.duration_ms.avg)
        .slice(0, 10)
        .map(a => ({
          name: `${a.app_id.replace('werking-', 'W-')}/${a.agent_id}`,
          avg: Math.round(a.duration_ms.avg / 1000 * 10) / 10,
          p95: Math.round(a.duration_ms.p95 / 1000 * 10) / 10,
          app_id: a.app_id,
        }))
    : [];

  return (
    <div data-ai-id="prompt-performance-tab" style={{ padding: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          Prompt Performance
        </h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Time range selector */}
          {[6, 24, 72, 168].map(h => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
                background: hours === h ? 'var(--tn-blue)' : 'var(--tn-bg-dark)',
                border: hours === h ? 'none' : '1px solid var(--tn-border)',
                color: hours === h ? '#fff' : 'var(--tn-text-muted)',
                fontWeight: 600,
              }}
            >
              {h <= 24 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
          <button
            onClick={fetchData}
            style={{
              padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
              color: 'var(--tn-text-muted)',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '6px 10px', fontSize: 11, color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading prompt metrics...
        </div>
      )}

      {/* Summary Cards */}
      {data && (
        <div data-ai-id="prompt-perf-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
          <StatCard label="Total Calls" value={String(data.summary.total_calls)} color="var(--tn-blue)" />
          <StatCard label="Active Agents" value={String(data.summary.total_agents)} color="var(--tn-purple, #bb9af7)" />
          <StatCard label="Errors" value={String(data.summary.total_errors)} color={data.summary.total_errors > 0 ? 'var(--tn-red)' : 'var(--tn-green)'} />
          <StatCard label="Error Rate" value={`${data.summary.overall_error_rate}%`} color={errorColor(data.summary.overall_error_rate)} />
        </div>
      )}

      {/* Duration Chart */}
      {chartData.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Avg Duration by Agent (seconds)
          </div>
          <SafeChart height={200}>
            <BarChart data={chartData} margin={{ top: 0, right: 10, left: 0, bottom: 50 }}>
              <XAxis dataKey="name" tick={{ fontSize: 8, fill: 'var(--tn-text-muted)' }} angle={-35} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={35} unit="s" />
              <Tooltip
                contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }}
                formatter={(value, name) => [`${value}s`, name === 'avg' ? 'Avg' : 'P95']}
              />
              <Bar dataKey="avg" radius={[3, 3, 0, 0]} name="avg">
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={APP_COLORS[entry.app_id] || BAR_COLORS[i % BAR_COLORS.length]} />
                ))}
              </Bar>
              <Bar dataKey="p95" radius={[3, 3, 0, 0]} name="p95" opacity={0.4}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={APP_COLORS[entry.app_id] || BAR_COLORS[i % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </SafeChart>
        </div>
      )}

      {/* Sort controls */}
      {sortedAgents.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', lineHeight: '22px' }}>Sort:</span>
          {(['calls', 'duration', 'errors'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              style={{
                padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
                background: sortBy === s ? 'rgba(122,162,247,0.2)' : 'transparent',
                border: 'none', color: sortBy === s ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                fontWeight: 600,
              }}
            >
              {s === 'calls' ? 'Most Calls' : s === 'duration' ? 'Slowest' : 'Most Errors'}
            </button>
          ))}
        </div>
      )}

      {/* Agent Table */}
      {sortedAgents.length > 0 && (
        <div data-ai-id="prompt-perf-agents">
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 70px 90px 70px 80px 70px',
            gap: 6, padding: '6px 10px',
            background: 'var(--tn-bg-dark)', borderRadius: '4px 4px 0 0',
            fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            <div>Agent</div>
            <div>Calls</div>
            <div>Avg / P95</div>
            <div>Errors</div>
            <div>Tokens</div>
            <div>Last</div>
          </div>

          {/* Rows */}
          {sortedAgents.map((agent, idx) => {
            const isSelected = selectedAgent?.app_id === agent.app_id && selectedAgent?.agent_id === agent.agent_id;
            return (
              <div key={idx}>
                <div
                  onClick={() => {
                    if (isSelected) {
                      setSelectedAgent(null);
                      setTimeline(null);
                    } else {
                      setSelectedAgent({ app_id: agent.app_id, agent_id: agent.agent_id });
                      fetchTimeline(agent.app_id, agent.agent_id);
                    }
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 70px 90px 70px 80px 70px',
                    gap: 6, padding: '8px 10px',
                    borderBottom: '1px solid var(--tn-border)',
                    fontSize: 10, alignItems: 'center',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(122,162,247,0.08)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                >
                  {/* Agent name */}
                  <div>
                    <span style={{
                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                      background: `${APP_COLORS[agent.app_id] || 'var(--tn-text-muted)'}20`,
                      color: APP_COLORS[agent.app_id] || 'var(--tn-text-muted)',
                      marginRight: 6,
                    }}>
                      {agent.app_id.replace('werking-', '')}
                    </span>
                    <span style={{ color: 'var(--tn-text)', fontWeight: 500 }}>
                      {AGENT_LABELS[agent.agent_id] || agent.agent_id}
                    </span>
                  </div>

                  {/* Calls */}
                  <div style={{ color: 'var(--tn-blue)', fontFamily: 'monospace', fontWeight: 600 }}>
                    {agent.calls}
                  </div>

                  {/* Duration avg / p95 */}
                  <div style={{ fontFamily: 'monospace' }}>
                    <span style={{ color: durationColor(agent.duration_ms.avg), fontWeight: 600 }}>
                      {fmtDuration(agent.duration_ms.avg)}
                    </span>
                    <span style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
                      {' / '}{fmtDuration(agent.duration_ms.p95)}
                    </span>
                  </div>

                  {/* Error rate */}
                  <div style={{ fontFamily: 'monospace' }}>
                    <span style={{ color: errorColor(agent.error_rate), fontWeight: 600 }}>
                      {agent.error_rate}%
                    </span>
                    {agent.errors > 0 && (
                      <span style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
                        {' '}({agent.errors})
                      </span>
                    )}
                  </div>

                  {/* Tokens */}
                  <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {fmtTokens(agent.tokens.avg_input)}+{fmtTokens(agent.tokens.avg_output)}
                  </div>

                  {/* Last call */}
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {fmtAgo(agent.last_call_ago_s)}
                  </div>
                </div>

                {/* Expanded detail + timeline */}
                {isSelected && (
                  <div style={{
                    padding: '10px 12px', background: 'rgba(122,162,247,0.05)',
                    borderBottom: '1px solid var(--tn-border)',
                  }}>
                    {/* Detail stats */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 12 }}>
                      <MiniStat label="Min" value={fmtDuration(agent.duration_ms.min)} />
                      <MiniStat label="P50" value={fmtDuration(agent.duration_ms.p50)} />
                      <MiniStat label="Avg" value={fmtDuration(agent.duration_ms.avg)} />
                      <MiniStat label="P95" value={fmtDuration(agent.duration_ms.p95)} />
                      <MiniStat label="Max" value={fmtDuration(agent.duration_ms.max)} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                      <MiniStat label="Total Input" value={fmtTokens(agent.tokens.total_input)} />
                      <MiniStat label="Total Output" value={fmtTokens(agent.tokens.total_output)} />
                      <MiniStat label="Timeouts" value={String(agent.timeouts)} color={agent.timeouts > 0 ? 'var(--tn-orange)' : undefined} />
                      <MiniStat
                        label="Last Error"
                        value={agent.last_error ? `${agent.last_error.slice(0, 30)}` : '-'}
                        color={agent.last_error ? 'var(--tn-red)' : undefined}
                      />
                    </div>

                    {/* Models used */}
                    <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 10 }}>
                      Models: {Object.entries(agent.models).map(([m, c]) => `${m.replace('claude-', '').replace(/-\d+$/, '')} (${c}x)`).join(', ')}
                    </div>

                    {/* Timeline chart */}
                    {timelineLoading && (
                      <div style={{ padding: 20, textAlign: 'center', fontSize: 10, color: 'var(--tn-text-muted)' }}>
                        Loading timeline...
                      </div>
                    )}
                    {timeline && timeline.timeline.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                          Duration Timeline
                        </div>
                        <SafeChart height={120}>
                          <LineChart data={timeline.timeline.map(p => ({
                            time: new Date(p.timestamp * 1000).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }),
                            avg: Math.round(p.avg_duration_ms / 1000 * 10) / 10,
                            max: Math.round(p.max_duration_ms / 1000 * 10) / 10,
                            errors: p.error_rate,
                          }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--tn-border)" />
                            <XAxis dataKey="time" tick={{ fontSize: 8, fill: 'var(--tn-text-muted)' }} />
                            <YAxis tick={{ fontSize: 8, fill: 'var(--tn-text-muted)' }} width={30} unit="s" />
                            <Tooltip
                              contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }}
                              formatter={(value, name) => [`${value}s`, name === 'avg' ? 'Avg' : 'Max']}
                            />
                            <Line type="monotone" dataKey="avg" stroke="var(--tn-blue)" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="max" stroke="var(--tn-orange)" strokeWidth={1} dot={false} opacity={0.5} />
                          </LineChart>
                        </SafeChart>
                      </div>
                    )}
                    {timeline && timeline.timeline.length === 0 && !timelineLoading && (
                      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'center', padding: 10 }}>
                        No timeline data for this period
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {data && sortedAgents.length === 0 && (
        <div style={{
          padding: 40, textAlign: 'center', background: 'var(--tn-bg-dark)',
          borderRadius: 6, color: 'var(--tn-text-muted)', fontSize: 11,
        }}>
          No prompt metrics recorded yet.
          <br />
          <span style={{ fontSize: 10, opacity: 0.7 }}>
            Metrics are collected as apps make AI calls through the Bridge.
          </span>
        </div>
      )}

      {/* Footer */}
      {data && (
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right', marginTop: 12 }}>
          {data.raw_calls_stored ?? 0} calls stored (7d window) | Period: {data.period_hours}h
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)', borderRadius: 6,
    }}>
      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'monospace', marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      padding: '6px 8px', background: 'var(--tn-bg-dark)',
      borderRadius: 4, border: '1px solid var(--tn-border)',
    }}>
      <div style={{ fontSize: 8, color: 'var(--tn-text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: color || 'var(--tn-text)', fontFamily: 'monospace', marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
}

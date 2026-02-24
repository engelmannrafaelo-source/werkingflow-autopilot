import { useState, useEffect, useCallback } from 'react';
import { StatCard, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, StatusBadge, formatTokens } from '../shared';

interface AccountData {
  accountName: string;
  workspaces: string[];
  totalTokens: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  lastActivity: string | null;
  models: Record<string, number>;
  storageBytes: number;
  burnRatePerHour: number;
  weeklyProjection: number;
  weeklyLimitPercent: number;
  weeklyLimitActual: number;
  status: 'safe' | 'warning' | 'critical';
  nextWindowReset: string | null;
  currentWindowTokens: number;
  dataSource: 'jsonl-estimated' | 'manual-override' | 'hybrid';
  manualUpdateDate: string | null;
}

interface Alert {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  accountName: string;
}

interface StatsData {
  accounts: AccountData[];
  alerts: Alert[];
  weeklyLimit: number;
  timestamp: string;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function timeAgo(isoDate: string | null): string {
  if (!isoDate) return 'Never';
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

function timeUntil(isoDate: string | null): string {
  if (!isoDate) return 'Unknown';
  const ms = new Date(isoDate).getTime() - Date.now();
  if (ms < 0) return 'Now available';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export default function CCUsageTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/claude-code/stats-v2');
      const data: StatsData = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setStats(data);
      }
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(`Fehler: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 60000); // Refresh every 60s
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchStats} />
      {error && <ErrorBanner message={error} />}

      {!loading && stats && (
        <>
          {/* Alerts Section */}
          {stats.alerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {stats.alerts.map((alert, i) => {
                const bgColor = {
                  critical: 'rgba(247,118,142,0.15)',
                  warning: 'rgba(224,175,104,0.15)',
                  info: 'rgba(122,162,247,0.15)',
                }[alert.severity];
                const borderColor = {
                  critical: 'rgba(247,118,142,0.4)',
                  warning: 'rgba(224,175,104,0.4)',
                  info: 'rgba(122,162,247,0.4)',
                }[alert.severity];
                const textColor = {
                  critical: 'var(--tn-red)',
                  warning: 'var(--tn-orange)',
                  info: 'var(--tn-blue)',
                }[alert.severity];
                const icon = {
                  critical: '🔴',
                  warning: '⚠️',
                  info: 'ℹ️',
                }[alert.severity];

                return (
                  <div key={i} style={{
                    background: bgColor,
                    border: `1px solid ${borderColor}`,
                    borderRadius: 5,
                    padding: 10,
                    marginBottom: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14 }}>{icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: textColor }}>
                        {alert.title}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', lineHeight: 1.4 }}>
                      {alert.description}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Account Overview Cards */}
          <SectionFlat title="Claude Code Accounts">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {stats.accounts.map((acc, i) => {
                // Use actual limit if available (from manual override), else estimated
                const effectiveLimit = acc.weeklyLimitActual || stats.weeklyLimit;
                const tokensRemaining = effectiveLimit - acc.totalTokens;
                const daysUntilLimit = tokensRemaining > 0 && acc.burnRatePerHour > 0
                  ? (tokensRemaining / acc.burnRatePerHour / 24)
                  : 999;

                return (
                  <div key={i} style={{
                    background: 'var(--tn-bg-dark)',
                    border: `2px solid ${acc.status === 'critical' ? 'var(--tn-red)' : acc.status === 'warning' ? 'var(--tn-orange)' : 'var(--tn-border)'}`,
                    borderRadius: 6,
                    padding: 12,
                  }}>
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {acc.accountName}
                        </span>
                        <StatusBadge status={acc.status === 'critical' ? 'error' : acc.status === 'warning' ? 'paused' : 'ok'} />
                        {acc.dataSource === 'manual-override' && (
                          <span style={{
                            fontSize: 8,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 3,
                            background: 'rgba(158,206,106,0.2)',
                            color: 'var(--tn-green)',
                            letterSpacing: '0.05em',
                          }}>
                            LIVE
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                        Last active: {timeAgo(acc.lastActivity)}
                      </span>
                    </div>

                    {/* Metrics Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
                      <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>
                          {acc.dataSource === 'manual-override' ? 'Weekly Usage (Live)' : 'Weekly Projection'}
                        </div>
                        <div style={{
                          fontSize: 16,
                          fontWeight: 700,
                          fontFamily: 'monospace',
                          color: acc.status === 'critical' ? 'var(--tn-red)' : acc.status === 'warning' ? 'var(--tn-orange)' : 'var(--tn-green)',
                        }}>
                          {acc.weeklyLimitPercent.toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>
                          {acc.dataSource === 'manual-override'
                            ? `${formatTokens(acc.totalTokens)} / ${formatTokens(acc.weeklyLimitActual)}`
                            : `${formatTokens(acc.weeklyProjection)} / ${formatTokens(stats.weeklyLimit)}`
                          }
                        </div>
                      </div>

                      <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Burn Rate</div>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: 'var(--tn-blue)' }}>
                          {(acc.burnRatePerHour / 1000).toFixed(1)}K
                        </div>
                        <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>tokens/hour</div>
                      </div>

                      <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Limit Reached In</div>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: 'var(--tn-text)' }}>
                          {daysUntilLimit < 999 ? `${daysUntilLimit.toFixed(1)}d` : '∞'}
                        </div>
                        <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>
                          {tokensRemaining > 0 ? `${formatTokens(tokensRemaining)} left` : 'Limit exceeded'}
                        </div>
                      </div>

                      <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>5h-Window Reset</div>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: 'var(--tn-purple)' }}>
                          {timeUntil(acc.nextWindowReset)}
                        </div>
                        <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>
                          {acc.currentWindowTokens > 0 ? `${formatTokens(acc.currentWindowTokens)} used` : 'Window idle'}
                        </div>
                      </div>
                    </div>

                    {/* Workspaces & Details */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTop: '1px solid var(--tn-border)' }}>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                        <strong>{acc.totalSessions}</strong> sessions across <strong>{acc.workspaces.length}</strong> workspace{acc.workspaces.length !== 1 ? 's' : ''}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                        {formatTokens(acc.totalTokens)} total tokens
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionFlat>

          {/* Global Stats */}
          <SectionFlat title="Global Statistics">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <StatCard
                label="Total Accounts"
                value={String(stats.accounts.length)}
                sub={`${stats.accounts.filter(a => a.status === 'critical').length} critical, ${stats.accounts.filter(a => a.status === 'warning').length} warning`}
              />
              <StatCard
                label="Total Tokens"
                value={formatTokens(stats.accounts.reduce((sum, a) => sum + a.totalTokens, 0))}
                sub={`Input: ${formatTokens(stats.accounts.reduce((sum, a) => sum + a.totalInputTokens, 0))}`}
              />
              <StatCard
                label="Total Sessions"
                value={String(stats.accounts.reduce((sum, a) => sum + a.totalSessions, 0))}
                sub={`Across ${stats.accounts.flatMap(a => a.workspaces).length} workspaces`}
              />
              <StatCard
                label="Cache Performance"
                value={formatTokens(stats.accounts.reduce((sum, a) => sum + a.totalCacheRead, 0))}
                sub="Cache reads saved"
                color="var(--tn-blue)"
              />
            </div>
          </SectionFlat>

          {/* Info Box */}
          <div style={{
            background: 'rgba(122,162,247,0.1)',
            border: '1px solid rgba(122,162,247,0.3)',
            borderRadius: 5,
            padding: 10,
            marginTop: 12,
          }}>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--tn-blue)' }}>ℹ️ Info:</strong> Daten basieren auf lokalem JSONL-Parsing.
              <br />
              <strong>Weekly Limit:</strong> {formatTokens(stats.weeklyLimit)} (konservative Pro-Schätzung)
              <br />
              <strong>5h-Window:</strong> Heuristik basierend auf Message-Clustering
              <br />
              <strong>Burn-Rate:</strong> Berechnet aus letzten 24h Aktivität
            </div>
          </div>
        </>
      )}

      {!loading && !stats && !error && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Keine Claude Code Daten gefunden.
        </div>
      )}

      {loading && <LoadingSpinner text="Lade Claude Code Stats..." />}
    </div>
  );
}

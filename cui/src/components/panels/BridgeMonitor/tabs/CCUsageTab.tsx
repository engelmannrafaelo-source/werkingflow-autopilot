import { useState, useEffect, useCallback } from "react";
import { Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, StatusBadge } from "../shared";

interface ScrapedData {
  plan: string;
  currentSession: { percent: number; resetIn: string };
  weeklyAllModels: { percent: number; resetDate: string };
  weeklySonnet: { percent: number; resetDate: string };
  extraUsage: { percent: number; spent: string; limit: string; balance: string };
}

interface AccountData {
  accountId: string;
  accountName: string;
  totalTokens: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  workspaces: string[];
  lastActivity: string | null;
  models: Record<string, number>;
  burnRatePerHour: number;
  weeklyLimitPercent: number;
  status: "safe" | "warning" | "critical";
  dataSource: string;
  scrapedTimestamp: string | null;
  scraped: ScrapedData | null;
}

interface CombinedJsonl {
  totalTokens: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  burnRatePerHour: number;
  models: Record<string, number>;
  storageBytes: number;
  lastActivity: string | null;
  workspaceCount: number;
}

interface Alert {
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
}

interface StatsData {
  accounts: AccountData[];
  combinedJsonl: CombinedJsonl | null;
  alerts: Alert[];
  timestamp: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pctColor(pct: number): string {
  if (pct >= 80) return "var(--tn-red)";
  if (pct >= 50) return "var(--tn-orange)";
  return "var(--tn-green)";
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div style={{ height: 6, background: "var(--tn-border)", borderRadius: 3, overflow: "hidden", marginTop: 4 }}>
      <div style={{ height: "100%", width: `${Math.min(100, percent)}%`, background: color, borderRadius: 3, transition: "width 0.5s ease" }} />
    </div>
  );
}

function UsageRow({ label, percent, resetText, sub }: { label: string; percent: number; resetText: string; sub?: string }) {
  const color = pctColor(percent);
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--tn-border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
        <span style={{ fontSize: 11, color: "var(--tn-text)" }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "monospace", color }}>{percent}%</span>
      </div>
      <ProgressBar percent={percent} color={color} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        <span style={{ fontSize: 9, color: "var(--tn-text-muted)" }}>{resetText}</span>
        {sub && <span style={{ fontSize: 9, color: "var(--tn-text-muted)" }}>{sub}</span>}
      </div>
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 4, padding: 6 }}>
      <div style={{ fontSize: 8, color: "var(--tn-text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "monospace", color: color || "var(--tn-text)" }}>{value}</div>
    </div>
  );
}

export default function CCUsageTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/claude-code/stats-v2");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      else setStats(data);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const iv = setInterval(fetchStats, 60000);
    return () => clearInterval(iv);
  }, [fetchStats]);

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchStats} autoRefresh={60} />
      {error && <ErrorBanner message={error} />}
      {loading && <LoadingSpinner text="Lade Claude Code Stats..." />}

      {!loading && stats && (
        <>
          {/* Alerts */}
          {stats.alerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {stats.alerts.map((alert, i) => {
                const colors = {
                  critical: { bg: "rgba(247,118,142,0.15)", border: "rgba(247,118,142,0.4)", text: "var(--tn-red)" },
                  warning: { bg: "rgba(224,175,104,0.15)", border: "rgba(224,175,104,0.4)", text: "var(--tn-orange)" },
                  info: { bg: "rgba(122,162,247,0.15)", border: "rgba(122,162,247,0.4)", text: "var(--tn-blue)" },
                }[alert.severity];
                return (
                  <div key={i} style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 5, padding: 10, marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: colors.text, marginBottom: 2 }}>{alert.title}</div>
                    <div style={{ fontSize: 10, color: "var(--tn-text-muted)" }}>{alert.description}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Account Cards - only scraped usage bars */}
          <SectionFlat title="Claude Code Accounts">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {stats.accounts.map((acc) => {
                const s = acc.scraped;
                const borderColor = acc.status === "critical" ? "var(--tn-red)" : acc.status === "warning" ? "var(--tn-orange)" : "var(--tn-border)";

                return (
                  <div key={acc.accountName} style={{ background: "var(--tn-bg-dark)", border: `2px solid ${borderColor}`, borderRadius: 6, padding: 12 }}>
                    {/* Header */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--tn-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          {acc.accountName}
                        </span>
                        {s?.plan && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "rgba(187,154,247,0.2)", color: "var(--tn-purple)", letterSpacing: "0.05em" }}>
                            {s.plan}
                          </span>
                        )}
                        <StatusBadge status={acc.status === "critical" ? "error" : acc.status === "warning" ? "paused" : "ok"} />
                        {acc.dataSource.includes("hybrid") || acc.dataSource === "scraped" ? (
                          <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "rgba(158,206,106,0.2)", color: "var(--tn-green)", letterSpacing: "0.05em" }}>LIVE</span>
                        ) : null}
                      </div>
                      <span style={{ fontSize: 9, color: "var(--tn-text-muted)" }}>
                        {acc.scrapedTimestamp ? `Scraped: ${timeAgo(acc.scrapedTimestamp)}` : `Active: ${timeAgo(acc.lastActivity)}`}
                      </span>
                    </div>

                    {/* Usage Bars (from scraped data) */}
                    {s ? (
                      <div>
                        <UsageRow label="Aktuelle Sitzung" percent={s.currentSession.percent} resetText={s.currentSession.resetIn} />
                        <UsageRow label="Weekly — Alle Modelle" percent={s.weeklyAllModels.percent} resetText={s.weeklyAllModels.resetDate} />
                        <UsageRow label="Weekly — Nur Sonnet" percent={s.weeklySonnet.percent} resetText={s.weeklySonnet.resetDate} />
                        {s.extraUsage.percent > 0 && (
                          <UsageRow
                            label="Extra Usage (Kosten)"
                            percent={s.extraUsage.percent}
                            resetText={`${s.extraUsage.spent} / ${s.extraUsage.limit}`}
                            sub={s.extraUsage.balance ? `Guthaben: ${s.extraUsage.balance}` : undefined}
                          />
                        )}
                      </div>
                    ) : (
                      <div style={{ padding: 12, textAlign: "center", color: "var(--tn-text-muted)", fontSize: 10, background: "rgba(0,0,0,0.2)", borderRadius: 4 }}>
                        Keine Live-Daten — Scraper noch nicht gelaufen
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </SectionFlat>

          {/* Combined JSONL Stats */}
          {stats.combinedJsonl && (
            <SectionFlat title="JSONL Stats (alle Accounts, shared)">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, marginBottom: 8 }}>
                <MetricBox label="Burn Rate" value={`${(stats.combinedJsonl.burnRatePerHour / 1000).toFixed(1)}K/h`} color="var(--tn-blue)" />
                <MetricBox label="Sessions" value={String(stats.combinedJsonl.totalSessions)} />
                <MetricBox label="Total Tokens" value={formatTokens(stats.combinedJsonl.totalTokens)} />
                <MetricBox label="Cache Reads" value={formatTokens(stats.combinedJsonl.totalCacheRead)} color="var(--tn-blue)" />
                <MetricBox label="Cache Creation" value={formatTokens(stats.combinedJsonl.totalCacheCreation)} color="var(--tn-purple)" />
                <MetricBox label="Storage" value={`${(stats.combinedJsonl.storageBytes / (1024 * 1024)).toFixed(0)} MB`} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--tn-text-muted)", paddingTop: 6, borderTop: "1px solid var(--tn-border)" }}>
                <span>{stats.combinedJsonl.workspaceCount} workspaces</span>
                <span>In: {formatTokens(stats.combinedJsonl.totalInputTokens)} | Out: {formatTokens(stats.combinedJsonl.totalOutputTokens)}</span>
                <span>Last: {timeAgo(stats.combinedJsonl.lastActivity)}</span>
              </div>
            </SectionFlat>
          )}

          {/* Info */}
          <div style={{ background: "rgba(122,162,247,0.1)", border: "1px solid rgba(122,162,247,0.3)", borderRadius: 5, padding: 10, marginTop: 12 }}>
            <div style={{ fontSize: 10, color: "var(--tn-text-muted)", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--tn-blue)" }}>Datenquellen:</strong>
              <br />
              <strong>Live-Daten:</strong> Playwright-Scraping von claude.ai/settings/usage (alle 4h)
              <br />
              <strong>JSONL-Daten:</strong> Lokales Parsing der Conversation-Dateien (shared across accounts)
              <br />
              <strong>Burn Rate:</strong> Berechnet aus den letzten 24h
            </div>
          </div>
        </>
      )}
    </div>
  );
}

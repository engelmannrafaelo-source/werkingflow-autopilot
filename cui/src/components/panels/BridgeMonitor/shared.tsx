import React from 'react';

// ─── Config ─────────────────────────────────────────────────────────
export const BRIDGE_URL = 'http://49.12.72.66:8000';

// Internal admin API key - this CUI is a local Electron admin tool, not a public frontend
const API_KEY = '967bf3159a351578f3fafda1e361fd7d4ae32d3c2ff8ee82428bf1ab364c4745';

export function authHeaders(): Record<string, string> {
  return { 'Authorization': `Bearer ${API_KEY}` };
}

/** Fetch with auth + timeout. Throws on non-ok responses. */
export async function bridgeFetch(path: string, opts?: RequestInit & { timeout?: number }): Promise<Response> {
  const { timeout = 12_000, ...init } = opts ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { ...authHeaders(), ...init?.headers },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch JSON with auth. Throws on non-ok or parse failure. */
export async function bridgeJson<T = any>(path: string, opts?: RequestInit & { timeout?: number }): Promise<T> {
  const res = await bridgeFetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => 'unknown')}`);
  return res.json();
}

// ─── Reusable UI Components ─────────────────────────────────────────

export function StatusBadge({ status }: { status: 'active' | 'paused' | 'dead' | 'ok' | 'error' | 'unknown' | 'limited' | 'running' | 'completed' | 'failed' | 'cancelled' }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    active:    { bg: 'rgba(158,206,106,0.2)', color: 'var(--tn-green)',       label: 'AKTIV' },
    ok:        { bg: 'rgba(158,206,106,0.2)', color: 'var(--tn-green)',       label: 'OK' },
    running:   { bg: 'rgba(122,162,247,0.2)', color: 'var(--tn-blue)',        label: 'LÄUFT' },
    completed: { bg: 'rgba(158,206,106,0.2)', color: 'var(--tn-green)',       label: 'FERTIG' },
    paused:    { bg: 'rgba(224,175,104,0.2)', color: 'var(--tn-orange)',      label: 'PAUSIERT' },
    limited:   { bg: 'rgba(224,175,104,0.2)', color: 'var(--tn-orange)',      label: 'RATE-LIMITED' },
    dead:      { bg: 'rgba(247,118,142,0.2)', color: 'var(--tn-red)',         label: 'TOT' },
    error:     { bg: 'rgba(247,118,142,0.2)', color: 'var(--tn-red)',         label: 'FEHLER' },
    failed:    { bg: 'rgba(247,118,142,0.2)', color: 'var(--tn-red)',         label: 'FEHLGESCHLAGEN' },
    cancelled: { bg: 'rgba(100,100,100,0.2)', color: 'var(--tn-text-muted)',  label: 'ABGEBROCHEN' },
    unknown:   { bg: 'rgba(100,100,100,0.2)', color: 'var(--tn-text-muted)',  label: 'UNBEKANNT' },
  };
  const s = map[status] ?? map.unknown;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 3,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
      background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  );
}

export function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--tn-border)' }}>
      <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--tn-text)', fontFamily: mono ? 'monospace' : undefined }}>{value}</span>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, padding: '2px 10px' }}>
        {children}
      </div>
    </div>
  );
}

export function SectionFlat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
      padding: '10px 12px', flex: '1 1 0', minWidth: 100,
    }}>
      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? 'var(--tn-text)', fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function Meter({ value, max, color }: { value: number; max: number; color: string }) {
  // Defensive: handle undefined/null values
  const safeValue = value ?? 0;
  const safeMax = max ?? 0;
  const pct = safeMax > 0 ? Math.min(100, Math.round((safeValue / safeMax) * 100)) : 0;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{safeValue.toFixed(1)} / {safeMax.toFixed(1)}</span>
        <span style={{ fontSize: 9, color, fontWeight: 700 }}>{pct}%</span>
      </div>
      <div style={{ height: 5, background: 'var(--tn-border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

export function ActionButton({ label, loading, onClick, color }: { label: string; loading: boolean; onClick: () => void; color?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        padding: '6px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer',
        background: loading ? 'var(--tn-border)' : (color ?? 'var(--tn-blue)'),
        border: 'none', color: '#fff',
        opacity: loading ? 0.6 : 1,
        transition: 'all 0.15s',
      }}
    >
      {loading ? 'Lädt...' : label}
    </button>
  );
}

export function Toolbar({ lastRefresh, loading, onRefresh, autoRefresh }: {
  lastRefresh: Date | null;
  loading: boolean;
  onRefresh: () => void;
  autoRefresh?: number;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
        {lastRefresh ? `Aktualisiert: ${lastRefresh.toLocaleTimeString('de-AT')}` : 'Wird geladen...'}
        {autoRefresh && <span style={{ marginLeft: 8, opacity: 0.6 }}>• Auto-Refresh alle {autoRefresh}s</span>}
      </span>
      <button
        onClick={onRefresh}
        disabled={loading}
        style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: loading ? 'not-allowed' : 'pointer',
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
          opacity: loading ? 0.5 : 1,
        }}
      >
        {loading ? 'Lädt...' : 'Refresh'}
      </button>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 4, marginBottom: 12 }}>
      {message}
    </div>
  );
}

export function LoadingSpinner({ text }: { text: string }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
      {text}
    </div>
  );
}

// ─── Formatting Helpers ─────────────────────────────────────────────

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours}h`;
  return `vor ${Math.floor(hours / 24)}d`;
}

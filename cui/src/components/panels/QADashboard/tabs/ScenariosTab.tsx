import React, { useState, useEffect, useCallback } from 'react';
import type { ScenariosData } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';
import { useAuth } from '../../../../contexts/AuthContext';
import ScenarioWizard from '../ScenarioWizard';

interface PoScenario {
  id: string;
  system: string;
  name: string;
  description: string;
  layer: 4;
  tester: { perspektive: string; erfahrung: string };
  auftrag: string;
  ziele: string[];
  qualitaetsfrage: string;
  target_url: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  last_run_at?: string;
  last_run_id?: string;
}

interface PoRunRecord {
  runId: string;
  scenarioId: string;
  app: string;
  user: string;
  targetUrl: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'infra-error';
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  verdict?: 'pass' | 'fail' | 'unclear' | 'error';
  summary?: string;
  exitCode?: number;
}

export default function ScenariosTab() {
  const { user } = useAuth();
  const [data, setData] = useState<ScenariosData | null>(null);
  const [poOwned, setPoOwned] = useState<PoScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterApp, setFilterApp] = useState<string>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingScenario, setEditingScenario] = useState<PoScenario | null>(null);

  const isPO = user?.productOwnerOf && (user.productOwnerOf === '*' || (user.productOwnerOf as string[]).length > 0);
  const poApps: string[] = user?.productOwnerOf === '*' ? [] : (user?.productOwnerOf as string[] | undefined) ?? [];

  const fetchData = useCallback(async () => {
    if (window.__cuiServerAlive === false) return;
    try {
      const [scenRes, poRes] = await Promise.all([
        resilientFetch('/api/qa/scenarios'),
        resilientFetch('/api/qa/po-scenarios'),
      ]);
      if (scenRes.ok) setData(await scenRes.json());
      if (poRes.ok) {
        const poData = await poRes.json();
        setPoOwned(poData.owned ?? []);
      }
    } catch (err) {
      console.warn('[QAScenarios] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => window.removeEventListener('cui-reconnected', onReconnect);
  }, [fetchData]);

  const handleArchive = async (scenario: PoScenario) => {
    if (!confirm(`"${scenario.name}" archivieren?`)) return;
    try {
      const res = await fetch(`/api/qa/po-scenarios/${scenario.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: scenario.system }),
      });
      if (!res.ok) throw new Error(await res.text());
      fetchData();
    } catch (err: any) {
      alert(`Archivierung fehlgeschlagen: ${err.message}`);
    }
  };

  const handleStartTest = async (scenario: PoScenario) => {
    const ok = confirm(
      `Test "${scenario.name}" jetzt starten?\n\n` +
      `Ziel-URL: ${scenario.target_url}\n\n` +
      `Der Tester (Container) öffnet die URL, prüft sie aus deiner Persona-Sicht und liefert ein Urteil. Dauer: meist 1–3 Minuten.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/qa/po-scenarios/${scenario.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: scenario.system }),
      });
      if (!res.ok) throw new Error(await res.text());
      fetchData();
    } catch (err: any) {
      alert(`Test konnte nicht gestartet werden: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
        Loading...
      </div>
    );
  }

  const teamScenarios = data?.scenarios ?? [];
  const apps = Array.from(new Set([...teamScenarios.map(s => s.app), ...poOwned.map(s => s.system)])).sort();

  const filteredTeam = filterApp === 'all'
    ? teamScenarios
    : teamScenarios.filter(s => s.app === filterApp);

  const filteredOwned = (showArchived ? poOwned : poOwned.filter(s => !s.archived))
    .filter(s => filterApp === 'all' || s.system === filterApp);

  return (
    <div style={{ padding: 16, overflow: 'auto' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 8 }}>
        <div style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Filter:
          </span>
          <button
            onClick={() => setFilterApp('all')}
            style={filterBtnStyle(filterApp === 'all')}
          >
            All ({teamScenarios.length + poOwned.filter(s => !s.archived).length})
          </button>
          {apps.map(app => (
            <button
              key={app}
              onClick={() => setFilterApp(app)}
              style={filterBtnStyle(filterApp === app)}
            >
              {app} ({
                teamScenarios.filter(s => s.app === app).length +
                poOwned.filter(s => s.system === app && !s.archived).length
              })
            </button>
          ))}
        </div>

        {isPO && (
          <button
            onClick={() => { setEditingScenario(null); setWizardOpen(true); }}
            style={{
              background: 'var(--tn-blue)',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            + Neuer Test
          </button>
        )}
      </div>

      {/* Meine Tests (PO-owned) */}
      {isPO && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Meine Tests ({filteredOwned.length})
            </span>
            {poOwned.some(s => s.archived) && (
              <button
                onClick={() => setShowArchived(v => !v)}
                style={{ ...filterBtnStyle(showArchived), fontSize: 10 }}
              >
                {showArchived ? 'Archivierte ausblenden' : 'Archivierte zeigen'}
              </button>
            )}
          </div>

          {filteredOwned.length === 0 ? (
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'var(--tn-bg-dark)', border: '1px dashed var(--tn-border)', color: 'var(--tn-text-muted)', fontSize: 12 }}>
              Noch keine eigenen Tests. Klicke auf "+ Neuer Test" um deinen ersten Test zu erstellen.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {filteredOwned.map(scenario => (
                <PoScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  onEdit={() => { setEditingScenario(scenario); setWizardOpen(true); }}
                  onArchive={() => handleArchive(scenario)}
                  onStartTest={() => handleStartTest(scenario)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Divider */}
      {isPO && filteredTeam.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Team-Tests (read-only)
          </span>
        </div>
      )}

      {/* Team Scenarios Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {filteredTeam.map(scenario => (
          <div
            key={`${scenario.app}-${scenario.id}`}
            style={{
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 8,
              padding: 14,
              transition: 'transform 0.15s, border-color 0.15s',
              cursor: 'default',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02)'; e.currentTarget.style.borderColor = 'var(--tn-blue)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.borderColor = 'var(--tn-border)'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <StatusBadge status={scenario.status} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 2, fontFamily: 'monospace' }}>
                  {scenario.name}
                </div>
                <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                  {scenario.app}
                  {isPO && <span style={{ marginLeft: 6, color: 'var(--tn-text-muted)', opacity: 0.7 }}>Team-Test</span>}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 10 }}>
              <div>ID: <code style={{ fontFamily: 'monospace', color: 'var(--tn-text)' }}>{scenario.id}</code></div>
              {scenario.lastRun && <div>Last Run: {new Date(scenario.lastRun).toLocaleDateString()}</div>}
            </div>
            <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace', background: 'rgba(30, 45, 74, 0.3)', padding: 6, borderRadius: 4, marginTop: 8 }}>
              scenarios/{scenario.app}/{scenario.id}.json
            </div>
          </div>
        ))}
      </div>

      {/* Empty State */}
      {filteredTeam.length === 0 && filteredOwned.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
          No scenarios found for filter: {filterApp}
        </div>
      )}

      {/* Wizard Modal */}
      {wizardOpen && (
        <ScenarioWizard
          initialData={editingScenario}
          scopeApps={user?.productOwnerOf === '*' ? 'all' : poApps}
          onClose={() => setWizardOpen(false)}
          onSuccess={() => { setWizardOpen(false); fetchData(); }}
        />
      )}
    </div>
  );
}

function filterBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'var(--tn-blue)' : 'transparent',
    border: '1px solid var(--tn-border)',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    color: active ? '#fff' : 'var(--tn-text-muted)',
    cursor: 'pointer',
    fontWeight: 600,
  };
}

function PoScenarioCard({ scenario, onEdit, onArchive, onStartTest }: { scenario: PoScenario; onEdit: () => void; onArchive: () => void; onStartTest: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div style={{
      background: 'var(--tn-bg-dark)',
      border: `1px solid ${scenario.archived ? 'var(--tn-border)' : 'var(--tn-blue)'}`,
      borderRadius: 8,
      padding: 14,
      opacity: scenario.archived ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              background: scenario.archived ? 'rgba(150,150,150,0.15)' : 'rgba(122, 162, 247, 0.15)',
              color: scenario.archived ? 'var(--tn-text-muted)' : 'var(--tn-blue)',
              padding: '2px 6px',
              borderRadius: 3,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}>
              {scenario.archived ? 'Archiviert' : 'Mein Test'}
            </span>
            <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              {scenario.system}
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
            {scenario.name}
          </div>
        </div>
      </div>

      {scenario.description && (
        <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
          {scenario.description}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 10 }}>
        <div>Persona: {scenario.tester?.perspektive?.slice(0, 60)}{(scenario.tester?.perspektive?.length ?? 0) > 60 ? '…' : ''}</div>
        <div>Ziele: {scenario.ziele?.length ?? 0}</div>
        {scenario.target_url && (
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>URL: {scenario.target_url}</div>
        )}
        <div>Erstellt: {new Date(scenario.created_at).toLocaleDateString()}</div>
      </div>

      {!scenario.archived && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            onClick={onEdit}
            style={{
              background: 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Bearbeiten
          </button>
          <button
            onClick={onArchive}
            style={{
              background: 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Archivieren
          </button>
          <button
            onClick={onStartTest}
            style={{
              background: 'var(--tn-green)',
              border: 'none',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            ▶ Test starten
          </button>
          <button
            onClick={() => setHistoryOpen(v => !v)}
            style={{
              background: 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {historyOpen ? '▲ Verlauf' : '▼ Verlauf'}
          </button>
        </div>
      )}

      {historyOpen && !scenario.archived && (
        <RunHistoryPanel scenarioId={scenario.id} system={scenario.system} />
      )}
    </div>
  );
}

function RunHistoryPanel({ scenarioId, system }: { scenarioId: string; system: string }) {
  const [runs, setRuns] = useState<PoRunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: any;

    const fetchRuns = async () => {
      try {
        const res = await fetch(`/api/qa/po-scenarios/${scenarioId}/runs?system=${encodeURIComponent(system)}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (cancelled) return;
        setRuns(data.runs ?? []);
        setLoading(false);
        // Poll while any run is queued or running
        const hasActive = (data.runs ?? []).some((r: PoRunRecord) => r.status === 'queued' || r.status === 'running');
        if (hasActive && !cancelled) {
          timer = setTimeout(fetchRuns, 5000);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    fetchRuns();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [scenarioId, system]);

  if (loading) {
    return <div style={{ marginTop: 10, fontSize: 11, color: 'var(--tn-text-muted)' }}>Lade Verlauf…</div>;
  }
  if (runs.length === 0) {
    return <div style={{ marginTop: 10, fontSize: 11, color: 'var(--tn-text-muted)' }}>Noch keine Test-Läufe.</div>;
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--tn-border)', paddingTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        Letzte Läufe ({runs.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.slice(0, 5).map(run => (
          <RunRow key={run.runId} run={run} system={system} scenarioId={scenarioId} />
        ))}
      </div>
    </div>
  );
}

function RunRow({ run, system, scenarioId }: { run: PoRunRecord; system: string; scenarioId: string }) {
  const [expanded, setExpanded] = useState(false);
  const ts = run.startedAt || run.enqueuedAt;
  return (
    <div style={{ background: 'rgba(30, 45, 74, 0.3)', borderRadius: 4, padding: 8 }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11 }}
      >
        <RunStatusBadge run={run} />
        <div style={{ flex: 1, color: 'var(--tn-text)' }}>
          {ts ? new Date(ts).toLocaleString() : '—'}
          {run.durationSeconds != null && (
            <span style={{ marginLeft: 6, color: 'var(--tn-text-muted)' }}>
              ({run.durationSeconds}s)
            </span>
          )}
        </div>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--tn-text-muted)', lineHeight: 1.5 }}>
          {run.summary && <div style={{ color: 'var(--tn-text)', marginBottom: 4 }}>{run.summary}</div>}
          <div>Run-ID: <code style={{ fontFamily: 'monospace' }}>{run.runId}</code></div>
          <div>Status: <code style={{ fontFamily: 'monospace' }}>{run.status}</code>{run.verdict && ` · Verdict: ${run.verdict}`}</div>
          {run.exitCode != null && <div>Exit: {run.exitCode}</div>}
          {run.status === 'completed' && (
            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <a
                href={`/api/qa/po-scenarios/${scenarioId}/runs/${run.runId}/report/screenshot.png?system=${encodeURIComponent(system)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: 'var(--tn-blue)', textDecoration: 'underline' }}
              >
                Screenshot
              </a>
              <a
                href={`/api/qa/po-scenarios/${scenarioId}/runs/${run.runId}/report/result.json?system=${encodeURIComponent(system)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: 'var(--tn-blue)', textDecoration: 'underline' }}
              >
                result.json
              </a>
              <a
                href={`/api/qa/po-scenarios/${scenarioId}/runs/${run.runId}/report/page-text.txt?system=${encodeURIComponent(system)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: 'var(--tn-blue)', textDecoration: 'underline' }}
              >
                page-text
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunStatusBadge({ run }: { run: PoRunRecord }) {
  let bg = 'rgba(150, 150, 150, 0.15)';
  let color = 'var(--tn-text-muted)';
  let label: string = run.status;
  if (run.status === 'queued') { bg = 'rgba(150,150,150,0.15)'; color = 'var(--tn-text-muted)'; label = '⏳ wartet'; }
  else if (run.status === 'running') { bg = 'rgba(122, 162, 247, 0.15)'; color = 'var(--tn-blue)'; label = '↻ läuft'; }
  else if (run.status === 'completed' && run.verdict === 'pass') { bg = 'rgba(158, 206, 106, 0.15)'; color = 'var(--tn-green)'; label = '✓ pass'; }
  else if (run.status === 'completed' && run.verdict === 'fail') { bg = 'rgba(236, 72, 153, 0.15)'; color = 'var(--tn-red)'; label = '✗ fail'; }
  else if (run.status === 'completed') { bg = 'rgba(224, 175, 104, 0.15)'; color = 'var(--tn-orange)'; label = `~ ${run.verdict ?? 'unclear'}`; }
  else if (run.status === 'failed' || run.status === 'infra-error') { bg = 'rgba(236, 72, 153, 0.15)'; color = 'var(--tn-red)'; label = '✗ fehler'; }
  else if (run.status === 'timeout') { bg = 'rgba(224, 175, 104, 0.15)'; color = 'var(--tn-orange)'; label = '⏱ timeout'; }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, background: bg, color, padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; label: string }> = {
    PASS: { bg: 'rgba(158, 206, 106, 0.15)', text: 'var(--tn-green)', label: '✓' },
    passed: { bg: 'rgba(158, 206, 106, 0.15)', text: 'var(--tn-green)', label: '✓' },
    FAIL: { bg: 'rgba(236, 72, 153, 0.15)', text: 'var(--tn-red)', label: '✗' },
    ERROR: { bg: 'rgba(236, 72, 153, 0.15)', text: 'var(--tn-red)', label: '✗' },
    failed: { bg: 'rgba(236, 72, 153, 0.15)', text: 'var(--tn-red)', label: '✗' },
    PARTIAL: { bg: 'rgba(224, 175, 104, 0.15)', text: 'var(--tn-orange)', label: '~' },
    PENDING: { bg: 'rgba(150, 150, 150, 0.15)', text: 'var(--tn-text-muted)', label: '—' },
    running: { bg: 'rgba(122, 162, 247, 0.15)', text: 'var(--tn-blue)', label: '↻' },
    'never-run': { bg: 'rgba(150, 150, 150, 0.15)', text: 'var(--tn-text-muted)', label: '—' },
    unknown: { bg: 'rgba(150, 150, 150, 0.15)', text: 'var(--tn-text-muted)', label: '?' },
  };
  const style = colors[status] || colors.unknown;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, background: style.bg, color: style.text, padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace' }}>
      {style.label}
    </span>
  );
}

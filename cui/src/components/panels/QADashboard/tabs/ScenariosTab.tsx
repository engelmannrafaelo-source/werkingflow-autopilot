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
  created_by: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
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

function PoScenarioCard({ scenario, onEdit, onArchive }: { scenario: PoScenario; onEdit: () => void; onArchive: () => void }) {
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
        <div>Erstellt: {new Date(scenario.created_at).toLocaleDateString()}</div>
      </div>

      {!scenario.archived && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
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
            disabled
            title="Kommt in Phase 4"
            style={{
              background: 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--tn-text-muted)',
              cursor: 'not-allowed',
              fontWeight: 600,
              opacity: 0.4,
            }}
          >
            Test starten
          </button>
        </div>
      )}
    </div>
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

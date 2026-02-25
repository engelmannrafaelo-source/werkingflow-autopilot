import React, { useState, useEffect, useCallback } from 'react';

const API = '/api';

interface PendingEntry {
  index: number;
  timestamp: string;
  persona: string;
  file: string;
  summary: string;
  stage?: 'draft' | 'review' | 'approval';
  ageDays?: number;
}

interface DiffData {
  pending: string;
  final: string;
}

export default function BusinessApprovalPanel() {
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [selected, setSelected] = useState<PendingEntry | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [processing, setProcessing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`${API}/agents/business/pending`).then(r => r.json());
      const entries = (d.pending ?? []).map((entry: any) => {
        const ageMs = Date.now() - new Date(entry.timestamp).getTime();
        const ageDays = Math.floor(ageMs / 86400000);

        // Determine stage based on age
        let stage: 'draft' | 'review' | 'approval' = 'draft';
        if (ageDays >= 3) stage = 'approval';
        else if (ageDays >= 1) stage = 'review';

        return { ...entry, ageDays, stage };
      });
      setPending(entries);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  async function selectEntry(entry: PendingEntry) {
    setSelected(entry);
    setDiff(null);
    try {
      const filePath = entry.file.replace('/root/projekte/werkingflow/business/', '');
      const d = await fetch(`${API}/agents/business/diff/${filePath}`).then(r => r.json());
      setDiff(d);
    } catch { setDiff({ pending: 'Fehler beim Laden', final: '' }); }
  }

  async function approve(index: number) {
    setProcessing(index);
    try {
      await fetch(`${API}/agents/business/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      await load();
      setSelected(null);
      setDiff(null);
    } finally {
      setProcessing(null);
    }
  }

  async function reject(index: number) {
    setProcessing(index);
    try {
      await fetch(`${API}/agents/business/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      await load();
      setSelected(null);
      setDiff(null);
    } finally {
      setProcessing(null);
    }
  }

  if (pending.length === 0) {
    return (
      <div style={{ padding: '12px', textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        <div style={{ marginBottom: 8, fontSize: 32 }}>✓</div>
        Keine ausstehenden Business-Änderungen.
      </div>
    );
  }

  // Group by stage
  const byStage = {
    draft: pending.filter(p => p.stage === 'draft'),
    review: pending.filter(p => p.stage === 'review'),
    approval: pending.filter(p => p.stage === 'approval')
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Pipeline Visualization */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 10 }}>
          📋 Approval Pipeline ({pending.length} total)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Draft */}
          <PipelineStage
            label="Draft"
            count={byStage.draft.length}
            color="#6366f1"
            icon="📝"
          />
          <div style={{ width: 20, height: 2, background: 'var(--tn-border)' }} />

          {/* Review */}
          <PipelineStage
            label="Review"
            count={byStage.review.length}
            color="#0ea5e9"
            icon="👀"
          />
          <div style={{ width: 20, height: 2, background: 'var(--tn-border)' }} />

          {/* Approval */}
          <PipelineStage
            label="Approval"
            count={byStage.approval.length}
            color="#f59e0b"
            icon="⚠️"
          />
          <div style={{ width: 20, height: 2, background: 'var(--tn-border)' }} />

          {/* Complete */}
          <PipelineStage
            label="Complete"
            count={0}
            color="#10b981"
            icon="✓"
          />
        </div>
      </div>

      {/* Main Content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: List */}
        <div style={{ width: selected ? '35%' : '100%', borderRight: selected ? '1px solid var(--tn-border)' : 'none', overflowY: 'auto', padding: '8px' }}>
          {pending.map(entry => (
          <div
            key={entry.index}
            onClick={() => selectEntry(entry)}
            style={{
              padding: '8px 10px',
              marginBottom: 6,
              borderRadius: 6,
              border: '1px solid',
              borderColor: selected?.index === entry.index ? 'var(--tn-purple)' : 'var(--tn-border)',
              background: selected?.index === entry.index ? 'rgba(124,58,237,0.15)' : 'var(--tn-bg)',
              cursor: 'pointer',
              borderLeft: `3px solid ${getStageColor(entry.stage)}`
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>
                {entry.file.replace('/root/projekte/werkingflow/business/', '')}
              </div>
              {entry.ageDays !== undefined && entry.ageDays > 0 && (
                <div style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  borderRadius: 3,
                  background: entry.ageDays > 3 ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                  color: entry.ageDays > 3 ? '#f87171' : '#fbbf24',
                  fontWeight: 600
                }}>
                  {entry.ageDays}d
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>{entry.summary}</div>
            <div style={{ display: 'flex', gap: 6, fontSize: 9, alignItems: 'center' }}>
              <span style={{
                padding: '2px 6px',
                borderRadius: 3,
                background: `${getStageColor(entry.stage)}20`,
                color: getStageColor(entry.stage),
                fontWeight: 600,
                textTransform: 'uppercase'
              }}>
                {getStageName(entry.stage)}
              </span>
              <span style={{ color: 'var(--tn-cyan)' }}>{entry.persona}</span>
              <span style={{ color: 'var(--tn-text-muted)' }}>· {new Date(entry.timestamp).toLocaleString('de-AT', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        ))}
        </div>

        {/* Right: Diff */}
        {selected && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--tn-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>
                {selected.file.replace('/root/projekte/werkingflow/business/', '')}
              </div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>{selected.summary}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => reject(selected.index)}
                disabled={processing === selected.index}
                style={{
                  padding: '5px 12px',
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'rgba(239,68,68,0.2)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239,68,68,0.4)',
                  borderRadius: 4,
                  cursor: processing === selected.index ? 'not-allowed' : 'pointer',
                  opacity: processing === selected.index ? 0.5 : 1,
                }}
              >✗ Ablehnen</button>
              <button
                onClick={() => approve(selected.index)}
                disabled={processing === selected.index}
                style={{
                  padding: '5px 12px',
                  fontSize: 11,
                  fontWeight: 700,
                  background: 'rgba(124,58,237,0.25)',
                  color: '#e9d5ff',
                  border: '1px solid rgba(124,58,237,0.5)',
                  borderRadius: 4,
                  cursor: processing === selected.index ? 'not-allowed' : 'pointer',
                  opacity: processing === selected.index ? 0.5 : 1,
                }}
              >✓ Freigeben</button>
            </div>
          </div>

          {/* Diff View */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', background: 'var(--tn-bg)' }}>
            {diff ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {diff.final && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>Aktuell (Final)</div>
                    <pre style={{ margin: 0, padding: '8px 10px', background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6, fontSize: 10, lineHeight: 1.6, color: 'var(--tn-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>{diff.final}</pre>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-green)', marginBottom: 4, textTransform: 'uppercase' }}>Neu (Pending)</div>
                  <pre style={{ margin: 0, padding: '8px 10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 6, fontSize: 10, lineHeight: 1.6, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflowY: 'auto' }}>{diff.pending}</pre>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: '20px' }}>Lade Diff...</div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// Helper: Pipeline Stage Component
function PipelineStage({ label, count, color, icon }: { label: string; count: number; color: string; icon: string }) {
  return (
    <div style={{
      padding: '8px 12px',
      borderRadius: 6,
      background: count > 0 ? `${color}20` : 'var(--tn-bg-dark)',
      border: `1px solid ${count > 0 ? color : 'var(--tn-border)'}`,
      minWidth: 100,
      textAlign: 'center'
    }}>
      <div style={{ fontSize: 16, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 10, fontWeight: 600, color: count > 0 ? color : 'var(--tn-text-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: count > 0 ? color : 'var(--tn-text-muted)', marginTop: 2 }}>
        {count}
      </div>
    </div>
  );
}

// Helper: Get stage color
function getStageColor(stage?: string): string {
  switch (stage) {
    case 'draft': return '#6366f1';
    case 'review': return '#0ea5e9';
    case 'approval': return '#f59e0b';
    default: return 'var(--tn-text-muted)';
  }
}

// Helper: Get stage name
function getStageName(stage?: string): string {
  switch (stage) {
    case 'draft': return 'Draft';
    case 'review': return 'Review';
    case 'approval': return 'Approval';
    default: return 'Unknown';
  }
}

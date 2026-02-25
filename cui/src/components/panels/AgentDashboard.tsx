import { useState, useEffect, useCallback } from 'react';

const API = '/api';

// --- Types ---
interface AgentStatus {
  id: string;
  persona_id: string;
  persona_name: string;
  schedule: string;
  status: 'idle' | 'working' | 'error';
  last_run: string | null;
  last_actions: number;
  last_action_types: string[];
  last_trigger: string | null;
  next_run: string;
  has_pending_approvals: boolean;
  approvals_count: number;
  inbox_count: number;
}

interface MemoryEntry {
  timestamp: string;
  trigger: string;
  actions: number;
  action_types: string[];
  response_preview: string;
}

interface InboxMessage {
  from: string;
  date: string;
  body: string;
}

interface Approval {
  index: number;
  timestamp: string;
  persona: string;
  type: 'bash' | 'write';
  payload: string;
}

// --- Helpers ---
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffH = (now.getTime() - d.getTime()) / 3600000;
  if (diffH < 1) return `vor ${Math.round(diffH * 60)}min`;
  if (diffH < 24) return `vor ${Math.round(diffH)}h`;
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusDot(status: AgentStatus['status']) {
  const colors: Record<string, string> = {
    idle: 'var(--tn-status-idle)',
    working: 'var(--tn-status-working)',
    error: 'var(--tn-status-error)',
  };
  const pulse = status === 'working';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colors[status],
        animation: pulse ? 'pulse 2s ease-in-out infinite' : 'none',
        marginRight: 4,
      }}
    />
  );
}

// --- Sub-components ---
function MemoryLog({ personaId }: { personaId: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/agents/memory/${personaId}?n=10`)
      .then(r => r.json())
      .then(d => { setEntries(d.entries ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [personaId]);

  if (loading) return <div className="agent-detail-loading">Lade Memory-Log...</div>;
  if (!entries.length) return <div className="agent-detail-empty">Noch keine Einträge.</div>;

  return (
    <div className="agent-memory-log">
      {entries.map((e, i) => (
        <div key={i} className={`agent-memory-entry ${e.response_preview.startsWith('ERROR') ? 'entry-error' : ''}`}>
          <div className="memory-entry-header">
            <span className="memory-entry-time">{fmtDate(e.timestamp)}</span>
            <span className="memory-entry-trigger">{e.trigger.replace('_', ' ')}</span>
            <span className="memory-entry-actions">
              {e.actions} Aktionen
              {e.action_types.length > 0 && (
                <span className="memory-entry-types">
                  {' '}({e.action_types.join(', ')})
                </span>
              )}
            </span>
          </div>
          {e.response_preview && (
            <div className="memory-entry-preview">
              {e.response_preview.slice(0, 120)}{e.response_preview.length > 120 ? '…' : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InboxView({ personaId }: { personaId: string }) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/agents/inbox/${personaId}`)
      .then(r => r.json())
      .then(d => { setMessages(d.messages ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [personaId]);

  if (loading) return <div className="agent-detail-loading">Lade Inbox...</div>;
  if (!messages.length) return <div className="agent-detail-empty">Keine Nachrichten im Posteingang.</div>;

  return (
    <div className="agent-inbox">
      {messages.map((msg, i) => (
        <div key={i} className="agent-inbox-message">
          <div className="inbox-msg-header">
            <span className="inbox-msg-from">Von: {msg.from}</span>
            <span className="inbox-msg-date">{msg.date}</span>
          </div>
          <div className="inbox-msg-body">{msg.body.slice(0, 300)}{msg.body.length > 300 ? '…' : ''}</div>
        </div>
      ))}
    </div>
  );
}

function ApprovalsView({ onApproved }: { onApproved: () => void }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch(`${API}/agents/approvals`)
      .then(r => r.json())
      .then(d => { setApprovals(d.approvals ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleApprove(index: number, execute: boolean) {
    setProcessing(index);
    try {
      await fetch(`${API}/agents/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, execute }),
      });
      load();
      onApproved();
    } finally {
      setProcessing(null);
    }
  }

  if (loading) return <div className="agent-detail-loading">Lade Approvals...</div>;
  if (!approvals.length) return <div className="agent-detail-empty">✅ Keine ausstehenden Approvals.</div>;

  return (
    <div className="agent-approvals">
      {approvals.map((a) => (
        <div key={a.index} className="agent-approval-item">
          <div className="approval-header">
            <span className="approval-persona">{a.persona}</span>
            <span className={`approval-type approval-type-${a.type}`}>{a.type.toUpperCase()}</span>
            <span className="approval-time">{fmtDate(a.timestamp)}</span>
          </div>
          <pre className="approval-payload">{a.payload.slice(0, 300)}{a.payload.length > 300 ? '\n…' : ''}</pre>
          <div className="approval-actions">
            <button
              className="approval-btn approve"
              disabled={processing === a.index}
              onClick={() => handleApprove(a.index, true)}
            >
              ✓ Genehmigen & Ausführen
            </button>
            <button
              className="approval-btn reject"
              disabled={processing === a.index}
              onClick={() => handleApprove(a.index, false)}
            >
              ✗ Ablehnen
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function BriefView({ personaId }: { personaId: string }) {
  const [briefs, setBriefs] = useState<{ name: string }[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [selectedBrief, setSelectedBrief] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/agents/briefs`)
      .then(r => r.json())
      .then(d => {
        const list = d.briefs ?? [];
        setBriefs(list);
        if (list.length > 0) loadBrief(list[0].name);
        else setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [personaId]);

  function loadBrief(name: string) {
    setLoading(true);
    setSelectedBrief(name);
    fetch(`${API}/agents/brief/${name}`)
      .then(r => r.text())
      .then(text => { setContent(text); setLoading(false); })
      .catch(() => { setContent('Fehler beim Laden.'); setLoading(false); });
  }

  return (
    <div className="agent-brief-view">
      {briefs.length > 1 && (
        <div className="brief-selector">
          {briefs.map(b => (
            <button
              key={b.name}
              className={`brief-tab ${selectedBrief === b.name ? 'active' : ''}`}
              onClick={() => loadBrief(b.name)}
            >
              {b.name.replace('.md', '')}
            </button>
          ))}
        </div>
      )}
      {loading && <div className="agent-detail-loading">Lade Brief...</div>}
      {!loading && !content && <div className="agent-detail-empty">Noch kein Brief vorhanden.</div>}
      {content && (
        <pre className="brief-content">{content}</pre>
      )}
    </div>
  );
}

// --- Agent Card ---
function AgentCard({
  agent,
  isSelected,
  onClick,
  onTrigger,
}: {
  agent: AgentStatus;
  isSelected: boolean;
  onClick: () => void;
  onTrigger: () => void;
}) {
  const [triggering, setTriggering] = useState(false);

  async function handleTrigger(e: React.MouseEvent) {
    e.stopPropagation();
    if (agent.status === 'working' || triggering) return;
    setTriggering(true);
    try {
      await fetch(`${API}/agents/trigger/${agent.id}`, { method: 'POST' });
      onTrigger();
    } finally {
      setTimeout(() => setTriggering(false), 2000);
    }
  }

  const statusText: Record<string, string> = {
    idle: 'Bereit',
    working: 'Läuft...',
    error: 'Fehler',
  };

  return (
    <div
      className={`agent-card ${isSelected ? 'selected' : ''} agent-card-${agent.status}`}
      onClick={onClick}
    >
      <div className="agent-card-header">
        <div className="agent-card-name-block">
          <div className="agent-card-name">
            {statusDot(agent.status)}
            {agent.persona_name}
          </div>
          <div className="agent-card-role">
            {/* Will show role from future data; for now just schedule */}
          </div>
        </div>
        <span className={`agent-status-badge status-${agent.status}`}>
          {statusText[agent.status]}
        </span>
      </div>

      <div className="agent-card-meta">
        <div className="agent-meta-row">
          <span className="agent-meta-label">Letzter Lauf</span>
          <span className="agent-meta-value">
            {fmtDate(agent.last_run)}
            {agent.last_actions > 0 && (
              <span className="agent-meta-actions"> — {agent.last_actions} Aktionen ({agent.last_action_types.join(', ')})</span>
            )}
          </span>
        </div>
        <div className="agent-meta-row">
          <span className="agent-meta-label">Nächster Lauf</span>
          <span className="agent-meta-value">{agent.schedule} ({fmtDate(agent.next_run)})</span>
        </div>
      </div>

      <div className="agent-card-badges">
        {agent.inbox_count > 0 && (
          <span className="agent-badge badge-inbox">📬 {agent.inbox_count} Nachricht{agent.inbox_count !== 1 ? 'en' : ''}</span>
        )}
        {agent.has_pending_approvals && (
          <span className="agent-badge badge-approval">⚠️ {agent.approvals_count} Approval{agent.approvals_count !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="agent-card-actions">
        <button
          className="agent-trigger-btn"
          onClick={handleTrigger}
          disabled={agent.status === 'working' || triggering}
          title={agent.status === 'working' ? 'Agent läuft bereits' : 'Agent jetzt starten'}
        >
          {agent.status === 'working' ? '⏳ Läuft...' : triggering ? '▶ Gestartet' : '▶ Jetzt starten'}
        </button>
      </div>
    </div>
  );
}

// --- Agent Detail ---
function AgentDetail({ agent, onApproved }: { agent: AgentStatus; onApproved: () => void }) {
  const [detailTab, setDetailTab] = useState<'memory' | 'inbox' | 'approvals' | 'brief'>('memory');

  const tabs: { key: typeof detailTab; label: string; badge?: number }[] = [
    { key: 'memory', label: '📜 Memory Log' },
    { key: 'inbox', label: '📬 Inbox', badge: agent.inbox_count || undefined },
    { key: 'approvals', label: '⚠️ Approvals', badge: agent.approvals_count || undefined },
    { key: 'brief', label: '📄 Weekly Brief' },
  ];

  return (
    <div className="agent-detail">
      <div className="agent-detail-header">
        <span className="agent-detail-title">{agent.persona_name}</span>
      </div>

      <div className="agent-detail-tabs">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`agent-detail-tab ${detailTab === t.key ? 'active' : ''}`}
            onClick={() => setDetailTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="agent-detail-body">
        {detailTab === 'memory' && <MemoryLog personaId={agent.persona_id} />}
        {detailTab === 'inbox' && <InboxView personaId={agent.persona_id} />}
        {detailTab === 'approvals' && <ApprovalsView onApproved={onApproved} />}
        {detailTab === 'brief' && <BriefView personaId={agent.persona_id} />}
      </div>
    </div>
  );
}

// --- Main Component ---
export default function AgentDashboard() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [selected, setSelected] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/agents/status`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setAgents(data.agents ?? []);
      setLastRefresh(new Date());
      // Update selected if it changed
      if (selected) {
        const updated = (data.agents ?? []).find((a: AgentStatus) => a.id === selected.id);
        if (updated) setSelected(updated);
      }
    } catch (err) {
      console.error('[AgentDashboard] Status load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  // Initial load + polling
  useEffect(() => {
    loadStatus();
    const isWorking = agents.some(a => a.status === 'working');
    const interval = setInterval(loadStatus, isWorking ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [loadStatus, agents.some(a => a.status === 'working')]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Lade Agent-Status...
      </div>
    );
  }

  if (!agents.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Keine Agenten registriert.
      </div>
    );
  }

  return (
    <div className="agent-dashboard">
      {/* Header */}
      <div className="agent-dashboard-header">
        <span className="agent-dashboard-title">🤖 Autonomes Team</span>
        <span className="agent-dashboard-refresh" onClick={loadStatus} title="Aktualisieren">
          ↻ {lastRefresh.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>

      {/* Body: Agent List + Detail */}
      <div className="agent-dashboard-body">
        {/* Left: Agent Cards */}
        <div className="agent-list">
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isSelected={selected?.id === agent.id}
              onClick={() => setSelected(agent)}
              onTrigger={loadStatus}
            />
          ))}
        </div>

        {/* Right: Detail View */}
        <div className="agent-detail-panel">
          {selected ? (
            <AgentDetail agent={selected} onApproved={loadStatus} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12 }}>
              Agent auswählen für Details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

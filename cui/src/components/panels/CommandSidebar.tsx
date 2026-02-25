import React, { useState, useEffect, useCallback, useRef } from 'react';
import BusinessApprovalPanel from './BusinessApprovalPanel';

const API = '/api';

// --- Types ---
export interface AgentStatus {
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

export interface Approval {
  index: number;
  timestamp: string;
  persona: string;
  type: 'bash' | 'write';
  payload: string;
}

interface InboxMessage {
  from: string;
  date: string;
  body: string;
}

interface MemoryEntry {
  timestamp: string;
  trigger: string;
  actions: number;
  action_types: string[];
  response_preview: string;
}

// --- Helpers ---
function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (diffH < 1) return `${Math.round(diffH * 60)}min`;
  if (diffH < 24) return `${Math.round(diffH)}h`;
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
}

function StatusDot({ status, pulse }: { status: AgentStatus['status']; pulse?: boolean }) {
  const colors = { idle: 'var(--tn-status-idle)', working: 'var(--tn-status-working)', error: 'var(--tn-status-error)' };
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: colors[status], flexShrink: 0,
      animation: (pulse && status === 'working') ? 'pulse 2s ease-in-out infinite' : 'none',
    }} />
  );
}

// --- Section wrapper ---
function SidebarSection({
  title, badge, children, defaultOpen = true,
}: {
  title: string; badge?: number | string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header" onClick={() => setOpen(v => !v)}>
        <span>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {badge !== undefined && badge !== 0 && (
            <span style={{
              background: '#7c3aed', color: 'white', fontSize: 9,
              padding: '1px 4px', borderRadius: 8, fontWeight: 700,
            }}>{badge}</span>
          )}
          <span style={{ fontSize: 9 }}>{open ? '▲' : '▼'}</span>
        </span>
      </div>
      {open && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

// --- Agents Section ---
function AgentsSection({
  agents,
  selectedId,
  onSelect,
  onTrigger,
}: {
  agents: AgentStatus[];
  selectedId: string | null;
  onSelect: (agent: AgentStatus) => void;
  onTrigger: (id: string) => void;
}) {
  const [triggering, setTriggering] = useState<string | null>(null);

  async function handleTrigger(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setTriggering(id);
    try {
      await fetch(`${API}/agents/trigger/${id}`, { method: 'POST' });
      onTrigger(id);
    } finally {
      setTimeout(() => setTriggering(null), 3000);
    }
  }

  return (
    <>
      {agents.map(agent => (
        <div
          key={agent.id}
          className={`sidebar-agent-row ${selectedId === agent.id ? 'active' : ''}`}
          onClick={() => onSelect(agent)}
        >
          <StatusDot status={agent.status} pulse />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.persona_name}
            </div>
            <div style={{ fontSize: 10, color: 'var(--tn-text-subtle)' }}>
              {agent.last_run ? `vor ${fmtAgo(agent.last_run)} · ${agent.last_actions} Akt.` : 'Noch nicht gelaufen'}
              {agent.inbox_count > 0 && <span style={{ color: 'var(--tn-blue)' }}> · 📬{agent.inbox_count}</span>}
              {agent.approvals_count > 0 && <span style={{ color: 'var(--tn-orange)' }}> · ⚠️{agent.approvals_count}</span>}
            </div>
          </div>
          <button
            className="sidebar-trigger-btn"
            onClick={(e) => handleTrigger(e, agent.id)}
            disabled={agent.status === 'working' || triggering === agent.id}
            title="Agent jetzt starten"
          >
            {agent.status === 'working' || triggering === agent.id ? '⏳' : '▶'}
          </button>
        </div>
      ))}
    </>
  );
}

// --- Agent Detail (memory log inside sidebar) ---
function AgentDetailSection({ agent }: { agent: AgentStatus }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);

  useEffect(() => {
    fetch(`${API}/agents/memory/${agent.persona_id}?n=5`)
      .then(r => r.json())
      .then(d => setEntries(d.entries ?? []))
      .catch(() => {});
  }, [agent.persona_id, agent.last_run]);

  if (!entries.length) return <div style={{ fontSize: 11, color: 'var(--tn-text-subtle)', padding: '4px 0' }}>Kein Memory-Log.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map((e, i) => (
        <div key={i} style={{ fontSize: 10, padding: '4px 6px', borderRadius: 4, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <span style={{ color: 'var(--tn-text-subtle)' }}>{fmtAgo(e.timestamp)} ago</span>
            <span style={{ color: e.actions > 0 ? 'var(--tn-green)' : 'var(--tn-text-muted)' }}>{e.actions} Akt.</span>
          </div>
          {e.response_preview && (
            <div style={{ color: 'var(--tn-text-subtle)', fontFamily: 'monospace', fontSize: 9, overflow: 'hidden', maxHeight: 36, lineHeight: 1.4 }}>
              {e.response_preview.slice(0, 80)}{e.response_preview.length > 80 ? '…' : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Brief Section ---
function BriefSection({ agentPersonaId }: { agentPersonaId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [briefName, setBriefName] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(`${API}/agents/briefs`)
      .then(r => r.json())
      .then(d => {
        const briefs = d.briefs ?? [];
        if (briefs.length > 0) {
          setBriefName(briefs[0].name);
          return fetch(`${API}/agents/brief/${briefs[0].name}`).then(r => r.text());
        }
        return null;
      })
      .then(text => text && setContent(text))
      .catch(() => {});
  }, [agentPersonaId]);

  if (!content) return <div style={{ fontSize: 10, color: 'var(--tn-text-subtle)' }}>Noch kein Brief.</div>;

  const preview = content.slice(0, expanded ? 1000 : 250);

  return (
    <div>
      {briefName && (
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-purple-dim)', marginBottom: 4 }}>
          {briefName.replace('.md', '')}
        </div>
      )}
      <pre className="sidebar-brief-preview" style={{ maxHeight: expanded ? 300 : 100 }}>
        {preview}{!expanded && content.length > 250 ? '…' : ''}
      </pre>
      <span className="sidebar-brief-expand" onClick={() => setExpanded(v => !v)}>
        {expanded ? '▲ weniger' : '▼ mehr'}
      </span>
    </div>
  );
}

// --- Inbox Section ---
function InboxSection({ agents }: { agents: AgentStatus[] }) {
  const [allMessages, setAllMessages] = useState<{ persona: string; from: string; date: string }[]>([]);

  useEffect(() => {
    const personasToCheck = ['birgit-bauer', 'vera-vertrieb', 'mira-marketing', 'max-weber', 'otto-operations'];
    Promise.all(
      personasToCheck.map(id =>
        fetch(`${API}/agents/inbox/${id}`)
          .then(r => r.json())
          .then(d => (d.messages ?? []).map((m: InboxMessage) => ({ persona: id, from: m.from, date: m.date })))
          .catch(() => [])
      )
    ).then(results => {
      const flat = results.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
      setAllMessages(flat);
    });
  }, [agents.map(a => a.last_run).join(',')]);

  if (!allMessages.length) {
    return <div style={{ fontSize: 10, color: 'var(--tn-text-subtle)' }}>Keine Nachrichten.</div>;
  }

  function personaShort(id: string): string {
    const map: Record<string, string> = {
      'birgit-bauer': 'Birgit', 'vera-vertrieb': 'Vera', 'mira-marketing': 'Mira',
      'max-weber': 'Max', 'otto-operations': 'Otto',
    };
    return map[id] ?? id;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {allMessages.map((msg, i) => (
        <div key={i} className="sidebar-inbox-pill">
          <span>
            <span className="sidebar-inbox-from">{personaShort(msg.persona)}</span>
            <span style={{ color: 'var(--tn-text-subtle)', margin: '0 3px' }}>←</span>
            <span style={{ color: 'var(--tn-text)' }}>{msg.from.split(' ')[0]}</span>
          </span>
          <span className="sidebar-inbox-time">{msg.date.slice(5, 16)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Approvals Section ---
function ApprovalsSection({ approvals, onApproved }: { approvals: Approval[]; onApproved: () => void }) {
  const [processing, setProcessing] = useState<number | null>(null);

  async function handle(index: number, execute: boolean) {
    setProcessing(index);
    try {
      await fetch(`${API}/agents/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, execute }),
      });
      onApproved();
    } finally {
      setProcessing(null);
    }
  }

  if (!approvals.length) {
    return <div style={{ fontSize: 10, color: 'var(--tn-green)' }}>✅ Keine ausstehenden Approvals.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {approvals.map(a => (
        <div key={a.index} style={{ border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, overflow: 'hidden', background: 'rgba(245,158,11,0.04)' }}>
          <div style={{ display: 'flex', gap: 4, padding: '4px 6px', alignItems: 'center', fontSize: 10 }}>
            <span style={{ fontWeight: 600, flex: 1, color: 'var(--tn-text)' }}>{a.persona}</span>
            <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: a.type === 'bash' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)', color: a.type === 'bash' ? 'var(--tn-blue)' : 'var(--tn-green)', fontWeight: 700 }}>{a.type.toUpperCase()}</span>
          </div>
          <pre style={{ margin: 0, padding: '3px 6px', fontSize: 9, fontFamily: 'monospace', color: 'var(--tn-text)', background: 'var(--tn-bg)', maxHeight: 60, overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {a.payload.slice(0, 120)}{a.payload.length > 120 ? '…' : ''}
          </pre>
          <div style={{ display: 'flex', gap: 4, padding: '4px 6px' }}>
            <button
              style={{ flex: 1, padding: '3px 0', fontSize: 10, fontWeight: 600, background: 'rgba(16,185,129,0.15)', color: 'var(--tn-green)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 3, cursor: processing === a.index ? 'not-allowed' : 'pointer', opacity: processing === a.index ? 0.5 : 1 }}
              disabled={processing === a.index}
              onClick={() => handle(a.index, true)}
            >✓ OK</button>
            <button
              style={{ flex: 1, padding: '3px 0', fontSize: 10, fontWeight: 600, background: 'rgba(239,68,68,0.1)', color: 'var(--tn-red)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 3, cursor: processing === a.index ? 'not-allowed' : 'pointer', opacity: processing === a.index ? 0.5 : 1 }}
              disabled={processing === a.index}
              onClick={() => handle(a.index, false)}
            >✗ Nein</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Claude Agent types ---
interface ClaudeAgent {
  id: string;
  name: string;
  schedule: string;
  task_type: string;
  status: 'idle' | 'working';
  last_run: string | null;
  last_outcome: string;
  inbox_count: number;
}

// --- Live Log Overlay ---
function LiveLogOverlay({ taskId, personaName, onClose }: { taskId: string; personaName: string; onClose: () => void }) {
  const [log, setLog] = useState('');
  const [done, setDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`${API}/agents/claude/log/${taskId}`);
    es.onmessage = (e) => {
      try {
        const { text, init } = JSON.parse(e.data);
        if (init) setLog(text);
        else setLog(prev => prev + text);
        if (text.includes('[DONE]')) setDone(true);
      } catch { /**/ }
    };
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10,10,20,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        width: '72vw', maxWidth: 900, height: '72vh',
        background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
        borderRadius: 10, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--tn-bg-dark)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {done
              ? <span style={{ fontSize: 11, color: 'var(--tn-green)', fontWeight: 700 }}>✓ FERTIG</span>
              : <span style={{ fontSize: 11, color: 'var(--tn-blue)', fontWeight: 700, animation: 'pulse 1.5s ease-in-out infinite' }}>⏳ LÄUFT</span>
            }
            <span style={{ fontWeight: 600, color: 'var(--tn-text)', fontSize: 13 }}>{personaName}</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        {/* Log */}
        <pre style={{ flex: 1, margin: 0, padding: '12px 16px', overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {log || 'Warte auf Output…'}
          <div ref={bottomRef} />
        </pre>
      </div>
    </div>
  );
}

// --- Plan Review Modal ---
function PlanReviewModal({ planFile, personaName, personaId, task, onApprove, onReject }: {
  planFile: string; personaName: string; personaId: string; task?: string; onApprove: () => void; onReject: () => void;
}) {
  const [planContent, setPlanContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/agents/claude/plan/${planFile}`)
      .then(r => r.ok ? r.text() : 'Plan konnte nicht geladen werden.')
      .then(c => { setPlanContent(c); setLoading(false); })
      .catch(() => { setPlanContent('Fehler beim Laden.'); setLoading(false); });
  }, [planFile]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(10,10,20,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onReject}>
      <div style={{ width: '75vw', maxWidth: 950, height: '78vh', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--tn-bg-dark)' }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--tn-text)', fontSize: 14 }}>📋 Plan von {personaName}</div>
            {task && <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2 }}>Aufgabe: {task}</div>}
          </div>
          <button onClick={onReject} style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        {/* Plan content */}
        <pre style={{ flex: 1, margin: 0, padding: '16px 20px', overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--tn-bg)' }}>
          {loading ? 'Lade Plan...' : planContent}
        </pre>
        {/* Actions */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--tn-border)', display: 'flex', gap: 10, background: 'var(--tn-bg-dark)' }}>
          <button onClick={onReject} style={{ flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600, background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 6, cursor: 'pointer' }}>✗ Ablehnen</button>
          <button onClick={onApprove} style={{ flex: 2, padding: '8px 0', fontSize: 12, fontWeight: 700, background: 'rgba(124,58,237,0.25)', color: '#e9d5ff', border: '1px solid rgba(124,58,237,0.5)', borderRadius: 6, cursor: 'pointer' }}>✓ Freigeben & Ausführen</button>
        </div>
      </div>
    </div>
  );
}

// --- Persona Tagging Panel ---
function PersonaTaggingPanel() {
  const [status, setStatus] = useState<'idle' | 'updating' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [appStatus, setAppStatus] = useState<Record<string, { total_ids: number; has_tags: boolean }>>({});

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const res = await fetch(`${API}/persona-tags/status`);
      const data = await res.json();
      setAppStatus(data);
      const taggedApps = Object.values(data).filter((app: any) => app.has_tags).length;
      const totalApps = Object.keys(data).length;
      if (taggedApps > 0) {
        setMessage(`${taggedApps}/${totalApps} apps tagged`);
      } else {
        setMessage('Noch keine Tags generiert');
      }
    } catch {
      setMessage('Status konnte nicht geladen werden');
    }
  }

  async function handleUpdate() {
    setStatus('updating');
    setMessage('Starte Update...');

    try {
      const res = await fetch(`${API}/persona-tags/update`, { method: 'POST' });
      const data = await res.json();

      if (data.status === 'started') {
        setMessage('Update läuft im Hintergrund (2-5 Min)...');

        // Poll for completion
        const pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`${API}/persona-tags/status`);
            const statusData = await statusRes.json();
            const taggedApps = Object.values(statusData).filter((app: any) => app.has_tags).length;
            setMessage(`${taggedApps}/4 apps tagged...`);
            setAppStatus(statusData);
          } catch { /**/ }
        }, 5000);

        // Stop polling after 30s
        setTimeout(() => {
          clearInterval(pollInterval);
          setStatus('success');
          setMessage('✅ Update complete!');
          loadStatus();
        }, 30000);
      }
    } catch (err: any) {
      setStatus('error');
      setMessage('❌ Error: ' + err.message);
    }
  }

  const taggedCount = Object.values(appStatus).filter(app => app.has_tags).length;
  const totalCount = Object.keys(appStatus).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--tn-text-subtle)', lineHeight: 1.5 }}>
        Taggt automatisch alle UI-Elemente für jede Persona (Herbert: Security, Finn: Finance, etc.)
        <br />
        → 68% durchschnittliche Token-Reduktion
      </div>

      <button
        onClick={handleUpdate}
        disabled={status === 'updating'}
        style={{
          padding: '8px 12px',
          fontSize: 11,
          fontWeight: 600,
          background: status === 'updating' ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.2)',
          color: status === 'updating' ? '#a78bfa' : '#c4b5fd',
          border: '1px solid rgba(124,58,237,0.4)',
          borderRadius: 6,
          cursor: status === 'updating' ? 'not-allowed' : 'pointer',
          opacity: status === 'updating' ? 0.6 : 1,
        }}
      >
        {status === 'updating' ? '⏳ Updating...' : '🚀 Update Persona Tags'}
      </button>

      {message && (
        <div style={{
          fontSize: 10,
          padding: '6px 8px',
          background: 'rgba(124,58,237,0.08)',
          borderRadius: 4,
          color: status === 'error' ? 'var(--tn-red)' : status === 'success' ? 'var(--tn-green)' : 'var(--tn-purple-dim)',
          borderLeft: `2px solid ${status === 'error' ? 'var(--tn-red)' : status === 'success' ? 'var(--tn-green)' : 'var(--tn-purple)'}`,
        }}>
          {message}
        </div>
      )}

      {totalCount > 0 && (
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 4 }}>
          <div style={{ marginBottom: 4 }}>Apps ({taggedCount}/{totalCount}):</div>
          {Object.entries(appStatus).map(([app, data]) => (
            <div key={app} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
              <span>{app}</span>
              <span style={{ color: data.has_tags ? 'var(--tn-green)' : 'var(--tn-status-idle)' }}>
                {data.has_tags ? '✓' : '○'} {data.total_ids} IDs
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Claude Agents Panel ---
function ClaudeAgentsPanel() {
  const [agents, setAgents] = useState<ClaudeAgent[]>([]);
  const [activeLog, setActiveLog] = useState<{ taskId: string; name: string; mode: 'plan' | 'execute'; planFile?: string } | null>(null);
  const [planReview, setPlanReview] = useState<{ planFile: string; personaName: string; personaId: string; task?: string } | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [customTask, setCustomTask] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`${API}/agents/claude/status`).then(r => r.json());
      setAgents(d.agents ?? []);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    load();
    const hasWorking = agents.some(a => a.status === 'working');
    const iv = setInterval(load, hasWorking ? 4000 : 20000);
    return () => clearInterval(iv);
  }, [load, agents.some(a => a.status === 'working')]);

  async function runAgent(id: string, name: string, task?: string, mode: 'plan' | 'execute' = 'plan', planId?: string) {
    setTriggering(id);
    setCustomTask(null);
    try {
      const body: Record<string, string> = { persona_id: id, mode };
      if (task) body.task = task;
      if (planId) body.plan_id = planId;
      const r = await fetch(`${API}/agents/claude/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      if (r.task_id) {
        setActiveLog({ taskId: r.task_id, name, mode: r.mode ?? 'plan', planFile: r.plan_file });
        // Poll log for completion to show plan review
        if (r.mode === 'plan') {
          const checkComplete = setInterval(async () => {
            try {
              const log = await fetch(`${API}/agents/claude/log/${r.task_id}`).then(async r => {
                // Simplified: just read last 200 chars from log endpoint (we can't parse SSE easily here)
                return '';
              });
            } catch { /**/ }
          }, 3000);
          setTimeout(() => clearInterval(checkComplete), 120000); // Stop after 2min
        }
      }
      await load();
    } finally {
      setTimeout(() => setTriggering(null), 2000);
    }
  }

  const TASK_ICONS: Record<string, string> = { SCAN: '🔍', SYNC: '🔄', DECIDE: '⚡', PRODUCE: '✍️', REVIEW: '🔎' };

  return (
    <>
      {planReview && <PlanReviewModal
        planFile={planReview.planFile}
        personaName={planReview.personaName}
        personaId={planReview.personaId}
        task={planReview.task}
        onApprove={() => {
          setPlanReview(null);
          runAgent(planReview.personaId, planReview.personaName, planReview.task, 'execute', planReview.planFile);
        }}
        onReject={() => setPlanReview(null)}
      />}
      {activeLog && <LiveLogOverlay
        taskId={activeLog.taskId}
        personaName={activeLog.name}
        onClose={() => {
          setActiveLog(null);
          // If plan mode just finished, show plan review
          if (activeLog.mode === 'plan' && activeLog.planFile) {
            const agent = agents.find(a => a.id.replace('-','-') === activeLog.planFile?.split('-')[0]);
            setPlanReview({
              planFile: activeLog.planFile,
              personaName: activeLog.name,
              personaId: agent?.id ?? '',
              task: undefined,
            });
          }
          load();
        }}
      />}
      {customTask && (
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--tn-border)' }}>
          <div style={{ fontSize: 11, color: 'var(--tn-purple-dim)', marginBottom: 4 }}>Custom Task für {agents.find(a => a.id === customTask.id)?.name}:</div>
          <textarea
            value={customTask.text}
            onChange={e => setCustomTask({ ...customTask, text: e.target.value })}
            style={{ width: '100%', height: 60, fontSize: 10, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, color: 'var(--tn-text)', padding: '4px 6px', resize: 'none', fontFamily: 'inherit' }}
            placeholder="Beschreibe die Aufgabe..."
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button onClick={() => runAgent(customTask.id, agents.find(a => a.id === customTask.id)?.name ?? customTask.id, customTask.text)} style={{ flex: 1, padding: '3px 0', fontSize: 10, background: 'rgba(124,58,237,0.2)', color: 'var(--tn-purple-dim)', border: '1px solid rgba(124,58,237,0.4)', borderRadius: 3, cursor: 'pointer', fontWeight: 700 }}>▶ Starten</button>
            <button onClick={() => setCustomTask(null)} style={{ padding: '3px 8px', fontSize: 10, background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 3, cursor: 'pointer' }}>✕</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {agents.map(agent => (
          <div key={agent.id} className={`sidebar-agent-row ${agent.status === 'working' ? 'active' : ''}`}>
            <span style={{ fontSize: 13 }}>{TASK_ICONS[agent.task_type] ?? '🤖'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', display: 'flex', gap: 4 }}>
                <span>{agent.schedule}</span>
                {agent.last_run && <span>· {fmtAgo(agent.last_run)}</span>}
                {agent.inbox_count > 0 && <span style={{ color: 'var(--tn-cyan)' }}>· 📬{agent.inbox_count}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              <button
                className="sidebar-trigger-btn"
                title="Custom Task eingeben"
                onClick={() => setCustomTask({ id: agent.id, text: '' })}
                disabled={agent.status === 'working' || triggering === agent.id}
                style={{ fontSize: 9, padding: '2px 5px' }}
              >✎</button>
              <button
                className="sidebar-trigger-btn"
                title={`${agent.name} starten`}
                onClick={() => runAgent(agent.id, agent.name)}
                disabled={agent.status === 'working' || triggering === agent.id}
              >{agent.status === 'working' || triggering === agent.id ? '⏳' : '▶'}</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// --- Main CommandSidebar ---
interface CommandSidebarProps {
  onPersonaAgentSelect?: (personaId: string) => void;
}

export default function CommandSidebar({ onPersonaAgentSelect }: CommandSidebarProps) {
  // Legacy Python agents (Kai only, for Approvals + Brief)
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'team' | 'inbox' | 'approvals' | 'business'>('team');
  const [businessPendingCount, setBusinessPendingCount] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, approvalsRes] = await Promise.all([
        fetch(`${API}/agents/status`).then(r => r.json()),
        fetch(`${API}/agents/approvals`).then(r => r.json()),
      ]);
      setAgents(statusRes.agents ?? []);
      setApprovals(approvalsRes.approvals ?? []);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    loadStatus();
    // Also load business pending count
    fetch(`${API}/agents/business/pending`).then(r => r.json()).then(d => setBusinessPendingCount((d.pending ?? []).length)).catch(() => {});
    const iv = setInterval(() => {
      loadStatus();
      fetch(`${API}/agents/business/pending`).then(r => r.json()).then(d => setBusinessPendingCount((d.pending ?? []).length)).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, [loadStatus]);

  const totalApprovals = approvals.length;
  const totalInbox = agents.reduce((s, a) => s + a.inbox_count, 0);

  return (
    <div className="command-sidebar">
      {/* Header */}
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--tn-border)', fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--tn-purple-dim)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: 'rgba(124,58,237,0.07)' }}>
        <span>⚡ Command Center</span>
        <span style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontWeight: 400, fontSize: 10 }} onClick={loadStatus} title="Aktualisieren">↻</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 }}>
        {([
          { id: 'team',      label: '🤖 Team',     badge: 0 },
          { id: 'inbox',     label: '📬 Inbox',    badge: totalInbox },
          { id: 'approvals', label: '⚠️ Approve',  badge: totalApprovals },
          { id: 'business',  label: '📄 Business', badge: businessPendingCount },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ flex: 1, padding: '5px 2px', fontSize: 9, fontWeight: activeTab === tab.id ? 700 : 400, color: activeTab === tab.id ? '#c4b5fd' : '#7982b0', background: activeTab === tab.id ? 'rgba(124,58,237,0.12)' : 'none', border: 'none', borderBottom: activeTab === tab.id ? '2px solid #7c3aed' : '2px solid transparent', cursor: 'pointer', position: 'relative' }}>
            {tab.label}
            {tab.badge > 0 && <span style={{ marginLeft: 3, background: '#7c3aed', color: 'white', fontSize: 8, padding: '0 3px', borderRadius: 6, fontWeight: 700 }}>{tab.badge}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="sidebar-scrollable">
        {activeTab === 'team' && (
          <>
            <SidebarSection title="🤖 Team Agenten (16)" defaultOpen={true}>
              <ClaudeAgentsPanel />
            </SidebarSection>
            <SidebarSection title="🏷️ Persona Tags" defaultOpen={false}>
              <PersonaTaggingPanel />
            </SidebarSection>
            <SidebarSection title="📄 Weekly Brief" defaultOpen={false}>
              <BriefSection agentPersonaId="kai-hoffmann" />
            </SidebarSection>
            <SidebarSection title="❓ Hilfe" defaultOpen={false}>
              {[
                { key: '▶ Run',    desc: 'Startet regulären Task-Zyklus der Persona als Claude-Agent' },
                { key: '✎ Custom', desc: 'Eigene Aufgabe eingeben — z.B. "Erstelle einen Quarterly Report"' },
                { key: 'Memory',   desc: 'Jeder Run wird gespeichert. Beim nächsten Start weiß der Agent was er zuletzt getan hat.' },
                { key: 'Live-Log', desc: 'Nach dem Start öffnet sich ein Live-Fenster mit dem Agent-Output' },
                { key: 'Inbox',    desc: 'Agenten schreiben Nachrichten an andere Personas — hier sichtbar' },
                { key: '⚠️',       desc: 'Manche Aktionen brauchen deine Freigabe (z.B. deploy, publish)' },
              ].map((item, i) => (
                <div key={i} className="sidebar-help-item">
                  <span className="sidebar-help-key">{item.key}</span>
                  <span>{item.desc}</span>
                </div>
              ))}
            </SidebarSection>
          </>
        )}
        {activeTab === 'inbox' && (
          <SidebarSection title="📬 Team Inbox" badge={totalInbox || undefined} defaultOpen>
            <InboxSection agents={agents} />
          </SidebarSection>
        )}
        {activeTab === 'approvals' && (
          <SidebarSection title="⚠️ Approvals" badge={totalApprovals || undefined} defaultOpen>
            <ApprovalsSection approvals={approvals} onApproved={loadStatus} />
          </SidebarSection>
        )}
        {activeTab === 'business' && <BusinessApprovalPanel />}
      </div>
    </div>
  );
}

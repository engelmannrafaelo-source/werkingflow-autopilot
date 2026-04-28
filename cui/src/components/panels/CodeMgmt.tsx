/**
 * CodeMgmt — "Drei Welten" code-management dashboard for non-coders.
 *
 * Vocabulary (Bridge research, do not change without re-reading the report):
 *   Live-Version  ← what runs on the shared dev server (origin/develop)
 *   Meine Tests   ← user's local sandbox
 *   Vorschlag     ← packaged proposal sent to the Product Owner
 *   Übernehmen / Ablehnen ← PO/admin decision actions
 *
 * No git jargon. No +/-, no SHAs in primary copy, no branch trees. Linear timeline.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';

// ---------------------------------------------------------------------------
// Types — match server/lib/code-state.ts + proposals-store.ts shapes
// ---------------------------------------------------------------------------

interface CodeStateLive { sha: string; fullSha: string; message: string; authorName: string; date: string; }
interface CodeStateMe { sha: string; ahead: number; behind: number; dirtyFiles: number; inSync: boolean; lastCommitMessage: string; lastCommitDate: string; }
interface TimelineEvent {
  kind: 'live-update' | 'proposal-approved' | 'proposal-rejected' | 'proposal-pending' | 'my-edit';
  at: string; title: string; detail?: string; by?: string; proposalId?: string; sha?: string;
}
interface ProposalMeta {
  id: string; workspace: string;
  authorId: string; authorName: string; authorRole: string;
  title: string; description: string;
  baseSha: string; headSha: string;
  filesChanged: string[]; linesChanged: { added: number; removed: number };
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string; decidedBy?: string; decisionReason?: string;
}
interface CodeState {
  available: boolean; reason?: string;
  workspace: string; userId: string;
  live?: CodeStateLive; me?: CodeStateMe;
  proposalCounts: { pending: number; approved: number; rejected: number; mine: number };
  myProposals: ProposalMeta[];
  timeline: TimelineEvent[];
}
interface SnapshotInfo { ref: string; date: string; subject: string; }

const API = '/api/code-mgmt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtRelative(iso?: string): string {
  if (!iso) return '–';
  const t = Date.parse(iso); if (Number.isNaN(t)) return iso;
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 60) return 'gerade eben';
  if (ago < 3600) return `vor ${Math.floor(ago / 60)} Min.`;
  if (ago < 86400) return `vor ${Math.floor(ago / 3600)} Std.`;
  if (ago < 7 * 86400) return `vor ${Math.floor(ago / 86400)} Tagen`;
  return new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
}

function fmtAbsolute(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CodeMgmt({ workspace }: { workspace: string }) {
  const { user } = useAuth();
  const role = user?.role ?? 'admin';
  const isPO = role === 'admin' || role === 'product-owner';

  const [state, setState] = useState<CodeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProposalDialog, setShowProposalDialog] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [openProposalId, setOpenProposalId] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch(`${API}/state?workspace=${encodeURIComponent(workspace)}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setError(err.error || `HTTP ${r.status}`);
        setState(null);
      } else {
        const data: CodeState = await r.json();
        setState(data); setError(null);
      }
    } catch (e: any) {
      setError(e.message || 'Netzwerk-Fehler');
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { setLoading(true); fetchState(); }, [fetchState]);

  // Light auto-refresh every 30s — keeps "Live-Version" semi-live without spam.
  useEffect(() => {
    const t = setInterval(fetchState, 30000);
    return () => clearInterval(t);
  }, [fetchState]);

  if (loading && !state) return <Card><div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>Lade Code-Stand …</div></Card>;
  if (error) return <Card><div style={{ color: 'var(--tn-red, #f7768e)' }}>Code-Stand nicht verfügbar: {error}</div></Card>;
  if (!state) return null;

  if (!state.available) {
    return (
      <Card>
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>
          <b>Code-Stand nicht verfügbar.</b><br />
          {state.reason || 'Kein Repo gefunden.'}
        </div>
      </Card>
    );
  }

  const me = state.me!;
  const live = state.live!;
  const hasLocalWork = me.ahead > 0 || me.dirtyFiles > 0;

  return (
    <>
      <h2 style={sectionH2Style}>Wo steht der Code?</h2>

      {/* 3-Karten-Dashboard */}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        marginBottom: 16,
      }}>
        <DashboardCard
          title="Live-Version"
          icon="🌐"
          subtitle="Auf dem Server (alle Partner)"
          tone="green"
          body={
            <>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>{live.message || '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                {live.authorName ? `von ${live.authorName} · ` : ''}{fmtRelative(live.date)}
              </div>
            </>
          }
        />

        <DashboardCard
          title="Meine Tests"
          icon="🧪"
          subtitle={me.inSync ? 'Synchron mit Live' : 'Eigene Änderungen'}
          tone={me.inSync ? 'gray' : 'blue'}
          body={
            <>
              {me.inSync ? (
                <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                  Du arbeitest aktuell auf der Live-Version.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                    {me.ahead > 0 && <div>📝 {me.ahead} eigene{me.ahead === 1 ? 'r' : ''} Änderung{me.ahead === 1 ? '' : 'en'}</div>}
                    {me.dirtyFiles > 0 && <div>✏️ {me.dirtyFiles} Datei{me.dirtyFiles === 1 ? '' : 'en'} ungespeichert</div>}
                    {me.behind > 0 && <div style={{ color: 'var(--tn-orange, #ff9e64)' }}>⚠️ {me.behind} Live-Update{me.behind === 1 ? '' : 's'} fehlt dir</div>}
                  </div>
                  {me.lastCommitMessage && (
                    <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 6 }}>
                      Zuletzt: „{me.lastCommitMessage}" · {fmtRelative(me.lastCommitDate)}
                    </div>
                  )}
                </>
              )}
            </>
          }
          footer={
            hasLocalWork ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={btnPrimaryStyle} onClick={() => setShowProposalDialog(true)}>
                  📤 Vorschlag senden
                </button>
                <button style={btnSecondaryStyle} onClick={() => setShowResetDialog(true)} title="Setzt deine Tests zurück und legt vorher einen Snapshot an.">
                  ↺ Zurücksetzen
                </button>
              </div>
            ) : me.behind > 0 ? (
              <div style={{ fontSize: 11, color: 'var(--tn-orange, #ff9e64)' }}>
                Tipp: Sage Claude im Chat „aktualisieren auf den neuesten Stand" — er holt sich die Live-Updates.
              </div>
            ) : null
          }
        />

        <DashboardCard
          title="Vorschläge"
          icon="📬"
          subtitle={isPO ? 'Eingang' : 'Meine'}
          tone={state.proposalCounts.pending > 0 ? 'orange' : 'gray'}
          body={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              {isPO ? (
                <>
                  <div>⏳ {state.proposalCounts.pending} offen</div>
                  <div>✅ {state.proposalCounts.approved} übernommen</div>
                  <div>❌ {state.proposalCounts.rejected} abgelehnt</div>
                </>
              ) : (
                <>
                  <div>📤 {state.proposalCounts.mine} von dir gesendet</div>
                  <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 4 }}>
                    {state.myProposals[0]
                      ? `Letzter: „${state.myProposals[0].title}" · ${state.myProposals[0].status === 'pending' ? 'wird geprüft' : state.myProposals[0].status === 'approved' ? '✅ übernommen' : '❌ abgelehnt'}`
                      : 'Noch keine Vorschläge.'}
                  </div>
                </>
              )}
            </div>
          }
          footer={
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button style={btnSecondaryStyle} onClick={() => setShowInbox(true)}>
                {isPO ? 'Eingang öffnen' : 'Meine Vorschläge'}
              </button>
              {state.timeline.length > 0 && (
                <button style={btnSecondaryStyle} onClick={() => setShowSnapshots(true)} title="Letzte Snapshots deiner Tests.">
                  Snapshots
                </button>
              )}
            </div>
          }
        />
      </div>

      {/* Linear timeline */}
      <Timeline events={state.timeline} onOpenProposal={(id) => setOpenProposalId(id)} />

      {/* Modals */}
      {showProposalDialog && (
        <ProposalDialog
          workspace={workspace}
          onClose={() => setShowProposalDialog(false)}
          onSent={() => { setShowProposalDialog(false); fetchState(); }}
        />
      )}

      {showInbox && (
        <ProposalInbox
          workspace={workspace}
          mineOnly={!isPO}
          isPO={isPO}
          onClose={() => setShowInbox(false)}
          onChanged={() => fetchState()}
          onOpen={(id) => { setShowInbox(false); setOpenProposalId(id); }}
        />
      )}

      {openProposalId && (
        <ProposalDetail
          workspace={workspace}
          proposalId={openProposalId}
          isPO={isPO}
          onClose={() => setOpenProposalId(null)}
          onChanged={() => { setOpenProposalId(null); fetchState(); }}
        />
      )}

      {showResetDialog && (
        <ResetDialog
          onClose={() => setShowResetDialog(false)}
          onReset={() => { setShowResetDialog(false); fetchState(); }}
        />
      )}

      {showSnapshots && (
        <SnapshotsDialog
          onClose={() => setShowSnapshots(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard card
// ---------------------------------------------------------------------------

interface DashboardCardProps {
  title: string;
  icon: string;
  subtitle: string;
  tone: 'green' | 'blue' | 'orange' | 'gray';
  body: React.ReactNode;
  footer?: React.ReactNode;
}

function DashboardCard({ title, icon, subtitle, tone, body, footer }: DashboardCardProps) {
  const accent = tone === 'green' ? 'var(--tn-green, #9ece6a)'
    : tone === 'blue' ? 'var(--tn-blue, #7aa2f7)'
    : tone === 'orange' ? 'var(--tn-orange, #ff9e64)'
    : 'var(--tn-text-muted, #565f89)';

  return (
    <div style={{
      background: 'var(--tn-bg-elevated, #1a1b26)',
      border: '1px solid var(--tn-border, #292e42)',
      borderTop: `3px solid ${accent}`,
      borderRadius: 6,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
      minHeight: 130,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-text, #c0caf5)' }}>
          <span style={{ marginRight: 6 }}>{icon}</span>{title}
        </div>
        <div style={{ fontSize: 10, color: accent, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {subtitle}
        </div>
      </div>
      <div style={{ flex: 1 }}>{body}</div>
      {footer && <div>{footer}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Timeline({ events, onOpenProposal }: { events: TimelineEvent[]; onOpenProposal: (id: string) => void }) {
  if (events.length === 0) {
    return (
      <Card>
        <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)' }}>
          Verlauf der letzten 7 Tage erscheint hier — sobald die Live-Version aktualisiert wird oder Vorschläge eingereicht werden.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Verlauf (letzte 7 Tage)">
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {events.map((ev, i) => {
          const { color, label, icon } = timelineDecor(ev.kind);
          const clickable = !!ev.proposalId;
          return (
            <li key={i} style={{
              display: 'grid',
              gridTemplateColumns: '20px 1fr auto',
              gap: 10, padding: '8px 0',
              borderBottom: i < events.length - 1 ? '1px solid var(--tn-border, #292e42)' : 'none',
              cursor: clickable ? 'pointer' : 'default',
            }}
              onClick={() => { if (clickable) onOpenProposal(ev.proposalId!); }}
            >
              <div style={{ color, fontSize: 14 }}>{icon}</div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--tn-text, #c0caf5)' }}>
                  <span style={{ color, fontWeight: 500 }}>{label}: </span>
                  {ev.title}
                  {ev.by && <span style={{ color: 'var(--tn-text-muted, #a9b1d6)', fontWeight: 400 }}> · {ev.by}</span>}
                </div>
                {ev.detail && (
                  <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 2 }}>
                    {ev.detail.length > 140 ? ev.detail.slice(0, 140) + '…' : ev.detail}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #565f89)', whiteSpace: 'nowrap' }}>
                {fmtRelative(ev.at)}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function timelineDecor(kind: TimelineEvent['kind']): { color: string; label: string; icon: string } {
  switch (kind) {
    case 'live-update':       return { color: 'var(--tn-green, #9ece6a)',   label: 'Live-Update',         icon: '●' };
    case 'proposal-pending':  return { color: 'var(--tn-orange, #ff9e64)',  label: 'Vorschlag eingereicht', icon: '◯' };
    case 'proposal-approved': return { color: 'var(--tn-green, #9ece6a)',   label: 'Vorschlag übernommen',  icon: '✓' };
    case 'proposal-rejected': return { color: 'var(--tn-red, #f7768e)',     label: 'Vorschlag abgelehnt',   icon: '✕' };
    case 'my-edit':           return { color: 'var(--tn-blue, #7aa2f7)',    label: 'Eigene Änderung',       icon: '✎' };
  }
}

// ---------------------------------------------------------------------------
// "Vorschlag senden" dialog
// ---------------------------------------------------------------------------

function ProposalDialog({ workspace, onClose, onSent }: {
  workspace: string; onClose: () => void; onSent: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<{ developAhead: number; baseSha: string; liveSha: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (force = false) => {
    if (!title.trim() || !description.trim()) { setError('Titel und Beschreibung sind Pflicht.'); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(`${API}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, title, description, force }),
      });
      const data = await r.json();
      if (r.status === 409 && data.error === 'live-version-changed') {
        setConflict({
          developAhead: data.developAhead,
          baseSha: data.baseSha, liveSha: data.liveSha,
          message: data.message || 'Die Live-Version hat sich verändert.',
        });
        return;
      }
      if (!r.ok) { setError(data.error || data.message || `HTTP ${r.status}`); return; }
      onSent();
    } catch (e: any) { setError(e.message || 'Senden fehlgeschlagen'); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal title="Vorschlag senden" onClose={onClose}>
      {conflict ? (
        <>
          <div style={{ background: 'var(--tn-bg, #16161e)', border: '1px solid var(--tn-orange, #ff9e64)', borderRadius: 4, padding: 10, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--tn-orange, #ff9e64)' }}>⚠️ Live-Version hat sich verändert</div>
            <div style={{ fontSize: 12 }}>{conflict.message}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 16 }}>
            Du kannst den Vorschlag <b>trotzdem senden</b> — der Product Owner sieht dann beide Stände
            und entscheidet. Oder du sagst Claude im Chat „aktualisieren auf den neuesten Stand", testest
            erneut und sendest dann.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={btnSecondaryStyle} onClick={onClose}>Abbrechen</button>
            <button style={btnPrimaryStyle} onClick={() => submit(true)} disabled={submitting}>
              Trotzdem senden
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Worum geht's? (Titel)</label>
            <input
              type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="z. B. Lärmkarte zeigt jetzt auch Hintergrund-Geräusche"
              style={inputStyle} autoFocus disabled={submitting}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Was hast du geändert und warum?</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder={'Beschreibe in 2–3 Sätzen, was an deinen Tests anders ist und welches Problem das löst.\n\nBeispiel:\nIch habe die Lärm-Berechnung erweitert, sodass sie auch Verkehrsgeräusche aus angrenzenden Straßen mit-einrechnet.\nVorher: nur die Hauptstraße.\nDas Ergebnis ist realistischer für Wohngebiete.'}
              rows={7} style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }} disabled={submitting}
            />
          </div>
          {error && <div style={{ color: 'var(--tn-red, #f7768e)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #565f89)', marginBottom: 12 }}>
            Beim Senden wird ein Schnappschuss deiner Tests an den Product Owner geschickt. Deine Test-Umgebung
            bleibt unverändert — du kannst weiter daran arbeiten.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={btnSecondaryStyle} onClick={onClose} disabled={submitting}>Abbrechen</button>
            <button style={btnPrimaryStyle} onClick={() => submit(false)} disabled={submitting}>
              {submitting ? 'Sende …' : 'Senden'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Proposal Inbox
// ---------------------------------------------------------------------------

function ProposalInbox({ workspace, mineOnly, isPO, onClose, onChanged: _onChanged, onOpen }: {
  workspace: string; mineOnly: boolean; isPO: boolean;
  onClose: () => void; onChanged: () => void; onOpen: (id: string) => void;
}) {
  const [proposals, setProposals] = useState<ProposalMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>(isPO ? 'pending' : 'all');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ workspace });
    if (mineOnly) params.set('mine', '1');
    if (filter !== 'all') params.set('status', filter);
    try {
      const r = await fetch(`${API}/proposals?${params}`);
      const data = await r.json();
      setProposals(data.proposals || []);
    } finally { setLoading(false); }
  }, [workspace, mineOnly, filter]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const title = mineOnly ? 'Meine Vorschläge' : 'Vorschläge — Eingang';

  return (
    <Modal title={title} onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected', 'all'] as const).map(f => (
          <button key={f}
            style={f === filter ? btnPrimaryStyle : btnSecondaryStyle}
            onClick={() => setFilter(f)}>
            {f === 'pending' ? 'Offen' : f === 'approved' ? 'Übernommen' : f === 'rejected' ? 'Abgelehnt' : 'Alle'}
          </button>
        ))}
      </div>
      {loading ? (
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>Lade Vorschläge …</div>
      ) : proposals.length === 0 ? (
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)', padding: '24px 0', textAlign: 'center' }}>
          Keine Vorschläge im Filter <b>{filter}</b>.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '60vh', overflowY: 'auto' }}>
          {proposals.map(p => (
            <li key={p.id}
              onClick={() => onOpen(p.id)}
              style={{
                padding: '10px 12px',
                borderRadius: 4,
                marginBottom: 6,
                background: 'var(--tn-bg-elevated, #1a1b26)',
                border: '1px solid var(--tn-border, #292e42)',
                cursor: 'pointer',
              }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 500, color: 'var(--tn-text, #c0caf5)' }}>{p.title}</div>
                <StatusBadge status={p.status} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 4 }}>
                von {p.authorName} · {fmtRelative(p.createdAt)} · {p.filesChanged.length} Datei{p.filesChanged.length === 1 ? '' : 'en'}
              </div>
              {p.description && (
                <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 4 }}>
                  {p.description.length > 140 ? p.description.slice(0, 140) + '…' : p.description}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Proposal Detail (with side-by-side diff)
// ---------------------------------------------------------------------------

function ProposalDetail({ workspace, proposalId, isPO, onClose, onChanged }: {
  workspace: string; proposalId: string; isPO: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const [proposal, setProposal] = useState<ProposalMeta | null>(null);
  const [patch, setPatch] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/proposals/${encodeURIComponent(workspace)}/${encodeURIComponent(proposalId)}`);
        const data = await r.json();
        setProposal(data.proposal);
        setPatch(data.patch || '');
      } finally { setLoading(false); }
    })();
  }, [workspace, proposalId]);

  const approve = async () => {
    setActing(true); setActionError(null);
    try {
      const r = await fetch(`${API}/proposals/${encodeURIComponent(workspace)}/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) { setActionError(data.message || data.error || `HTTP ${r.status}`); return; }
      onChanged();
    } catch (e: any) { setActionError(e.message); }
    finally { setActing(false); }
  };

  const reject = async () => {
    setActing(true); setActionError(null);
    try {
      const r = await fetch(`${API}/proposals/${encodeURIComponent(workspace)}/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason }),
      });
      const data = await r.json();
      if (!r.ok) { setActionError(data.error || `HTTP ${r.status}`); return; }
      onChanged();
    } catch (e: any) { setActionError(e.message); }
    finally { setActing(false); }
  };

  const fileSegments = useMemo(() => parsePatchToSegments(patch), [patch]);

  return (
    <Modal title={proposal?.title || 'Vorschlag'} onClose={onClose} wide>
      {loading ? (
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>Lade …</div>
      ) : !proposal ? (
        <div style={{ color: 'var(--tn-red, #f7768e)' }}>Vorschlag nicht gefunden.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={proposal.status} />
            <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)' }}>
              von <b>{proposal.authorName}</b> · {fmtAbsolute(proposal.createdAt)}
            </div>
          </div>
          {proposal.description && (
            <div style={{
              background: 'var(--tn-bg, #16161e)', border: '1px solid var(--tn-border, #292e42)',
              borderRadius: 4, padding: 10, marginBottom: 12, fontSize: 12, whiteSpace: 'pre-wrap',
            }}>
              {proposal.description}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #565f89)', marginBottom: 8 }}>
            {proposal.filesChanged.length} Datei{proposal.filesChanged.length === 1 ? '' : 'en'} betroffen
          </div>

          <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: 12 }}>
            {fileSegments.length === 0 ? (
              <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>Keine Inhalte zum Anzeigen.</div>
            ) : fileSegments.map((seg, i) => (
              <FileDiffView key={i} file={seg.file} hunks={seg.hunks} />
            ))}
          </div>

          {proposal.status === 'pending' && isPO && (
            <>
              {actionError && <div style={{ color: 'var(--tn-red, #f7768e)', fontSize: 12, marginBottom: 8 }}>{actionError}</div>}
              {rejectMode ? (
                <div style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>Begründung (wird dem Fachpartner gezeigt)</label>
                  <textarea
                    value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                    rows={3} style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
                    placeholder="z. B. Die fachliche Logik passt — wir möchten die Datei-Struktur aber anders aufbauen. Lass uns kurz im Chat sprechen."
                  />
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                {!rejectMode ? (
                  <>
                    <button style={btnSecondaryStyle} onClick={() => setRejectMode(true)} disabled={acting}>Ablehnen</button>
                    <button style={btnPrimaryStyle} onClick={approve} disabled={acting}>
                      {acting ? 'Übernehme …' : '✓ Übernehmen'}
                    </button>
                  </>
                ) : (
                  <>
                    <button style={btnSecondaryStyle} onClick={() => setRejectMode(false)} disabled={acting}>Zurück</button>
                    <button style={btnPrimaryStyle} onClick={reject} disabled={acting}>
                      {acting ? 'Lehne ab …' : 'Ablehnung senden'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {proposal.status !== 'pending' && (
            <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)' }}>
              {proposal.status === 'approved' ? '✅ Übernommen' : '❌ Abgelehnt'}
              {proposal.decidedBy && <> von <b>{proposal.decidedBy}</b></>}
              {proposal.decidedAt && <> · {fmtAbsolute(proposal.decidedAt)}</>}
              {proposal.decisionReason && (
                <div style={{ marginTop: 6, padding: 8, background: 'var(--tn-bg, #16161e)', borderRadius: 4 }}>
                  „{proposal.decisionReason}"
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Side-by-side diff (no +/-, "Vorher" / "Nachher" labels)
// ---------------------------------------------------------------------------

interface DiffHunk {
  beforeLines: { lineNo: number | null; text: string; changed: boolean }[];
  afterLines:  { lineNo: number | null; text: string; changed: boolean }[];
}
interface FileDiff { file: string; hunks: DiffHunk[]; }

function parsePatchToSegments(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = patch.split('\n');
  let cur: FileDiff | null = null;
  let curHunk: DiffHunk | null = null;
  let beforeNo = 0, afterNo = 0;

  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\//.exec(line);
    if (m) {
      cur = { file: m[1], hunks: [] }; out.push(cur); curHunk = null; continue;
    }
    if (!cur) continue;
    const hm = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(line);
    if (hm) {
      curHunk = { beforeLines: [], afterLines: [] };
      cur.hunks.push(curHunk);
      beforeNo = parseInt(hm[1], 10); afterNo = parseInt(hm[2], 10);
      continue;
    }
    if (!curHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+') && !line.startsWith('++')) {
      curHunk.afterLines.push({ lineNo: afterNo++, text: line.slice(1), changed: true });
    } else if (line.startsWith('-') && !line.startsWith('--')) {
      curHunk.beforeLines.push({ lineNo: beforeNo++, text: line.slice(1), changed: true });
    } else if (line.startsWith(' ') || line === '') {
      // Context — appears on both sides.
      const text = line.startsWith(' ') ? line.slice(1) : line;
      curHunk.beforeLines.push({ lineNo: beforeNo++, text, changed: false });
      curHunk.afterLines.push({ lineNo: afterNo++, text, changed: false });
    }
  }

  // Pad shorter side with blanks so rows align.
  for (const f of out) {
    for (const h of f.hunks) {
      const max = Math.max(h.beforeLines.length, h.afterLines.length);
      while (h.beforeLines.length < max) h.beforeLines.push({ lineNo: null, text: '', changed: false });
      while (h.afterLines.length < max) h.afterLines.push({ lineNo: null, text: '', changed: false });
    }
  }
  return out;
}

function FileDiffView({ file, hunks }: { file: string; hunks: DiffHunk[] }) {
  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--tn-border, #292e42)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{
        background: 'var(--tn-bg, #16161e)', padding: '6px 10px',
        fontSize: 11, fontFamily: 'monospace', color: 'var(--tn-blue, #7aa2f7)',
        borderBottom: '1px solid var(--tn-border, #292e42)',
      }}>{file}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: 11, fontFamily: 'monospace' }}>
        <div style={{ padding: '4px 8px', borderRight: '1px solid var(--tn-border, #292e42)', color: 'var(--tn-text-muted, #a9b1d6)', background: 'var(--tn-bg, #16161e)' }}>
          Vorher
        </div>
        <div style={{ padding: '4px 8px', color: 'var(--tn-text-muted, #a9b1d6)', background: 'var(--tn-bg, #16161e)' }}>
          Nachher
        </div>
        {hunks.map((h, hi) => (
          <DiffRows key={hi} hunk={h} />
        ))}
      </div>
    </div>
  );
}

function DiffRows({ hunk }: { hunk: DiffHunk }) {
  const rows = Math.max(hunk.beforeLines.length, hunk.afterLines.length);
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => {
        const b = hunk.beforeLines[i] || { lineNo: null, text: '', changed: false };
        const a = hunk.afterLines[i] || { lineNo: null, text: '', changed: false };
        return (
          <Row key={i} b={b} a={a} />
        );
      })}
    </>
  );
}

function Row({ b, a }: {
  b: { lineNo: number | null; text: string; changed: boolean };
  a: { lineNo: number | null; text: string; changed: boolean };
}) {
  return (
    <>
      <div style={{
        padding: '2px 8px', whiteSpace: 'pre', overflowX: 'auto',
        borderRight: '1px solid var(--tn-border, #292e42)',
        background: b.changed ? 'rgba(247, 118, 142, 0.10)' : 'transparent',
        color: b.changed ? 'var(--tn-red, #f7768e)' : 'var(--tn-text, #c0caf5)',
      }}>{b.text || '\u00A0'}</div>
      <div style={{
        padding: '2px 8px', whiteSpace: 'pre', overflowX: 'auto',
        background: a.changed ? 'rgba(158, 206, 106, 0.10)' : 'transparent',
        color: a.changed ? 'var(--tn-green, #9ece6a)' : 'var(--tn-text, #c0caf5)',
      }}>{a.text || '\u00A0'}</div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reset dialog
// ---------------------------------------------------------------------------

function ResetDialog({ onClose, onReset }: { onClose: () => void; onReset: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotName, setSnapshotName] = useState<string | null>(null);

  const doReset = async () => {
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(`${API}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: true }) });
      const data = await r.json();
      if (!r.ok) { setError(data.error || `HTTP ${r.status}`); return; }
      setSnapshotName(data.snapshot || null);
      setTimeout(onReset, 1500);
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal title="Tests zurücksetzen?" onClose={onClose}>
      {snapshotName ? (
        <div style={{ color: 'var(--tn-green, #9ece6a)' }}>
          ✅ Zurückgesetzt. Snapshot angelegt: <code style={{ fontSize: 11 }}>{snapshotName}</code>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.6 }}>
            Deine aktuelle Test-Umgebung wird zurück auf die <b>Live-Version</b> gesetzt.
            Alle Änderungen, die du noch nicht gesendet hast, werden vorher in einem
            <b> Snapshot</b> gesichert — du kommst jederzeit zurück.
          </div>
          {error && <div style={{ color: 'var(--tn-red, #f7768e)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={btnSecondaryStyle} onClick={onClose} disabled={submitting}>Abbrechen</button>
            <button style={btnPrimaryStyle} onClick={doReset} disabled={submitting}>
              {submitting ? 'Setze zurück …' : 'Zurücksetzen'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Snapshots dialog
// ---------------------------------------------------------------------------

function SnapshotsDialog({ onClose }: { onClose: () => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/snapshots`);
        const data = await r.json();
        setSnapshots(data.snapshots || []);
      } finally { setLoading(false); }
    })();
  }, []);

  return (
    <Modal title="Snapshots (letzte 7 Tage)" onClose={onClose}>
      {loading ? (
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>Lade Snapshots …</div>
      ) : snapshots.length === 0 ? (
        <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>
          Keine Snapshots vorhanden. Beim nächsten <i>Zurücksetzen</i> wird automatisch einer angelegt.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {snapshots.map(s => (
            <li key={s.ref} style={{
              padding: '8px 10px', marginBottom: 6,
              border: '1px solid var(--tn-border, #292e42)', borderRadius: 4,
              background: 'var(--tn-bg-elevated, #1a1b26)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{s.subject || s.ref}</div>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginTop: 2 }}>
                {fmtAbsolute(s.date)} · <code style={{ fontSize: 10 }}>{s.ref}</code>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #565f89)', marginTop: 12 }}>
        Wiederherstellen: Sage Claude im Chat „lade Snapshot &lt;Name&gt;". Snapshots werden nach 7 Tagen automatisch aufgeräumt.
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Generic UI primitives
// ---------------------------------------------------------------------------

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--tn-bg-elevated, #1a1b26)',
      border: '1px solid var(--tn-border, #292e42)',
      borderRadius: 6,
      padding: '12px 14px',
      marginBottom: 16,
    }}>
      {title && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--tn-text, #c0caf5)' }}>{title}</div>}
      {children}
    </div>
  );
}

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  // ESC closes.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--tn-bg-elevated, #1a1b26)',
        border: '1px solid var(--tn-border, #292e42)',
        borderRadius: 8, padding: 18, width: wide ? '90vw' : 520,
        maxWidth: wide ? 980 : 560, maxHeight: '90vh', overflowY: 'auto',
        color: 'var(--tn-text, #c0caf5)', fontSize: 13,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--tn-text-muted, #a9b1d6)', fontSize: 18, lineHeight: 1,
          }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProposalMeta['status'] }) {
  const cfg = status === 'pending' ? { color: 'var(--tn-orange, #ff9e64)', label: 'Offen' }
    : status === 'approved' ? { color: 'var(--tn-green, #9ece6a)', label: 'Übernommen' }
    : { color: 'var(--tn-red, #f7768e)', label: 'Abgelehnt' };
  return (
    <span style={{
      fontSize: 10, padding: '2px 6px', borderRadius: 3,
      border: `1px solid ${cfg.color}`, color: cfg.color,
      textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600,
    }}>{cfg.label}</span>
  );
}

// ---------------------------------------------------------------------------
// Style tokens
// ---------------------------------------------------------------------------

const sectionH2Style: React.CSSProperties = {
  margin: '0 0 10px', fontSize: 14, fontWeight: 600,
  color: 'var(--tn-text, #c0caf5)',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 500,
  color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 4, letterSpacing: 0.3,
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--tn-bg, #16161e)', color: 'var(--tn-text, #c0caf5)',
  border: '1px solid var(--tn-border, #292e42)', borderRadius: 4,
  padding: '8px 10px', fontSize: 13,
};

const btnPrimaryStyle: React.CSSProperties = {
  background: 'var(--tn-blue, #7aa2f7)', color: '#1a1b26',
  border: 'none', borderRadius: 4, padding: '6px 12px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

const btnSecondaryStyle: React.CSSProperties = {
  background: 'transparent', color: 'var(--tn-text, #c0caf5)',
  border: '1px solid var(--tn-border, #292e42)', borderRadius: 4,
  padding: '6px 12px', fontSize: 12, cursor: 'pointer',
};

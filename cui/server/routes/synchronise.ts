import { Router, Request, Response } from 'express';
import { extractConversationContext, readConversationMessages, findJsonlPathAllAccounts } from './shared/jsonl.js';
import { getTitle, getWorkDir, getAssignment, isFinished } from './shared/conv-metadata.js';
import { stopConversation, sendMessage, startConversation, isActive } from './claude-cli.js';
import { logBackgroundEvent } from './background-ops.js';

const AI_BRIDGE_URL = (process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000') + '/v1/chat/completions';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

// --- Types ---

interface ConvSnapshot {
  sessionId: string;
  accountId: string;
  title: string;
  workDir: string;
  summary: string;
  filesEdited: string[];
}

interface SyncCluster {
  id: string;
  label: string;
  conversations: ConvSnapshot[];
}

interface SyncFeedback {
  sessionId: string;
  accountId: string;
  feedbackPrompt: string;
  conflicts: string[];
}

type SyncPhase = 'idle' | 'discovering' | 'clustering' | 'stopping' | 'analyzing' | 'injecting' | 'complete' | 'error' | 'aborted';

interface SyncState {
  phase: SyncPhase;
  message: string;
  startedAt?: number;
  completedAt?: number;
  snapshots: ConvSnapshot[];
  clusters: SyncCluster[];
  feedback: SyncFeedback[];
  error?: string;
  stoppedSessions: string[];
  resumedSessions: string[];
}

// --- Module State ---

let syncState: SyncState = {
  phase: 'idle',
  message: '',
  snapshots: [],
  clusters: [],
  feedback: [],
  stoppedSessions: [],
  resumedSessions: [],
};

let abortRequested = false;

// --- Dependencies ---

interface SyncDeps {
  broadcast: (data: any) => void;
  sessionStates: Map<string, any>;
  setSessionState: (...args: any[]) => void;
}

let _deps: SyncDeps;

// --- Helpers ---

function updatePhase(phase: SyncPhase, message: string, extra?: Partial<SyncState>) {
  syncState.phase = phase;
  syncState.message = message;
  if (extra) Object.assign(syncState, extra);
  if (phase === 'complete' || phase === 'error' || phase === 'aborted') {
    syncState.completedAt = Date.now();
  }
  _deps.broadcast({ type: 'sync-state', state: syncState });
  logBackgroundEvent('system', phase === 'error' ? 'error' : 'summary', `[Sync] ${phase}: ${message}`);
}

function isAborted(): boolean {
  if (abortRequested) {
    updatePhase('aborted', 'Sync abgebrochen');
    return true;
  }
  return false;
}

async function callAiBridge(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.AI_BRIDGE_API_KEY;
  if (!apiKey) throw new Error('AI_BRIDGE_API_KEY not set');

  const resp = await fetch(AI_BRIDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 8192,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AI Bridge ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// --- Tool-Use File Scanner ---

function extractEditedFiles(messages: any[], lastN = 50): string[] {
  const files = new Set<string>();
  const recent = messages.slice(-lastN);
  for (const entry of recent) {
    const msg = entry.message || entry;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.input?.file_path) {
        if (block.name === 'Write' || block.name === 'Edit' || block.name === 'NotebookEdit') {
          files.add(block.input.file_path);
        }
      }
    }
  }
  return [...files];
}

// --- Phase 1: Discover ---

async function phaseDiscover(): Promise<ConvSnapshot[]> {
  updatePhase('discovering', 'Conversations werden analysiert...');

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const candidates: { sessionId: string; accountId: string }[] = [];

  for (const [key, state] of _deps.sessionStates.entries()) {
    const s = state as any;
    if (s.lastUpdate && s.lastUpdate < cutoff) continue;
    const sid = s.sessionId || key;
    if (isFinished(sid)) continue;
    candidates.push({ sessionId: sid, accountId: s.accountId || 'rafael' });
  }

  if (candidates.length === 0) {
    throw new Error('Keine aktiven Conversations gefunden (24h Fenster)');
  }

  updatePhase('discovering', `${candidates.length} Conversations gefunden, Context wird extrahiert...`);

  // Extract context in parallel (batches of 5)
  const snapshots: ConvSnapshot[] = [];
  const batchSize = 5;

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (isAborted()) return [];
    const batch = candidates.slice(i, i + batchSize);

    const results = await Promise.allSettled(batch.map(async (c) => {
      const title = getTitle(c.sessionId) || 'Untitled';
      const workDir = getWorkDir(c.sessionId) || '/unknown';
      const summary = extractConversationContext(c.sessionId, 15) || 'No context available';

      let filesEdited: string[] = [];
      const jsonlInfo = findJsonlPathAllAccounts(c.sessionId);
      if (jsonlInfo?.path) {
        try {
          const result = readConversationMessages(jsonlInfo.path);
          filesEdited = extractEditedFiles(result.messages);
        } catch { /* ignore read errors */ }
      }

      return { sessionId: c.sessionId, accountId: c.accountId, title, workDir, summary, filesEdited } as ConvSnapshot;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') snapshots.push(r.value);
    }
  }

  updatePhase('discovering', `${snapshots.length} Conversations analysiert`, { snapshots });
  return snapshots;
}

// --- Phase 2: Cluster ---

async function phaseCluster(snapshots: ConvSnapshot[]): Promise<SyncCluster[]> {
  updatePhase('clustering', 'AI gruppiert Conversations thematisch...');

  const summaryList = snapshots.map((s, i) => (
    `[${i}] "${s.title}" (${s.workDir})\n  Files: ${s.filesEdited.slice(0, 8).join(', ') || 'none'}\n  Context: ${s.summary.slice(0, 300)}`
  )).join('\n\n');

  const systemPrompt = `Du bist ein Code-Analyse-Assistent. Gruppiere die folgenden Conversations in thematische Cluster basierend auf:
- Gleiche/ueberlappende Dateien
- Gleiches Arbeitsverzeichnis oder Projekt
- Aehnliche Aufgaben (z.B. Build-System, Frontend UI, API, Types)

Antworte NUR als JSON Array:
[{"id": "cluster-1", "label": "Kurzer Cluster-Name", "indices": [0, 3, 5]}]

Jede Conversation muss genau einem Cluster zugeordnet sein. Erstelle 2-6 Cluster.`;

  const response = await callAiBridge(HAIKU_MODEL, systemPrompt, summaryList);

  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('AI Clustering gab kein valides JSON zurueck');

  const rawClusters = JSON.parse(jsonMatch[0]) as Array<{ id: string; label: string; indices: number[] }>;

  const clusters: SyncCluster[] = rawClusters.map(rc => ({
    id: rc.id,
    label: rc.label,
    conversations: rc.indices
      .filter(i => i >= 0 && i < snapshots.length)
      .map(i => snapshots[i]),
  }));

  updatePhase('clustering', `${clusters.length} Cluster erstellt`, { clusters });
  return clusters;
}

// --- Phase 3: Stop ---

async function phaseStop(clusters: SyncCluster[]): Promise<string[]> {
  const allSessions = clusters.flatMap(c => c.conversations.map(cv => cv.sessionId));
  const activeSessions = allSessions.filter(sid => isActive(sid));

  updatePhase('stopping', `${activeSessions.length} aktive Conversations werden gestoppt...`);

  const stopped: string[] = [];
  for (const sid of activeSessions) {
    if (isAborted()) return stopped;
    try {
      await stopConversation(sid);
      stopped.push(sid);
    } catch (e: any) {
      console.error(`[Sync] Failed to stop ${sid.slice(0, 8)}:`, e.message);
    }
  }

  updatePhase('stopping', `${stopped.length} Conversations gestoppt`, { stoppedSessions: stopped });
  return stopped;
}

// --- Phase 4: Analyze ---

async function phaseAnalyze(clusters: SyncCluster[]): Promise<SyncFeedback[]> {
  updatePhase('analyzing', 'Cross-Analyse laeuft...');

  const allFeedback: SyncFeedback[] = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    if (isAborted()) return allFeedback;
    const cluster = clusters[ci];

    // Single-conversation cluster: no cross-analysis needed
    if (cluster.conversations.length < 2) {
      allFeedback.push({
        sessionId: cluster.conversations[0].sessionId,
        accountId: cluster.conversations[0].accountId,
        feedbackPrompt: `[Sync] Du arbeitest alleine im Cluster "${cluster.label}". Keine Konflikte erkannt. Weiter.`,
        conflicts: [],
      });
      continue;
    }

    updatePhase('analyzing', `Cluster "${cluster.label}" (${ci + 1}/${clusters.length}) wird analysiert...`);

    const clusterContext = cluster.conversations.map((c, i) => (
      `=== Conversation ${i + 1}: "${c.title}" ===\nWorkDir: ${c.workDir}\nFiles edited: ${c.filesEdited.join(', ') || 'none'}\nContext:\n${c.summary}\n`
    )).join('\n---\n\n');

    const systemPrompt = `Du bist ein Software-Architektur-Reviewer. Analysiere diese ${cluster.conversations.length} parallelen Conversations im Cluster "${cluster.label}".

Pruefe auf:
1. Dateikonflikte: Bearbeiten mehrere Conversations die gleichen Dateien?
2. ENV-Var Inkonsistenzen: Aendert einer ENV-Vars die andere nutzen?
3. API-Inkompatibilitaeten: Aendern sich Interfaces/Types die andere importieren?
4. Doppelte Arbeit: Loesen mehrere das gleiche Problem redundant?
5. Abhaengigkeiten: Baut einer auf Ergebnissen eines anderen auf?

Fuer JEDE Conversation generiere:
1. Eine kurze Feedback-Nachricht (1-3 Saetze, Deutsch) die der Conversation mitgegeben wird
2. Liste der erkannten Konflikte (kann leer sein)

Antworte NUR als JSON:
[{"sessionIndex": 0, "feedback": "Deine Nachricht an die Conversation", "conflicts": ["Konflikt 1"]}]`;

    try {
      const response = await callAiBridge(SONNET_MODEL, systemPrompt, clusterContext);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const rawFeedback = JSON.parse(jsonMatch[0]) as Array<{ sessionIndex: number; feedback: string; conflicts: string[] }>;
        for (const rf of rawFeedback) {
          const conv = cluster.conversations[rf.sessionIndex];
          if (!conv) continue;
          allFeedback.push({
            sessionId: conv.sessionId,
            accountId: conv.accountId,
            feedbackPrompt: `[Sync-Feedback, Cluster "${cluster.label}"] ${rf.feedback}`,
            conflicts: rf.conflicts || [],
          });
        }
      }
    } catch (e: any) {
      console.error(`[Sync] Analyze cluster "${cluster.label}" failed:`, e.message);
      for (const conv of cluster.conversations) {
        allFeedback.push({
          sessionId: conv.sessionId,
          accountId: conv.accountId,
          feedbackPrompt: `[Sync] Analyse-Fehler fuer Cluster "${cluster.label}": ${e.message}. Bitte manuell pruefen.`,
          conflicts: [`Analyse-Fehler: ${e.message}`],
        });
      }
    }
  }

  updatePhase('analyzing', `${allFeedback.length} Feedback-Eintraege generiert`, { feedback: allFeedback });
  return allFeedback;
}

// --- Phase 5: Inject & Resume ---

async function phaseInject(feedback: SyncFeedback[], stoppedSessions: string[]): Promise<void> {
  updatePhase('injecting', 'Feedback wird injiziert und Conversations fortgesetzt...');

  const toResume = feedback.filter(fb => stoppedSessions.includes(fb.sessionId));
  const resumed: string[] = [];

  for (const fb of toResume) {
    if (isAborted()) break;

    const sid = fb.sessionId;
    updatePhase('injecting', `Resume ${sid.slice(0, 8)} (${resumed.length + 1}/${toResume.length})...`);

    try {
      // Process was stopped, need to start new with --resume
      const workDir = getWorkDir(sid) || '/';
      const accountId = fb.accountId || getAssignment(sid) || 'rafael';
      await startConversation(accountId, fb.feedbackPrompt, workDir, sid);
      resumed.push(sid);
    } catch (e: any) {
      console.error(`[Sync] Failed to inject+resume ${sid.slice(0, 8)}:`, e.message);
    }

    // Sequential with 1s gap
    await new Promise(r => setTimeout(r, 1000));
  }

  updatePhase('injecting', `${resumed.length} Conversations fortgesetzt`, { resumedSessions: resumed });
}

// --- Main Pipeline ---

async function runSyncPipeline(): Promise<void> {
  abortRequested = false;
  syncState = {
    phase: 'idle',
    message: '',
    startedAt: Date.now(),
    snapshots: [],
    clusters: [],
    feedback: [],
    stoppedSessions: [],
    resumedSessions: [],
  };

  try {
    const snapshots = await phaseDiscover();
    if (isAborted() || snapshots.length === 0) return;

    const clusters = await phaseCluster(snapshots);
    if (isAborted()) return;

    const stopped = await phaseStop(clusters);
    if (isAborted()) return;

    const feedback = await phaseAnalyze(clusters);
    if (isAborted()) return;

    await phaseInject(feedback, stopped);

    if (!isAborted()) {
      const totalConflicts = feedback.reduce((sum, f) => sum + f.conflicts.length, 0);
      updatePhase('complete', `Sync abgeschlossen: ${clusters.length} Cluster, ${feedback.length} Feedback, ${totalConflicts} Konflikte`);
    }
  } catch (e: any) {
    updatePhase('error', `Sync-Fehler: ${e.message}`, { error: e.message });
  }
}

// --- Router ---

export function createSynchroniseRouter(deps: SyncDeps): Router {
  _deps = deps;
  const router = Router();

  router.post('/api/sync/start', (_req: Request, res: Response) => {
    if (syncState.phase !== 'idle' && syncState.phase !== 'complete' && syncState.phase !== 'error' && syncState.phase !== 'aborted') {
      res.status(409).json({ ok: false, error: 'Sync already running', phase: syncState.phase });
      return;
    }
    runSyncPipeline().catch(e => console.error('[Sync] Pipeline error:', e));
    res.status(202).json({ ok: true, message: 'Sync gestartet' });
  });

  router.get('/api/sync/status', (_req: Request, res: Response) => {
    res.json(syncState);
  });

  router.post('/api/sync/abort', (_req: Request, res: Response) => {
    if (syncState.phase === 'idle' || syncState.phase === 'complete' || syncState.phase === 'error' || syncState.phase === 'aborted') {
      res.json({ ok: false, error: 'Nothing to abort', phase: syncState.phase });
      return;
    }
    abortRequested = true;
    res.json({ ok: true, message: 'Abort angefordert' });
  });

  return router;
}

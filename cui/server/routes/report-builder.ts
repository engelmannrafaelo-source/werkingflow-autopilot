// =============================================================================
// Report Builder API — Creative Document Generation
// =============================================================================
// Step 1: Extract claims with VARIANTS from business docs → AI proposes draft
// Step 2: User curates claims, picks variants, adjusts → generate final document
//
// All sessions persisted as JSON in DATA_DIR/report-builder/

import { Router } from 'express';
import { resolve, join, relative } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { randomUUID, createHash } from 'crypto';

const router = Router();

// --- Constants ---
import { PATHS, BRIDGE_URL } from '../config/paths.js';

const BUSINESS_DIR = PATHS.businessDir;
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY || '';

// Will be set by init function
let SESSIONS_DIR = '';

export function initReportBuilder(dataDir: string) {
  SESSIONS_DIR = join(dataDir, 'report-builder');
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

// --- Types ---
interface ClaimVariant {
  style: 'compact' | 'persuasive' | 'detailed' | 'executive';
  text: string;
}

interface ReportClaim {
  id: string;
  text: string;
  context: string;  // 2-3 sentences background info for richer generation
  variants: ClaimVariant[];
  selectedVariant: number; // index into variants, -1 = use text (original)
  reasoning: string;
  source: string;
  sourceSection: string;
  category: 'fact' | 'argument' | 'metric' | 'quote' | 'recommendation' | 'vision';
  selected: boolean;
  note: string;
  weight: number;
  order: number;
  templateId?: string;       // assigned template section ID for design reference
  templateReason?: string;   // AI reason for template suggestion
}

interface ClaimGroup {
  id: string;
  groupName: string;
  category: string;
  claims: ReportClaim[];
}

interface DraftSection {
  title: string;
  description: string;
  claimIds: string[];
}

interface Revision {
  id: string;           // "R1", "R2", etc.
  html: string;
  changePrompt: string; // empty for R1 (initial generation)
  addedSources: string[];
  designHints: string[];
  timestamp: string;
}

interface ReportBuilderSession {
  id: string;
  name: string;
  description: string;
  brief: string;
  createdAt: string;
  updatedAt: string;
  step: 'source-select' | 'claim-curation' | 'generation' | 'review';
  sources: string[];
  extractionPrompt: string;
  groups: ClaimGroup[];
  draftOutline: DraftSection[];
  generalNotes: string;
  outputFormat: 'presentation' | 'document';
  tone: 'formal' | 'pitch' | 'technical' | 'executive' | 'casual';
  language: 'de' | 'en';
  customInstructions: string;
  templateSectionIds: string[];  // selected template section IDs for design reference
  claimTemplateMatches?: Array<{ claimId: string; templateId: string; reason: string; rank: number; selected: boolean; templateTitle: string; templateType: string; templateFile: string; templatePreview: string; hasSvg: boolean }>;
  generatedContent: string;
  generationStatus: 'idle' | 'extracting' | 'generating' | 'done' | 'error';
  error: string | null;
  revisions: Revision[];
  activeRevisionIndex: number;
}

// --- Helpers ---
function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id: string): ReportBuilderSession | null {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  const session = JSON.parse(readFileSync(p, 'utf-8'));
  // Migration: old sessions without revisions field
  if (!session.revisions) {
    session.revisions = [];
    session.activeRevisionIndex = -1;
    if (session.generatedContent) {
      session.revisions.push({
        id: 'R1', html: session.generatedContent, changePrompt: '',
        addedSources: [], designHints: session.templateSectionIds || [],
        timestamp: session.updatedAt || new Date().toISOString(),
      });
      session.activeRevisionIndex = 0;
    }
  }
  return session;
}

function saveSession(session: ReportBuilderSession): void {
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function newSession(name?: string, description?: string): ReportBuilderSession {
  return {
    id: randomUUID(),
    name: name || '',
    description: description || '',
    brief: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step: 'source-select',
    sources: [],
    extractionPrompt: '',
    groups: [],
    draftOutline: [],
    generalNotes: '',
    outputFormat: 'presentation',
    tone: 'formal',
    language: 'de',
    customInstructions: '',
    templateSectionIds: [],
    generatedContent: '',
    generationStatus: 'idle',
    error: null,
    revisions: [],
    activeRevisionIndex: -1,
  };
}

// --- Claim Extraction Prompt (with variants + draft) ---
const CLAIM_EXTRACTION_SYSTEM = `Du bist ein kreativer Dokumenten-Stratege und Informationsarchitekt.

Deine Aufgabe: Analysiere die Dokumente TIEFGRÜNDIG und extrahiere ALLE relevanten Claims — dann schlage einen kreativen Entwurf vor.

## Was du lieferst:

### 1. Claims in thematischen Gruppen
- Extrahiere 20-40 Claims je nach Umfang — lieber zu viele als zu wenige
- Jeder Claim ist EINE konkrete Aussage
- Jeder Claim hat ein "context"-Feld: 2-3 Sätze Hintergrund-Information, die erklärt WARUM dieser Claim wichtig ist, welche Daten dahinter stehen, oder welchen Zusammenhang er hat. Ohne Kontext kann der Generator keine überzeugende Darstellung erstellen!
- Für WICHTIGE Claims (weight >= 4) liefere 2 FORMULIERUNGS-VARIANTEN:
  - "compact": Kurz, knackig (max 15 Worte)
  - "persuasive": Emotional überzeugend, mit Impact
- Für andere Claims (weight < 4) reichen 0-1 Varianten
- Kategorisiere: fact, argument, metric, quote, recommendation, vision
- Sortiere Claims nach Wichtigkeit (weight 1-5) — die stärksten zuerst

### 2. Entwurfs-Vorschlag (draftOutline)
- Schlage eine KONKRETE Dokument-Struktur vor (5-10 Abschnitte)
- Jeder Abschnitt referenziert Claims per ID
- Das zeigt dem User: "So würde ICH das aufbauen"

## JSON-Format (STRIKT einhalten):
{
  "groups": [
    {
      "groupName": "Aussagekräftiger Gruppenname",
      "category": "problem|solution|architecture|roadmap|business|differentiator|vision|status",
      "claims": [
        {
          "text": "Die Kernaussage in Normalform",
          "context": "2-3 Sätze Hintergrund. Erklärt Zusammenhänge, nennt Zahlen/Daten, gibt dem Generator genug Material für eine überzeugende Darstellung.",
          "variants": [
            { "style": "compact", "text": "Kurzform" },
            { "style": "persuasive", "text": "Überzeugende Form" },
            { "style": "detailed", "text": "Ausführliche Form mit Kontext" }
          ],
          "reasoning": "Warum ist das relevant / was macht es stark",
          "source": "datei.md",
          "sourceSection": "Abschnitts-Überschrift",
          "category": "fact|argument|metric|quote|recommendation|vision",
          "weight": 4
        }
      ]
    }
  ],
  "draftOutline": [
    {
      "title": "Abschnitts-Titel",
      "description": "Was dieser Abschnitt kommunizieren soll",
      "claimRefs": [0, 1, 5]
    }
  ]
}

WICHTIG: claimRefs in draftOutline sind GLOBALE Indizes (0 = erster Claim insgesamt, 1 = zweiter, etc.)
Antworte NUR mit dem JSON. Kein Markdown-Wrapper, keine Erklärungen.`;

// --- Document Generation Prompt ---
// Map frontend outputFormat to standard template files
const STANDARD_TEMPLATES: Record<string, string> = {
  presentation: 'shared/templates/TEMPLATE-PRESENTATION.html',
  document: 'shared/templates/TEMPLATE-DOCUMENT.html',
};

function loadStandardTemplate(outputFormat: string): string {
  const templateFile = STANDARD_TEMPLATES[outputFormat];
  if (!templateFile) return '';
  const fullPath = join(BUSINESS_DIR, templateFile);
  if (!existsSync(fullPath)) {
    console.warn(`[ReportBuilder] Standard template not found: ${fullPath}`);
    return '';
  }
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch (err: any) {
    console.warn(`[ReportBuilder] Failed to read standard template: ${err.message}`);
    return '';
  }
}

function buildGenerationSystemPrompt(format: string, tone: string, language: string, customInstructions?: string, standardTemplateHtml?: string): string {
  // presentation/document both produce HTML
  const isHtmlFormat = format === 'html' || format === 'presentation' || format === 'document';

  const formatInstructions: Record<string, string> = {
    markdown: 'Erstelle ein sauber strukturiertes Markdown-Dokument mit Überschriften, Aufzählungen und Hervorhebungen.',
    html: `Erstelle ein vollständiges, eigenständiges HTML-Dokument mit professionellem Inline-CSS.
Verwende ein modernes, visuell beeindruckendes Layout.
Nutze inline SVG für Diagramme, Charts und Visualisierungen wo passend — KEINE externen Bilder.
Setze CSS Grid/Flexbox für Layouts, Stat-Boxes, Card-Grids, Vergleichstabellen ein.
Das HTML muss komplett selbstenthalten sein (alle Styles inline oder im <style>-Block).`,
    presentation: `Erstelle eine vollständige, eigenständige HTML-Präsentation im EXAKTEN Stil der mitgelieferten Standardvorlage.
Die Präsentation besteht aus Slides (Fullscreen-Sections). Jede Section ist ein eigener Slide.
Übernimm das KOMPLETTE Design-System der Vorlage: Farben, Fonts, Gradients, Glass-Morphism, Card-Styles, SVG-Diagramme.
Nutze inline SVG für Diagramme, Charts und Visualisierungen — KEINE externen Bilder.
Das HTML muss komplett selbstenthalten sein (alle Styles inline oder im <style>-Block).`,
    document: `Erstelle ein vollständiges, eigenständiges HTML-Dokument im EXAKTEN Stil der mitgelieferten Standardvorlage.
Das Dokument ist A4-optimiert und print-ready. Verwende das Light-Theme der Vorlage.
Übernimm das KOMPLETTE Design-System der Vorlage: Farben, Fonts, Abstände, Card-Styles.
Nutze inline SVG für Diagramme, Charts und Visualisierungen — KEINE externen Bilder.
Das HTML muss komplett selbstenthalten sein (alle Styles inline oder im <style>-Block).`,
  };

  const toneInstructions: Record<string, string> = {
    formal: 'Formaler, professioneller Ton. Sachlich und präzise.',
    pitch: 'Überzeugender Pitch-Ton. Emotionale Hooks, klare Value Propositions, Call-to-Actions. Setze auf visuelle Hierarchie und Design um zu überzeugen.',
    technical: 'Technisch detailliert. Fachbegriffe erlaubt, strukturierte Argumentation.',
    executive: 'Executive Summary Stil. Kurz, auf den Punkt, Entscheidungs-orientiert.',
    casual: 'Lockerer, zugänglicher Ton. Einfache Sprache, kurze Sätze.',
  };

  const lang = language === 'de' ? 'Schreibe auf Deutsch.' : 'Write in English.';

  let prompt = `Du bist ein professioneller Dokumenten-Generator und Visual Designer. Du gibst DIREKT das fertige Dokument aus — KEINE Erklärungen, KEINE Ankündigungen, KEINE Konversation. Deine Antwort IST das Dokument.

Format: ${formatInstructions[format] || formatInstructions.html}
Ton: ${toneInstructions[tone] || toneInstructions.formal}
${lang}`;

  // Inject standard template as the PRIMARY design reference
  if (standardTemplateHtml) {
    prompt += `

STANDARDVORLAGE (HÖCHSTE DESIGN-PRIORITÄT — das gesamte Dokument MUSS diesem Design-System folgen):
Übernimm EXAKT: Farbschema, CSS-Variablen, Fonts (Familie + Größen), Gradients, Glass-Morphism-Effekte, Card-Styles, Section-Layouts, Abstände, Schatten, Border-Radien.
Die Vorlage definiert das visuelle Fundament. Zusätzliche Design-Hints von ausgewählten Template-Sections sind Ergänzungen, NICHT Ersatz.

<standard-template>
${standardTemplateHtml}
</standard-template>`;
  }

  // Inject customInstructions at SYSTEM level (highest priority) if present
  if (customInstructions?.trim()) {
    prompt += `

DESIGN-ANWEISUNGEN (HÖCHSTE PRIORITÄT — diese Anweisungen überschreiben alle Defaults):
${customInstructions.trim()}`;
  }

  prompt += `

Erstelle das Dokument basierend auf den kuratierten Claims. Verwende NUR die bereitgestellten Claims als Inhaltsquelle.
Claims mit höherer Gewichtung (weight) sollen prominenter und detaillierter behandelt werden.
Claims mit Anmerkungen (note) sollen entsprechend angepasst werden.
Verwende die gewählte Variante jedes Claims als Basis-Formulierung.

ANTI-HALLUZINATION (KRITISCH):
Erfinde NICHTS — keine Namen, Vornamen, Titel (Dr., Ing., Prof.), Zahlen, Fakten, Zitate, Firmennamen, Jobtitel, Partnernamen oder andere Details die nicht WÖRTLICH in den Claims stehen.
Wenn ein Claim nur einen Nachnamen nennt, verwende NUR den Nachnamen — ergänze KEINEN Vornamen oder Titel.
Wenn ein Claim keine Zahl nennt, erfinde keine Zahl.
Wenn du unsicher bist ob eine Information in den Claims steht: WEGLASSEN, nicht raten.`;

  if (isHtmlFormat) {
    prompt += `

VISUELLE QUALITÄT:
- Verwende SVG-Grafiken für Zahlen, Statistiken und Vergleiche (Balken, Kreise, Gauge-Charts)
- Nutze Icon-Boxen (Unicode oder SVG) für Feature-Listen
- Erstelle Pricing-/Options-Karten mit klarer visueller Hierarchie
- Setze eine empfohlene Option visuell ab (farbiger Rahmen, Badge, Glow-Effekt)
- Baue interaktive Hover-Effekte für Cards und Buttons ein
- Verwende CSS-Variablen für konsistentes Farbschema`;
  }

  const outputLabel = isHtmlFormat ? 'HTML' : 'Markdown';
  prompt += `

WICHTIG: Antworte NUR mit dem fertigen ${outputLabel}-Dokument. Kein Einleitungstext, kein \`\`\`-Wrapper, keine Erklärung. Direkt der Inhalt.`;

  return prompt;
}

// --- Directory Tree ---
interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeNode[];
}

function buildTree(dirPath: string, depth = 0): TreeNode[] {
  if (depth > 3) return [];
  if (!existsSync(dirPath)) return [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const result: TreeNode[] = [];

  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'));
  const files = entries.filter(e => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.html') || e.name.endsWith('.txt')));

  for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dirPath, d.name);
    const relPath = relative(BUSINESS_DIR, fullPath);
    result.push({
      name: d.name,
      path: relPath,
      type: 'directory',
      children: buildTree(fullPath, depth + 1),
    });
  }

  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dirPath, f.name);
    const relPath = relative(BUSINESS_DIR, fullPath);
    const stats = statSync(fullPath);
    // Token estimate: ~1 token per 4 chars
    const tokenEstimate = Math.ceil(stats.size / 4);
    result.push({
      name: f.name,
      path: relPath,
      type: 'file',
      size: stats.size,
      tokenEstimate,
    });
  }

  return result;
}

// =============================================================================
// API Routes
// =============================================================================

// GET /sessions — list all sessions
router.get('/sessions', (_req, res) => {
  try {
    if (!existsSync(SESSIONS_DIR)) return res.json({ sessions: [] });
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'));
      return {
        id: data.id,
        name: data.name || '',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        step: data.step,
        sourceCount: data.sources?.length ?? 0,
        claimCount: data.groups?.reduce((acc: number, g: any) => acc + (g.claims?.length ?? 0), 0) ?? 0,
        outputFormat: data.outputFormat,
      };
    }).sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /sessions — create new session
router.post('/sessions', (req, res) => {
  try {
    const { name, description } = req.body || {};
    const session = newSession(name, description);
    saveSession(session);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:id — load session
router.get('/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// PUT /sessions/:id — update session state
router.put('/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const updates = req.body;
  Object.assign(session, updates);
  saveSession(session);
  res.json({ session });
});

// DELETE /sessions/:id — delete session
router.delete('/sessions/:id', (req, res) => {
  const p = sessionPath(req.params.id);
  if (existsSync(p)) unlinkSync(p);
  res.json({ ok: true });
});

// GET /business-tree — directory tree of business/
router.get('/business-tree', (_req, res) => {
  try {
    res.json({ tree: buildTree(BUSINESS_DIR) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /file-preview — read full business file for preview, with token estimate
router.get('/file-preview', (req, res) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const fullPath = resolve(join(BUSINESS_DIR, relPath));
    if (!fullPath.startsWith(BUSINESS_DIR)) return res.status(400).json({ error: 'Path traversal blocked' });
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

    const content = readFileSync(fullPath, 'utf-8');
    const size = statSync(fullPath).size;
    // Token estimate: ~1 token per 4 chars (good approximation for Claude)
    const tokenEstimate = Math.ceil(content.length / 4);

    res.json({
      path: relPath,
      preview: content,
      totalLines: content.split('\n').length,
      truncated: false,
      size,
      tokenEstimate,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /extract — creative claim extraction with variants
// Helper: convert HTML to structured Markdown for claim extraction (strips design, keeps content)
function htmlToMarkdown(html: string): string {
  let text = html;
  // Remove style, script, SVG blocks entirely (design, not content)
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '[SVG-Diagramm]');
  text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');
  // Convert structural elements to Markdown
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n');
  // Table → simple text rows
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = row.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '$1 | ').trim();
    return cells + '\n';
  });
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü').replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü').replace(/&szlig;/g, 'ß')
    .replace(/&middot;/g, '·').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '');
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/ +/g, ' ').trim();
  return text;
}

// Legacy alias
function htmlToText(html: string): string { return htmlToMarkdown(html); }

// Helper: run extraction in background (survives client disconnect / workspace switch)
async function runExtractionAsync(sessionId: string, sources: string[], extractionPrompt: string, brief: string) {
  const session = loadSession(sessionId);
  if (!session) return;
  try {
    const docs = sources.map((relPath: string) => {
      const fullPath = join(BUSINESS_DIR, relPath);
      if (!existsSync(fullPath)) throw new Error(`File not found: ${relPath}`);
      if (!fullPath.startsWith(BUSINESS_DIR)) throw new Error(`Path traversal blocked: ${relPath}`);
      let content = readFileSync(fullPath, 'utf-8');
      if (relPath.endsWith('.html')) content = htmlToText(content);
      return { path: relPath, content };
    });

    const documentsText = docs.map((d: { path: string; content: string }) =>
      `--- Dokument: ${d.path} ---\n${d.content}`
    ).join('\n\n');

    const parts: string[] = [];
    const sessionBrief = brief || session.brief || '';
    if (sessionBrief) parts.push(`AUFTRAG: ${sessionBrief}`);
    if (extractionPrompt) parts.push(`Fokus/Hinweis: ${extractionPrompt}`);
    parts.push(`Dokumente:\n${documentsText}`);
    const userPrompt = parts.join('\n\n');

    console.log(`[ReportBuilder] Async extraction: ${BRIDGE_URL}/v1/chat/completions (${docs.length} docs, ~${documentsText.length} chars)`);
    const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIDGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [
          { role: 'system', content: CLAIM_EXTRACTION_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(900000), // 15min — large generations can take 10min+
    });

    console.log(`[ReportBuilder] Bridge response status: ${response.status}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Bridge API ${response.status}: ${errText}`);
    }

    const data = await response.json() as any;
    const text = data.choices?.[0]?.message?.content || '';
    console.log(`[ReportBuilder] Got ${text.length} chars from Bridge`);

    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) throw new Error('No JSON in extraction response');
    const parsed = JSON.parse(jsonMatch[1]);

    let globalIndex = 0;
    const groups: ClaimGroup[] = (parsed.groups || []).map((g: any, gi: number) => ({
      id: `grp-${gi}`,
      groupName: g.groupName || g.title || `Gruppe ${gi + 1}`,
      category: g.category || 'general',
      claims: (g.claims || []).map((c: any) => {
        const claim: ReportClaim = {
          id: `cl-${globalIndex}`,
          text: c.text || '',
          context: c.context || '',
          variants: (c.variants || []).map((v: any) => ({ style: v.style || 'compact', text: v.text || '' })),
          selectedVariant: -1,
          reasoning: c.reasoning || '',
          source: c.source || '',
          sourceSection: c.sourceSection || '',
          category: c.category || 'fact',
          selected: true,
          note: '',
          weight: c.weight || 3,
          order: globalIndex,
        };
        globalIndex++;
        return claim;
      }),
    }));

    const draftOutline: DraftSection[] = (parsed.draftOutline || []).map((s: any) => ({
      title: s.title || '',
      description: s.description || '',
      claimIds: (s.claimRefs || []).map((ref: number) => `cl-${ref}`),
    }));

    // Reload session (may have been updated by user while extraction ran)
    const updatedSession = loadSession(sessionId);
    if (!updatedSession) return;
    updatedSession.sources = sources;
    updatedSession.extractionPrompt = extractionPrompt || '';
    updatedSession.groups = groups;
    updatedSession.draftOutline = draftOutline;
    updatedSession.step = 'claim-curation';
    updatedSession.generationStatus = 'idle';
    updatedSession.error = null;
    saveSession(updatedSession);

    const totalClaims = groups.reduce((a, g) => a + g.claims.length, 0);
    console.log(`[ReportBuilder] Extraction complete: ${totalClaims} claims in ${groups.length} groups`);
  } catch (err: any) {
    const errSession = loadSession(sessionId);
    if (errSession) {
      errSession.generationStatus = 'error';
      errSession.error = err.message;
      saveSession(errSession);
    }
    console.error('[ReportBuilder] Async extract error:', err.message);
  }
}

router.post('/extract', async (req, res) => {
  console.error('[ReportBuilder] Extract request received');
  const { sessionId, sources, extractionPrompt, brief } = req.body;
  if (!sessionId || !sources?.length) {
    return res.status(400).json({ error: 'sessionId and sources[] required' });
  }

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Mark as extracting and respond immediately — extraction runs in background
  session.generationStatus = 'extracting';
  session.error = null;
  if (brief !== undefined) session.brief = brief;
  saveSession(session);

  // Fire-and-forget: extraction continues even if client disconnects
  runExtractionAsync(sessionId, sources, extractionPrompt || '', brief || '').catch(err => {
    console.error('[ReportBuilder] Background extraction failed:', err);
  });

  // Respond immediately so the client knows extraction started
  res.json({ status: 'extracting', message: 'Extraction started in background. Poll session for results.' });
});

// Helper: run generation in background (survives client disconnect / workspace switch)
async function runGenerationAsync(sessionId: string, feedback?: string, revisionMode?: boolean) {
  const session = loadSession(sessionId);
  if (!session) return;
  try {
    // Guard: normalize legacy outputFormat values to standard template-backed formats
    if (session.outputFormat === 'html' || session.outputFormat === 'markdown') {
      console.log(`[ReportBuilder] Normalizing legacy outputFormat '${session.outputFormat}' → 'presentation'`);
      session.outputFormat = 'presentation';
      saveSession(session);
    }

    // Build claims text from curated selection — use selected variant
    const includedClaims = session.groups.flatMap(g =>
      g.claims
        .filter(c => c.selected)
        .map(c => ({
          ...c,
          groupName: g.groupName,
          displayText: c.selectedVariant >= 0 && c.variants[c.selectedVariant]
            ? c.variants[c.selectedVariant].text
            : c.text,
        }))
    ).sort((a, b) => b.weight - a.weight);

    if (includedClaims.length === 0) throw new Error('Keine Claims ausgewählt');

    // Strip data: URIs to avoid Bridge vision API confusion
    const stripDataUris = (text: string) => text
      .replace(/url\(["']?data:[^)]+\)/g, 'url()')
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '')
      .replace(/data:[a-z]+\/[a-z+.-]+,[^\s"'<>]+/g, '');

    // Resolve per-claim templates: load all needed template sections
    const neededTemplateIds = new Set(includedClaims.map(c => (c as any).templateId).filter(Boolean));
    // Also include globally selected templates as fallback
    if (session.templateSectionIds?.length > 0) {
      for (const id of session.templateSectionIds) neededTemplateIds.add(id);
    }

    const resolvedTemplates = new Map<string, { title: string; html: string; fileName: string }>();
    let styleBlock = '';

    if (neededTemplateIds.size > 0) {
      const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
      for (const relPath of htmlFiles) {
        const fullPath = join(BUSINESS_DIR, relPath);
        try {
          const sections = parseHtmlSections(fullPath, relPath);
          for (const s of sections) {
            if (neededTemplateIds.has(s.id)) {
              let html = stripDataUris(s.html);
              if (html.length > 6000) html = html.slice(0, 6000) + '\n<!-- truncated -->';
              resolvedTemplates.set(s.id, { title: s.title, html, fileName: s.fileName });
              if (!styleBlock) {
                let raw = extractStyleBlock(fullPath);
                raw = stripDataUris(raw);
                raw = raw.replace(/background-image\s*:[^;]+;/g, '');
                raw = raw.replace(/background\s*:[^;]*url\([^)]*\)[^;]*;/g, '');
                styleBlock = raw.length > 8000 ? raw.slice(0, 8000) : raw;
              }
            }
          }
        } catch {}
      }
    }

    // Build claims text with per-claim template references
    const claimsText = includedClaims.map(c => {
      let line = `- [${c.category}] (Gewicht: ${c.weight}/5) ${c.displayText}`;
      if ((c as any).context) line += `\n  Kontext: ${(c as any).context}`;
      if (c.note) line += `\n  ANMERKUNG: ${c.note}`;
      line += `\n  Quelle: ${c.source} > ${c.sourceSection}`;
      line += `\n  Gruppe: ${c.groupName}`;
      const tid = (c as any).templateId;
      if (tid && resolvedTemplates.has(tid)) {
        line += `\n  DESIGN-VORLAGE: "${resolvedTemplates.get(tid)!.title}" (siehe Template-Block #${tid})`;
      }
      return line;
    }).join('\n');

    // Build template context — only include resolved templates
    let templateContext = '';
    if (resolvedTemplates.size > 0) {
      const templateBlocks = Array.from(resolvedTemplates.entries()).map(([id, t]) =>
        `--- Template #${id}: "${t.title}" (aus ${t.fileName}) ---\n${t.html}`
      ).join('\n\n');

      templateContext = `\n\nDESIGN-VORLAGEN (jeder Claim referenziert seine Vorlage oben):

${styleBlock ? `--- CSS aus Vorlage ---\n<style>\n${styleBlock}\n</style>\n` : ''}
${templateBlocks}

DESIGN-ANWEISUNGEN:
1. Jeder Claim hat eine zugewiesene Design-Vorlage — reproduziere das Layout/Design dieser Vorlage für die jeweilige Section
2. Übernimm CSS-Farbschema, Fonts, Gradients, Glass-Morphism-Effekte EXAKT
3. SVG-Diagramme, Flowcharts, Infografiken: Reproduziere den Stil, erstelle NEUE Diagramme passend zum Claim-Inhalt
4. Claims OHNE Vorlage: Erstelle passende Sections im gleichen Gesamtstil`;
    }

    // Load standard template based on outputFormat (presentation/document)
    const standardTemplateHtml = loadStandardTemplate(session.outputFormat);
    if (standardTemplateHtml) {
      console.log(`[ReportBuilder] Loaded standard template for '${session.outputFormat}': ${standardTemplateHtml.length} chars`);
    } else {
      console.log(`[ReportBuilder] No standard template for outputFormat '${session.outputFormat}'`);
    }

    const systemPrompt = buildGenerationSystemPrompt(
      session.outputFormat,
      session.tone,
      session.language,
      session.customInstructions,
      standardTemplateHtml,
    );

    let userContent = '';
    // Revision mode: send previous HTML + change request instead of full claims
    const previousHtml = revisionMode && session.revisions.length > 0
      ? session.revisions[session.activeRevisionIndex]?.html || ''
      : '';

    if (revisionMode && previousHtml) {
      userContent += `Hier ist das aktuelle Dokument:\n\n<current_document>\n${previousHtml}\n</current_document>\n\n`;
      userContent += `ÄNDERUNGSWUNSCH: ${feedback}\n\n`;
      userContent += `Erstelle eine überarbeitete Version des gesamten Dokuments. Behalte das Design, Layout und alle nicht betroffenen Inhalte bei. Gib NUR das vollständige, überarbeitete HTML aus.`;
      if (templateContext) userContent += templateContext;
    } else {
      if (session.brief) userContent += `AUFTRAG: ${session.brief}\n\n`;
      userContent += `Erstelle das Dokument aus diesen kuratierten Claims:\n\n${claimsText}`;
      if (templateContext) userContent += templateContext;
      if (session.generalNotes) userContent += `\n\nAllgemeine Anweisungen: ${session.generalNotes}`;
      if (feedback) userContent += `\n\nFeedback zur letzten Version (bitte einarbeiten): ${feedback}`;
    }

    console.log(`[ReportBuilder] Async generation: ${BRIDGE_URL}/v1/chat/completions (~${claimsText.length} chars claims)`);
    const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIDGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(900000), // 15min — large generations can take 10min+
    });

    console.log(`[ReportBuilder] Bridge generation response status: ${response.status}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Bridge API ${response.status}: ${errText}`);
    }

    const data = await response.json() as any;
    let content = data.choices?.[0]?.message?.content || '';
    console.log(`[ReportBuilder] Generation complete: ${content.length} chars`);

    // Inject Report Builder provenance meta tag into HTML output
    // This tag is used by the pre-commit hook to verify files were generated via Report Builder
    const session = loadSession(sessionId);
    const isHtml = session && (session.outputFormat === 'html' || session.outputFormat === 'presentation' || session.outputFormat === 'document');
    if (isHtml && content.includes('<head>')) {
      const rbMeta = `\n  <meta name="rb-session" content="${sessionId}">\n  <meta name="rb-generated" content="${new Date().toISOString()}">\n  <meta name="rb-format" content="${session?.outputFormat || 'html'}">`;
      content = content.replace('<head>', `<head>${rbMeta}`);
    }

    // Reload session (may have been updated by user while generation ran)
    const updatedSession = loadSession(sessionId);
    if (!updatedSession) return;
    // Push new revision
    const newRevision: Revision = {
      id: `R${updatedSession.revisions.length + 1}`,
      html: content,
      changePrompt: revisionMode ? (feedback || '') : '',
      addedSources: [],
      designHints: [...(updatedSession.templateSectionIds || [])],
      timestamp: new Date().toISOString(),
    };
    updatedSession.revisions.push(newRevision);
    updatedSession.activeRevisionIndex = updatedSession.revisions.length - 1;
    updatedSession.generatedContent = content;
    updatedSession.step = 'review';
    updatedSession.generationStatus = 'done';
    updatedSession.error = null;
    saveSession(updatedSession);
  } catch (err: any) {
    const errSession = loadSession(sessionId);
    if (errSession) {
      errSession.generationStatus = 'error';
      errSession.error = err.message;
      saveSession(errSession);
    }
    console.error('[ReportBuilder] Async generation error:', err.message);
  }
}

// Track in-flight generations to prevent duplicates
const activeGenerations = new Set<string>();

// POST /generate — document generation from curated claims (async, poll for results)
router.post('/generate', async (req, res) => {
  const { sessionId, feedback, revisionMode } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Guard: reject if generation already in flight for this session
  if (activeGenerations.has(sessionId)) {
    console.log(`[ReportBuilder] Rejected duplicate generate for ${sessionId} — already in flight`);
    return res.status(409).json({ error: 'Generation already in progress', status: 'generating' });
  }

  // Check for selected claims before starting
  const selectedCount = session.groups.reduce((a, g) => a + g.claims.filter(c => c.selected).length, 0);
  if (selectedCount === 0) {
    session.generationStatus = 'error';
    session.error = 'Keine Claims ausgewählt';
    saveSession(session);
    return res.status(400).json({ error: 'Keine Claims ausgewählt' });
  }

  // Mark as generating and respond immediately — generation runs in background
  session.generationStatus = 'generating';
  session.error = null;
  session.generatedContent = '';
  saveSession(session);

  activeGenerations.add(sessionId);

  // Fire-and-forget: generation continues even if client disconnects
  runGenerationAsync(sessionId, feedback || undefined, revisionMode || false)
    .catch(err => {
      console.error('[ReportBuilder] Background generation failed:', err);
    })
    .finally(() => {
      activeGenerations.delete(sessionId);
    });

  // Respond immediately so the client knows generation started
  res.json({ status: 'generating', message: 'Generation started in background. Poll session for results.' });
});

// PUT /sessions/:id/active-revision — switch displayed revision
router.put('/sessions/:id/active-revision', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { index } = req.body;
  if (typeof index !== 'number' || index < 0 || index >= session.revisions.length) {
    return res.status(400).json({ error: 'Invalid revision index' });
  }
  session.activeRevisionIndex = index;
  session.generatedContent = session.revisions[index].html;
  saveSession(session);
  res.json({ ok: true, activeRevisionIndex: index });
});

// GET /template-section/:id/html — Render a single template section as full HTML page
router.get('/template-section/:id/html', (req, res) => {
  const sectionIdParam = req.params.id;
  const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
  for (const relPath of htmlFiles) {
    const fullPath = join(BUSINESS_DIR, relPath);
    try {
      const sections = parseHtmlSections(fullPath, relPath);
      const section = sections.find(s => s.id === sectionIdParam);
      if (section) {
        // Build a standalone HTML page with the section + styles from its file
        const styleBlock = extractStyleBlock(fullPath);
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,sans-serif;overflow:hidden}${styleBlock}</style>
</head><body>${section.html}</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    } catch {}
  }
  res.status(404).send('<html><body style="color:#666;font:12px sans-serif;padding:10px">Section not found</body></html>');
});

// POST /auto-match-templates — AI-powered template matching based on curated claims
router.post('/auto-match-templates', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const selectedClaims = session.groups.flatMap(g =>
    g.claims.filter(c => c.selected).map(c => ({
      id: c.id,
      text: c.text.slice(0, 120),
      category: c.category,
      weight: c.weight,
    }))
  );

  if (selectedClaims.length === 0) {
    return res.status(400).json({ error: 'Keine Claims ausgewählt' });
  }

  // Load all template sections with enriched metadata
  const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
  const allSections: TemplateSection[] = [];
  for (const relPath of htmlFiles) {
    const fullPath = join(BUSINESS_DIR, relPath);
    try {
      const sections = parseHtmlSections(fullPath, relPath);
      // Only include sections with visual substance (skip tiny dividers)
      allSections.push(...sections.filter(s => s.type !== 'divider' && s.html.length > 150));
    } catch {}
  }

  // --- Phase A: Heuristic scoring ---
  const claimSignals = new Set<string>();
  const claimCategories = new Set<string>();
  for (const c of selectedClaims) {
    claimCategories.add(c.category);
    const text = c.text.toLowerCase();
    if (/vergleich|comparison|vs\./i.test(text)) claimSignals.add('comparison');
    if (/prozess|workflow|ablauf|schritt/i.test(text)) claimSignals.add('process');
    if (/preis|lizenz|option|€|kosten/i.test(text)) claimSignals.add('pricing');
    if (/architektur|system|stack|infrastruktur/i.test(text)) claimSignals.add('architecture');
    if (/roadmap|timeline|phase/i.test(text)) claimSignals.add('timeline');
    if (/feature|funktion|vorteil/i.test(text)) claimSignals.add('features');
    if (/roi|umsatz|revenue|profit|break-even/i.test(text)) claimSignals.add('roi');
    if (/markt|dach|potenzial|skalier/i.test(text)) claimSignals.add('market');
    if (/problem|schmerz|herausforderung/i.test(text)) claimSignals.add('problem');
    if (/lösung|anders|workflow statt/i.test(text)) claimSignals.add('solution');
    if (/vision|zukunft|erfolg/i.test(text)) claimSignals.add('vision');
    if (/demo|beispiel|screenshot/i.test(text)) claimSignals.add('demo');
    if (/partner|team|ingenieur/i.test(text)) claimSignals.add('team');
  }

  const scored = allSections.map(section => {
    let score = 0;

    // Signal overlap: each matching signal is worth 3 points
    const overlap = section.contentSignals.filter(s => claimSignals.has(s));
    score += overlap.length * 3;

    // SVG/diagram bonus: visual sections are highly valuable for presentations
    if (section.hasSvg) score += 5;
    if (section.type === 'diagram') score += 4;

    // Visual complexity bonus
    if (section.visualComplexity === 'high') score += 3;
    else if (section.visualComplexity === 'medium') score += 1;

    // Card grids are great for features/options
    if (section.hasCardGrid && (claimSignals.has('features') || claimSignals.has('pricing'))) score += 3;

    // Type bonuses based on claim categories
    if (section.type === 'hero') score += 2; // always useful
    if (section.type === 'cta' && claimSignals.has('vision')) score += 2;
    if (section.type === 'pricing' && claimCategories.has('metric')) score += 3;
    if (section.type === 'features' && claimCategories.has('fact')) score += 2;
    if (section.type === 'comparison' && claimSignals.has('comparison')) score += 4;
    if (section.type === 'metrics' && claimCategories.has('metric')) score += 3;

    // Penalize very small sections (likely just separators)
    if (section.html.length < 300) score -= 2;

    return { section, score, overlap };
  });

  // Sort by score desc, take top 15 for AI refinement
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 15);

  // --- Phase B: AI refinement via Bridge ---
  type Recommendation = { sectionId: string; score: number; reason: string; matchedSignals: string[] };
  let recommendations: Recommendation[] = [];

  try {
    const claimsSummary = selectedClaims.map(c => `[${c.category}] ${c.text}`).join('\n');
    const candidateSummary = candidates.map(c =>
      `ID: ${c.section.id} | "${c.section.title}" | type: ${c.section.type} | SVG: ${c.section.hasSvg} | signals: ${c.section.contentSignals.join(',')} | file: ${c.section.fileName} | complexity: ${c.section.visualComplexity}`
    ).join('\n');

    const prompt = `Du bist ein Design-Berater für Präsentationen. Gegeben sind kuratierte Claims und verfügbare Design-Vorlagen.

CLAIMS:
${claimsSummary}

VERFÜGBARE DESIGN-VORLAGEN (Template-Sections):
${candidateSummary}

AUFGABE: Wähle die 5-8 besten Template-Sections aus, die als Design-Referenz für eine Präsentation mit diesen Claims dienen sollen.

PRIORITÄTEN:
1. Sections mit SVG-Diagrammen/Visualisierungen bevorzugen — diese geben der KI-Generierung konkrete visuelle Vorlagen
2. Sections deren Signale zu den Claim-Kategorien passen
3. Visuell komplexe Sections (high complexity) vor einfachen
4. Mix aus verschiedenen Section-Typen (hero, diagram, features, pricing, etc.) für Abwechslung

Antworte NUR mit einem JSON-Array:
[{"sectionId": "...", "score": 1-10, "reason": "kurze Begründung"}]`;

    const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIDGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      const data = await response.json() as any;
      const aiText = data.choices?.[0]?.message?.content || '';
      // Extract JSON array from response
      const jsonMatch = aiText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{ sectionId: string; score: number; reason: string }>;
        recommendations = parsed.map(r => ({
          sectionId: r.sectionId,
          score: r.score,
          reason: r.reason,
          matchedSignals: candidates.find(c => c.section.id === r.sectionId)?.section.contentSignals || [],
        }));
        console.log(`[ReportBuilder] AI auto-match: ${recommendations.length} recommendations`);
      }
    }
  } catch (err: any) {
    console.error('[ReportBuilder] AI auto-match failed, using heuristic fallback:', err.message);
  }

  // Fallback: if AI didn't return results, use heuristic top 5-8
  if (recommendations.length === 0) {
    const topN = candidates.filter(c => c.score > 0).slice(0, 8);
    recommendations = topN.map(c => ({
      sectionId: c.section.id,
      score: Math.min(10, c.score),
      reason: `Heuristik: ${c.overlap.join(', ') || c.section.type}`,
      matchedSignals: c.section.contentSignals,
    }));
    console.log(`[ReportBuilder] Heuristic fallback: ${recommendations.length} recommendations`);
  }

  // Sort by score desc
  recommendations.sort((a, b) => b.score - a.score);

  res.json({
    recommendations,
    totalSections: allSections.length,
    totalCandidates: candidates.length,
  });
});

// POST /match-claim-templates — Per-claim template matching
// For each selected claim, find the best design template section
router.post('/match-claim-templates', async (req, res) => {
  try {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Collect selected claims with their group context
  const selectedClaims = session.groups.flatMap(g =>
    g.claims.filter(c => c.selected).map(c => ({
      id: c.id,
      text: (c.selectedVariant >= 0 && c.variants[c.selectedVariant]?.text) || c.text,
      category: c.category,
      weight: c.weight,
      groupName: g.groupName,
      context: c.context || '',
    }))
  );

  if (selectedClaims.length === 0) {
    return res.status(400).json({ error: 'Keine Claims ausgewählt' });
  }

  // Load all template sections (with enriched metadata, excluding dividers)
  const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
  const allSections: (TemplateSection & { fileDocType: string })[] = [];
  for (const relPath of htmlFiles) {
    const fullPath = join(BUSINESS_DIR, relPath);
    try {
      const sections = parseHtmlSections(fullPath, relPath);
      const docType = extractDocumentType(fullPath);
      for (const s of sections) {
        if (s.type !== 'divider' && s.html.length > 150) {
          allSections.push({ ...s, fileDocType: docType });
        }
      }
    } catch {}
  }

  // Light filter: remove tiny sections (dividers, empty), keep everything substantive
  // AI gets the actual text content, so it can do proper semantic matching
  const substantialSections = allSections.filter(s => s.type !== 'divider' && s.html.length > 300);

  // Build template catalog with ACTUAL TEXT CONTENT for semantic matching
  const templateCatalog = substantialSections.map(s => {
    const textContent = htmlToMarkdown(s.html).slice(0, 200);
    return { id: s.id, title: s.title, file: s.fileName, hasSvg: s.hasSvg, textContent };
  });

  console.log(`[ReportBuilder] Claim-template match: ${selectedClaims.length} claims, ${allSections.length}→${substantialSections.length} templates (size-filtered)`);

  // Build compact claims list for AI
  const claimsList = selectedClaims.map(c =>
    `${c.id}: [${c.category}] "${c.text.slice(0, 120)}" (Gruppe: ${c.groupName})`
  ).join('\n');

  const catalogList = templateCatalog.map(t =>
    `${t.id} [${t.file}]${t.hasSvg ? ' [hat SVG-Diagramm]' : ''}:\n${t.textContent}`
  ).join('\n---\n');

  // AI matching via Bridge — top 3 candidates per claim
  type ClaimMatch = { claimId: string; templateId: string; reason: string; rank: number };
  let matches: ClaimMatch[] = [];

  try {
    const prompt = `Du bist ein Präsentations-Designer. Ordne jedem Claim die passendsten Design-Vorlagen zu.

Unten siehst du den TEXTINHALT jeder Vorlage. Wähle die Vorlage, deren INHALT und AUFBAU am besten zum Claim passt — nicht nach einzelnen Stichwörtern, sondern nach dem Gesamtkontext.

CLAIMS (${selectedClaims.length}):
${claimsList}

DESIGN-VORLAGEN MIT TEXTINHALT (${templateCatalog.length}):
${catalogList}

REGELN:
1. Jeder Claim bekommt 1-3 Vorlagen, sortiert nach inhaltlicher Passgenauigkeit (rank 1=beste)
2. Matche nach INHALTLICHER ÄHNLICHKEIT: Eine Vorlage über Pricing passt zu einem Pricing-Claim, nicht weil das Wort vorkommt, sondern weil der Aufbau ähnlich ist
3. Vorlagen mit SVG-Diagrammen sind besonders wertvoll für technische/Prozess-Claims
4. VERSCHIEDENE Vorlagen verwenden — Abwechslung im Design!
5. Wenn keine Vorlage inhaltlich passt, lieber weglassen als eine schlechte Zuordnung

Antworte NUR mit JSON-Array:
[{"claimId": "cl-0", "templateId": "abc123", "reason": "kurze Begründung", "rank": 1}]`;

    const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIDGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (response.ok) {
      const data = await response.json() as any;
      const aiText = data.choices?.[0]?.message?.content || '';
      const jsonMatch = aiText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ClaimMatch[];
        matches = parsed.filter(m => m.templateId && m.templateId !== 'none');
        const uniqueClaims = new Set(matches.map(m => m.claimId)).size;
        console.log(`[ReportBuilder] Claim-template match: ${uniqueClaims}/${selectedClaims.length} claims matched (${matches.length} total candidates)`);
      } else {
        console.error('[ReportBuilder] Claim-template match: no JSON array found in AI response:', aiText.slice(0, 200));
      }
    } else {
      const errText = await response.text().catch(() => '');
      console.error(`[ReportBuilder] Claim-template match: Bridge returned ${response.status}: ${errText.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.error('[ReportBuilder] Claim-template match failed:', err.message);
  }

  // Enrich matches with template metadata for the frontend
  const enrichedMatches = matches.map(m => {
    const section = allSections.find(s => s.id === m.templateId);
    return {
      claimId: m.claimId,
      templateId: m.templateId,
      reason: m.reason,
      rank: m.rank || 1,
      selected: (m.rank || 1) === 1,  // Pre-select rank 1
      templateTitle: section?.title || '?',
      templateType: section?.type || 'other',
      templateFile: section?.fileName || '?',
      templatePreview: section?.preview?.slice(0, 80) || '',
      hasSvg: section?.hasSvg || false,
    };
  });

  // Persist matches in session for reload
  session.claimTemplateMatches = enrichedMatches;
  saveSession(session);

  res.json({
    matches: enrichedMatches,
    totalClaims: selectedClaims.length,
    totalTemplates: templateCatalog.length,
  });
  } catch (err: any) {
    console.error('[ReportBuilder] match-claim-templates crashed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// PUT /sessions/:id/claim-templates — Apply claim-template assignments to session
router.put('/sessions/:id/claim-templates', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { assignments } = req.body; // Array of { claimId, templateId, reason }
  if (!Array.isArray(assignments)) return res.status(400).json({ error: 'assignments array required' });

  // Apply assignments to claims
  for (const a of assignments) {
    for (const g of session.groups) {
      const claim = g.claims.find(c => c.id === a.claimId);
      if (claim) {
        claim.templateId = a.templateId || undefined;
        claim.templateReason = a.reason || undefined;
      }
    }
  }

  // Also update templateSectionIds (union of all assigned templates)
  const uniqueTemplateIds = [...new Set(assignments.map((a: any) => a.templateId).filter(Boolean))];
  session.templateSectionIds = uniqueTemplateIds;

  saveSession(session);
  res.json({ ok: true, assignedCount: assignments.filter((a: any) => a.templateId).length });
});

// POST /save — save generated content to temp folder
const REPORT_OUTPUT_DIR = '/root/projekte/local-storage/report-builder';
router.post('/save', (req, res) => {
  const { sessionId, filename } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.generatedContent) return res.status(400).json({ error: 'No generated content to save' });

  if (!existsSync(REPORT_OUTPUT_DIR)) mkdirSync(REPORT_OUTPUT_DIR, { recursive: true });

  // Auto-generate filename from session name + timestamp
  const ext = (session.outputFormat === 'html' || session.outputFormat === 'presentation' || session.outputFormat === 'document') ? 'html' : 'md';
  const safeName = (session.name || 'report').replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '-').replace(/-+/g, '-').toLowerCase();
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const finalFilename = filename || `${safeName}_${ts}.${ext}`;

  const filePath = join(REPORT_OUTPUT_DIR, finalFilename);
  writeFileSync(filePath, session.generatedContent);

  res.json({ ok: true, path: filePath, filename: finalFilename });
});

// =============================================================================
// Template System — Section-based design references from business HTML files
// =============================================================================

interface TemplateSection {
  id: string;           // hash of file+index for stable identity
  fileRelPath: string;  // relative to BUSINESS_DIR
  fileName: string;
  sectionIndex: number;
  title: string;        // extracted from h1/h2/.section-title or comment
  preview: string;      // first ~200 chars of text content
  html: string;         // raw section HTML
  type: 'hero' | 'content' | 'divider' | 'cta' | 'footer' | 'features' | 'comparison' | 'diagram' | 'metrics' | 'pricing' | 'other';
  // Enriched metadata for auto-matching
  hasSvg: boolean;
  svgCount: number;
  hasTable: boolean;
  hasCardGrid: boolean;
  visualComplexity: 'low' | 'medium' | 'high';
  contentSignals: string[];  // e.g. ['comparison', 'process', 'pricing', 'architecture']
}

interface TemplateFile {
  relPath: string;
  fileName: string;
  documentType: 'presentation' | 'document' | 'unknown'; // from <meta name="template-type">
  sectionCount: number;
  sections: TemplateSection[];
}

interface TemplateFavorites {
  favorites: string[];  // section IDs
  categories: Record<string, string>; // sectionId → category label
}

const TEMPLATE_STORE_PATH = join(SESSIONS_DIR, '_template-favorites.json');

function loadTemplateFavorites(): TemplateFavorites {
  if (existsSync(TEMPLATE_STORE_PATH)) {
    try { return JSON.parse(readFileSync(TEMPLATE_STORE_PATH, 'utf-8')); } catch {}
  }
  return { favorites: [], categories: {} };
}

function saveTemplateFavorites(data: TemplateFavorites): void {
  writeFileSync(TEMPLATE_STORE_PATH, JSON.stringify(data, null, 2));
}

/** Generate stable ID from file path + section index */
function sectionId(filePath: string, index: number): string {
  return createHash('md5').update(`${filePath}:${index}`).digest('hex').slice(0, 12);
}

/** Classify section type by its HTML content */
function classifySection(html: string): TemplateSection['type'] {
  const lower = html.toLowerCase();
  if (/<div[^>]*class="[^"]*divider[^"]*"/i.test(html)) return 'divider';
  if (/<footer[\s>]/i.test(html)) return 'footer';
  // SVG-heavy sections with flowchart/architecture patterns
  const svgCount = (lower.match(/<svg/g) || []).length;
  if (svgCount > 0 && (/<(line|polyline|marker|path[^>]*d=)/i.test(html) || /arrow|flow|architektur|workflow/i.test(html))) return 'diagram';
  // Pricing sections
  if (/preis|pricing|lizenz|option\s*[abc]|€|eur\b|kosten/i.test(html) && (/card|grid|flex/i.test(html))) return 'pricing';
  // Feature grids (3+ similar child elements)
  if (/<section[^>]*class="[^"]*feature/i.test(html) || ((lower.match(/class="[^"]*card/g) || []).length >= 3)) return 'features';
  // Comparison (tables or side-by-side)
  if (/<table/i.test(html) && /vergleich|comparison|vs\.|versus/i.test(html)) return 'comparison';
  // Metrics (stat boxes, numbers)
  if (/class="[^"]*(?:stat|metric|number|kpi)/i.test(html) || ((lower.match(/class="[^"]*(?:stat|metric|number)/g) || []).length >= 2)) return 'metrics';
  // Hero
  if (/<section[^>]*class="[^"]*hero[^"]*"/i.test(html) || /<h1[\s>]/i.test(html)) return 'hero';
  // CTA
  if (/<section[^>]*class="[^"]*cta/i.test(html) || /nächste.*schritt|next.*step|call.*to.*action|jetzt.*starten/i.test(html)) return 'cta';
  if (/<section[\s>]/i.test(html)) return 'content';
  return 'other';
}

/** Analyze section content for auto-matching metadata */
function analyzeSectionContent(html: string): Pick<TemplateSection, 'hasSvg' | 'svgCount' | 'hasTable' | 'hasCardGrid' | 'visualComplexity' | 'contentSignals'> {
  const lower = html.toLowerCase();
  const svgCount = (lower.match(/<svg/g) || []).length;
  const hasSvg = svgCount > 0;
  const hasTable = /<table/i.test(html);
  const cardCount = (lower.match(/class="[^"]*card/g) || []).length;
  const hasCardGrid = cardCount >= 2;

  // Visual complexity
  let complexity: 'low' | 'medium' | 'high' = 'low';
  const indicators = svgCount + (hasTable ? 1 : 0) + Math.floor(cardCount / 2) + ((lower.match(/gradient|backdrop-filter|animation|transform/g) || []).length > 2 ? 1 : 0);
  if (indicators >= 3 || html.length > 8000) complexity = 'high';
  else if (indicators >= 1 || html.length > 3000) complexity = 'medium';

  // Content signals
  const signals: string[] = [];
  if (/vergleich|comparison|vs\.|versus|gegenüber/i.test(html)) signals.push('comparison');
  if (/prozess|workflow|ablauf|schritt|step|pipeline/i.test(html)) signals.push('process');
  if (/preis|pricing|lizenz|€|kosten|invest|option/i.test(html)) signals.push('pricing');
  if (/architektur|architecture|infrastruktur|system|stack/i.test(html)) signals.push('architecture');
  if (/roadmap|timeline|zeitplan|phase|meilenstein/i.test(html)) signals.push('timeline');
  if (/feature|funktion|leistung|vorteil|benefit/i.test(html)) signals.push('features');
  if (/roi|rendite|umsatz|revenue|gewinn|profit|break-even/i.test(html)) signals.push('roi');
  if (/team|partner|gründer|founder|ingenieur/i.test(html)) signals.push('team');
  if (/markt|market|dach|skalier|potenzial/i.test(html)) signals.push('market');
  if (/demo|screenshot|vorschau|beispiel|so sieht/i.test(html)) signals.push('demo');
  if (hasSvg && /<(line|polyline|path|marker)/i.test(html)) signals.push('diagram');
  if (/problem|herausforderung|schmerz|pain|angst|stress/i.test(html)) signals.push('problem');
  if (/lösung|solution|antwort|anders/i.test(html)) signals.push('solution');
  if (/vision|zukunft|stellen sie sich vor|erfolg/i.test(html)) signals.push('vision');

  return { hasSvg, svgCount, hasTable, hasCardGrid, visualComplexity: complexity, contentSignals: signals };
}

/** Extract title from section HTML */
function extractSectionTitle(html: string, commentHint?: string): string {
  // Try .section-title first
  const stMatch = html.match(/class="section-title"[^>]*>([^<]+)</i);
  if (stMatch) return stMatch[1].trim();
  // Try h1
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim();
  // Try h2
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) return h2[1].replace(/<[^>]+>/g, '').trim();
  // Try h3
  const h3 = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3) return h3[1].replace(/<[^>]+>/g, '').trim();
  // Fallback to comment hint
  if (commentHint) return commentHint;
  return 'Unbenannt';
}

/** Extract preview text from section HTML */
function extractPreview(html: string): string {
  let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}

/** Parse HTML file into sections */
function parseHtmlSections(filePath: string, relPath: string): TemplateSection[] {
  const content = readFileSync(filePath, 'utf-8');
  const sections: TemplateSection[] = [];
  const fileName = relPath.split('/').pop() || relPath;

  // Extract <style> block separately (shared across all sections)
  // We'll store it but not count it as a section

  // Split by section/divider tags, keeping the comment before each
  // Pattern: find all <section...>...</section> and <div class="divider"...>...</div> blocks
  const sectionRegex = /(?:<!--[\s\S]*?-->\s*)?(?:<section[\s\S]*?<\/section>|<div[^>]*class="[^"]*divider[^"]*"[\s\S]*?<\/div>|<footer[\s\S]*?<\/footer>)/gi;
  let match;
  let index = 0;

  while ((match = sectionRegex.exec(content)) !== null) {
    const html = match[0];
    // Extract comment hint
    const commentMatch = html.match(/<!--[\s═─\s]*([A-ZÄÖÜa-zäöü][^\n═─]*?)[\s═─\s]*-->/);
    const commentHint = commentMatch ? commentMatch[1].replace(/[→←↓↑]/g, '').trim() : undefined;

    const title = extractSectionTitle(html, commentHint);
    const preview = extractPreview(html);
    const type = classifySection(html);
    const id = sectionId(relPath, index);

    const meta = analyzeSectionContent(html);
    sections.push({ id, fileRelPath: relPath, fileName, sectionIndex: index, title, preview, html, type, ...meta });
    index++;
  }

  return sections;
}

/** Extract the <style> block from an HTML file */
function extractStyleBlock(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return styleMatch ? styleMatch[1] : '';
}

/** Extract document type from <meta name="template-type" content="..."> */
function extractDocumentType(filePath: string): 'presentation' | 'document' | 'unknown' {
  const content = readFileSync(filePath, 'utf-8');
  const m = content.match(/<meta\s+name=["']template-type["']\s+content=["'](presentation|document)["']/i);
  if (m) return m[1].toLowerCase() as 'presentation' | 'document';
  // Fallback: detect by content signals
  const hasHero = /<section[^>]*class="[^"]*hero/i.test(content);
  const hasNavy = /background.*#0a0f1e|--navy.*#0a0f1e/i.test(content);
  const hasPageBreaks = /page-break-after:\s*always/i.test(content);
  const hasPageClass = /class="[^"]*\bpage\b/i.test(content);
  if (hasHero && hasNavy) return 'presentation';
  if (hasPageBreaks && hasPageClass) return 'document';
  return 'unknown';
}

/** Recursively find all HTML files in a directory */
function findHtmlFiles(dirPath: string, baseDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dirPath)) return results;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      // Skip archive directories
      if (entry.name === 'archive' || entry.name === 'node_modules') continue;
      results.push(...findHtmlFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.html') && !entry.name.startsWith('TEMPLATE-')) {
      results.push(relative(baseDir, fullPath));
    }
  }
  return results;
}

// GET /template-preview — serve a template HTML file for iframe preview
router.get('/template-preview', (req, res) => {
  try {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ error: 'file query param required' });
    // Only allow files within BUSINESS_DIR
    const fullPath = join(BUSINESS_DIR, file);
    if (!fullPath.startsWith(BUSINESS_DIR)) return res.status(403).json({ error: 'Access denied' });
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    const html = readFileSync(fullPath, 'utf-8');
    res.json({ html });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /templates — scan business dir for HTML files, parse sections
router.get('/templates', (_req, res) => {
  try {
    const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
    const favorites = loadTemplateFavorites();
    const files: TemplateFile[] = [];

    for (const relPath of htmlFiles) {
      const fullPath = join(BUSINESS_DIR, relPath);
      try {
        const sections = parseHtmlSections(fullPath, relPath);
        if (sections.length > 0) {
          files.push({
            relPath,
            fileName: relPath.split('/').pop() || relPath,
            documentType: extractDocumentType(fullPath),
            sectionCount: sections.length,
            sections: sections.map(s => ({
              ...s,
              html: '', // Don't send full HTML in listing — too large
            })),
          });
        }
      } catch (err: any) {
        console.error(`[Templates] Error parsing ${relPath}:`, err.message);
      }
    }

    res.json({ files, favorites });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /templates/section?id=xxx — get full HTML of a single section
router.get('/templates/section', (req, res) => {
  try {
    const sectionIdParam = req.query.id as string;
    if (!sectionIdParam) return res.status(400).json({ error: 'id query param required' });

    const htmlFiles = findHtmlFiles(BUSINESS_DIR, BUSINESS_DIR);
    for (const relPath of htmlFiles) {
      const fullPath = join(BUSINESS_DIR, relPath);
      try {
        const sections = parseHtmlSections(fullPath, relPath);
        const found = sections.find(s => s.id === sectionIdParam);
        if (found) {
          const styleBlock = extractStyleBlock(fullPath);
          return res.json({ section: found, styleBlock });
        }
      } catch {}
    }
    res.status(404).json({ error: 'Section not found' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /templates/favorites — update favorites & categories
router.put('/templates/favorites', (req, res) => {
  try {
    const { favorites, categories } = req.body;
    const data = loadTemplateFavorites();
    if (favorites !== undefined) data.favorites = favorites;
    if (categories !== undefined) data.categories = { ...data.categories, ...categories };
    saveTemplateFavorites(data);
    res.json({ ok: true, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /templates/toggle-favorite — toggle a section as favorite
router.post('/templates/toggle-favorite', (req, res) => {
  try {
    const { sectionId: sid, category } = req.body;
    if (!sid) return res.status(400).json({ error: 'sectionId required' });
    const data = loadTemplateFavorites();
    const idx = data.favorites.indexOf(sid);
    if (idx >= 0) {
      data.favorites.splice(idx, 1);
      delete data.categories[sid];
    } else {
      data.favorites.push(sid);
      if (category) data.categories[sid] = category;
    }
    saveTemplateFavorites(data);
    res.json({ ok: true, isFavorite: idx < 0, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /templates/set-category — set category for a section
router.post('/templates/set-category', (req, res) => {
  try {
    const { sectionId: sid, category } = req.body;
    if (!sid) return res.status(400).json({ error: 'sectionId required' });
    const data = loadTemplateFavorites();
    if (category) {
      data.categories[sid] = category;
    } else {
      delete data.categories[sid];
    }
    saveTemplateFavorites(data);
    res.json({ ok: true, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

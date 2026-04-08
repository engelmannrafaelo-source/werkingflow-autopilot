import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// --- Types ---
interface PromptTemplate {
  id: string;
  label: string;
  message: string;
  category: "reply" | "start";
  subject?: string;
  order: number;
  createdAt: string;
}

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { id: "tpl_fix_commit", label: "Fix & Commit", message: "Mache die architektonisch sauberste Lösung. Defensive coding, fail fast. Committe die Änderungen.", category: "reply", order: 1, createdAt: "2026-03-01T00:00:00Z" },
  { id: "tpl_fix_test_commit", label: "Fix → Test → Commit", message: "Spawne einen Subtask um die Probleme zu beheben: Defensive coding, fail fast. Committe. Dann teste weiter bis alles voll funktionsfähig ist.", category: "reply", order: 2, createdAt: "2026-03-01T00:00:00Z" },
  { id: "tpl_weiter_testen", label: "Weiter testen", message: "Teste weiter bis alles voll funktionsfähig ist.", category: "reply", order: 3, createdAt: "2026-03-01T00:00:00Z" },
  { id: "tpl_approve_plan", label: "Approve Plan", message: "Ja, mach weiter mit diesem Plan.", category: "reply", order: 4, createdAt: "2026-03-01T00:00:00Z" },
  { id: "tpl_weiter", label: "Weiter", message: "Weiter.", category: "reply", order: 5, createdAt: "2026-03-01T00:00:00Z" },
  { id: "tpl_unified_test", label: "Unified Test Run", message: "Führe den Unified Tester aus und behebe alle gefundenen Probleme. Defensive coding, fail fast. Committe nach jedem Fix.", category: "start", subject: "Test Run", order: 1, createdAt: "2026-03-01T00:00:00Z" },
];

// --- State ---
let TEMPLATES_FILE: string;

function loadTemplates(): PromptTemplate[] {
  if (!existsSync(TEMPLATES_FILE)) {
    writeFileSync(TEMPLATES_FILE, JSON.stringify(DEFAULT_TEMPLATES, null, 2));
    return [...DEFAULT_TEMPLATES];
  }
  try { return JSON.parse(readFileSync(TEMPLATES_FILE, "utf8")); } catch { return [...DEFAULT_TEMPLATES]; }
}

function saveTemplates(templates: PromptTemplate[]) {
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

// --- Router ---
const router = Router();

export function initTemplatesRouter(dataDir: string) {
  TEMPLATES_FILE = join(dataDir, "prompt-templates.json");
}

router.get("/", (_req, res) => {
  const templates = loadTemplates();
  templates.sort((a, b) => a.order - b.order);
  res.json({ templates });
});

router.post("/", (req, res) => {
  const { label, message, category, subject, order } = req.body;
  if (!label || !message || !category) return res.status(400).json({ error: "label, message, and category are required" });
  if (category !== "reply" && category !== "start") return res.status(400).json({ error: "category must be reply or start" });
  const templates = loadTemplates();
  const maxOrder = templates.filter(t => t.category === category).reduce((m, t) => Math.max(m, t.order), 0);
  const newTemplate: PromptTemplate = {
    id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label: label.trim(),
    message: message.trim(),
    category,
    subject: subject?.trim() || undefined,
    order: typeof order === "number" ? order : maxOrder + 1,
    createdAt: new Date().toISOString(),
  };
  templates.push(newTemplate);
  saveTemplates(templates);
  res.json({ template: newTemplate });
});

router.put("/:id", (req, res) => {
  const templates = loadTemplates();
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Template not found" });
  const { label, message, category, subject, order } = req.body;
  if (label !== undefined) templates[idx].label = label.trim();
  if (message !== undefined) templates[idx].message = message.trim();
  if (category === "reply" || category === "start") templates[idx].category = category;
  if (subject !== undefined) templates[idx].subject = subject?.trim() || undefined;
  if (typeof order === "number") templates[idx].order = order;
  saveTemplates(templates);
  res.json({ template: templates[idx] });
});

router.delete("/:id", (req, res) => {
  const templates = loadTemplates();
  const filtered = templates.filter(t => t.id !== req.params.id);
  if (filtered.length === templates.length) return res.status(404).json({ error: "Template not found" });
  saveTemplates(filtered);
  res.json({ ok: true });
});

export default router;

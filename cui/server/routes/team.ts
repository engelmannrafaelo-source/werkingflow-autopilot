import { Router, Request, Response } from 'express';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

import { parsePersonaMd } from './shared/utils.js';
import { PATHS, BRIDGE_URL } from '../config/paths.js';
import { bridgeChat } from '../lib/bridge-fetch.js';

// --- Task Management (file-backed: data/active/team/tasks.json) ---
interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;        // Persona ID
  status: 'backlog' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
  documentRef?: string;
  createdAt: string;
  updatedAt: string;
  // Preserved pass-through fields from legacy demo data
  tags?: string[];
  dependencies?: string[];
  comments?: unknown[];
  estimatedHours?: number;
  actualHours?: number;
  dueDate?: string;
}

const TASKS_FILE = join(PATHS.dataDir, 'active/team/tasks.json');

function normalizeStatus(s: unknown): Task['status'] {
  const str = String(s ?? '').toLowerCase();
  if (str === 'todo' || str === 'blocked') return 'backlog';
  if (str === 'in_review' || str === 'review') return 'review';
  if (str === 'completed' || str === 'done') return 'done';
  if (str === 'in_progress') return 'in_progress';
  return 'backlog';
}

function normalizePriority(p: unknown): Task['priority'] {
  const str = String(p ?? 'medium').toLowerCase();
  if (str === 'critical' || str === 'high') return 'high';
  if (str === 'low') return 'low';
  return 'medium';
}

function normalizeTask(raw: any): Task {
  return {
    id: String(raw.id ?? `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    assignee: String(raw.assignedTo ?? raw.assignee ?? ''),
    status: normalizeStatus(raw.status),
    priority: normalizePriority(raw.priority),
    documentRef: raw.documentRef,
    createdAt: String(raw.created ?? raw.createdAt ?? new Date().toISOString()),
    updatedAt: String(raw.updated ?? raw.updatedAt ?? new Date().toISOString()),
    tags: Array.isArray(raw.tags) ? raw.tags : undefined,
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : undefined,
    comments: Array.isArray(raw.comments) ? raw.comments : undefined,
    estimatedHours: typeof raw.estimatedHours === 'number' ? raw.estimatedHours : undefined,
    actualHours: typeof raw.actualHours === 'number' ? raw.actualHours : undefined,
    dueDate: raw.dueDate,
  };
}

async function loadTasks(): Promise<Task[]> {
  try {
    const content = await readFile(TASKS_FILE, 'utf-8');
    const data = JSON.parse(content);
    const raw = Array.isArray(data) ? data : (Array.isArray(data?.tasks) ? data.tasks : []);
    return raw.map(normalizeTask);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveTasks(tasks: Task[]): Promise<void> {
  await mkdir(dirname(TASKS_FILE), { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

export default function createTeamRouter(): Router {
  const router = Router();

  // GET /api/team/personas
  // Returns: PersonaCard[]
  router.get('/personas', async (_req: Request, res: Response) => {
    const personasPath = PATHS.personasDir;
    try {
      const files = await readdir(personasPath);
      const personaFiles = files.filter(f => f.endsWith('.md'));

      const personas = await Promise.all(
        personaFiles.map(async (file) => {
          const content = await readFile(join(personasPath, file), 'utf-8');
          return parsePersonaMd(file, content);
        })
      );

      res.json(personas);
    } catch (err: any) {
      console.error('[Team API] Error loading personas:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/worklist/:personaId
  // Returns: string (markdown content)
  router.get('/worklist/:personaId', async (req: Request, res: Response) => {
    const { personaId } = req.params;
    const worklistPath = join(PATHS.worklistsDir, `${personaId}.md`);

    try {
      const content = await readFile(worklistPath, 'utf-8');
      res.type('text/markdown').send(content);
    } catch (err: any) {
      console.error(`[Team API] Worklist not found for ${personaId}:`, err);
      res.status(404).send('Worklist not found');
    }
  });

  // GET /api/team/tasks
  router.get('/tasks', async (req: Request, res: Response) => {
    try {
      const { assignee, status } = req.query;
      let tasks = await loadTasks();
      if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
      if (status) tasks = tasks.filter(t => t.status === status);
      res.json(tasks);
    } catch (err: any) {
      console.error('[Team API] GET /tasks failed:', err);
      res.status(500).json({ error: err.message ?? 'load failed' });
    }
  });

  // POST /api/team/tasks
  router.post('/tasks', async (req: Request, res: Response) => {
    try {
      const tasks = await loadTasks();
      const now = new Date().toISOString();
      const task = normalizeTask({
        id: `TASK-${Date.now()}`,
        ...req.body,
        createdAt: now,
        updatedAt: now,
      });
      if (!task.title.trim()) return res.status(400).json({ error: 'title required' });
      tasks.push(task);
      await saveTasks(tasks);
      res.status(201).json(task);
    } catch (err: any) {
      console.error('[Team API] POST /tasks failed:', err);
      res.status(500).json({ error: err.message ?? 'save failed' });
    }
  });

  // PATCH /api/team/tasks/:id
  router.patch('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const tasks = await loadTasks();
      const idx = tasks.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Task not found' });

      const { title, description, status, priority, assignee, documentRef } = req.body;
      const task = tasks[idx];
      if (title !== undefined) task.title = String(title);
      if (description !== undefined) task.description = String(description);
      if (status !== undefined) task.status = normalizeStatus(status);
      if (priority !== undefined) task.priority = normalizePriority(priority);
      if (assignee !== undefined) task.assignee = String(assignee);
      if (documentRef !== undefined) task.documentRef = String(documentRef);
      task.updatedAt = new Date().toISOString();
      await saveTasks(tasks);
      res.json(task);
    } catch (err: any) {
      console.error('[Team API] PATCH /tasks failed:', err);
      res.status(500).json({ error: err.message ?? 'save failed' });
    }
  });

  // DELETE /api/team/tasks/:id
  router.delete('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const tasks = await loadTasks();
      const idx = tasks.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Task not found' });
      tasks.splice(idx, 1);
      await saveTasks(tasks);
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[Team API] DELETE /tasks failed:', err);
      res.status(500).json({ error: err.message ?? 'save failed' });
    }
  });

  // GET /api/team/events - Load activity events from events.json
  router.get('/events', async (_req: Request, res: Response) => {
    const eventsPath = join(PATHS.dataDir, 'active/team/events.json');
    try {
      const content = await readFile(eventsPath, 'utf-8');
      const data = JSON.parse(content);
      // Wrap array in object if needed (VirtualOffice expects { events: [...] })
      const response = Array.isArray(data) ? { events: data } : data;
      res.json(response);
    } catch (err: any) {
      console.error('Failed to load events.json:', err);
      res.status(500).json({ error: 'Failed to load events', events: [] });
    }
  });

  // GET /api/team/reviews - Load reviews from reviews.json
  router.get('/reviews', async (_req: Request, res: Response) => {
    const reviewsPath = join(PATHS.dataDir, 'active/team/reviews.json');
    try {
      const content = await readFile(reviewsPath, 'utf-8');
      const data = JSON.parse(content);
      // Accept both array format and { reviews: [...] } format
      const reviews = Array.isArray(data) ? data : (data.reviews || []);
      console.log('[Reviews API] Loaded', reviews.length, 'reviews from', reviewsPath);
      res.json(reviews);
    } catch (err: any) {
      console.error('[Reviews API] Failed to load reviews.json:', err);
      res.status(500).json([]);
    }
  });

  // GET /api/team/task-board - Load normalized tasks (same store as /tasks CRUD)
  router.get('/task-board', async (_req: Request, res: Response) => {
    try {
      const tasks = await loadTasks();
      res.json(tasks);
    } catch (err: any) {
      console.error('[Team API] GET /task-board failed:', err);
      res.status(500).json({ error: err.message ?? 'load failed' });
    }
  });

  // --- Persona Chat via AI-Bridge ---
  // POST /api/team/chat/:personaId
  router.post('/chat/:personaId', async (req: Request, res: Response) => {
    const { personaId } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }

    try {
      // Load Persona System Prompt
      const personasPath = PATHS.personasDir;
      const files = await readdir(personasPath);
      const personaFile = files.find(f => f.startsWith(personaId + '-') && f.endsWith('.md'));

      if (!personaFile) {
        return res.status(404).json({ error: 'Persona not found' });
      }

      const content = await readFile(join(personasPath, personaFile), 'utf-8');
      const systemPrompt = `Du bist ${personaId.toUpperCase()}.

${content}

Antworte im Stil dieser Persona. Beziehe dich auf deine Worklist und aktuelle Aufgaben.`;

      // Session ID: rafael-max (User-Persona)
      const sessionId = `rafael-${personaId}`;

      // Call Bridge with Session
      const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;

      if (!BRIDGE_KEY) {
        return res.status(500).json({ error: 'AI_BRIDGE_API_KEY not set' });
      }

      const assistantMessage = await bridgeChat({
        model: 'claude-sonnet-4-5-20250929',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        max_tokens: 2048,
        timeout: 60000,
      });

      res.json({
        message: assistantMessage,
        sessionId,
      });
    } catch (err: any) {
      console.error('[Team Chat] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/chat/:personaId/history
  router.get('/chat/:personaId/history', async (req: Request, res: Response) => {
    const { personaId } = req.params;
    const sessionId = `rafael-${personaId}`;

    try {
      const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;

      if (!BRIDGE_KEY) {
        return res.json({ messages: [] });
      }

      const response = await fetch(
        `${BRIDGE_URL}/v1/sessions/${sessionId}`,
        { headers: { Authorization: `Bearer ${BRIDGE_KEY}` }, signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) {
        return res.json({ messages: [] });
      }

      const session = await response.json();
      res.json({ messages: session.messages || [] });
    } catch (err: any) {
      console.error('[Team Chat History] Error:', err);
      res.json({ messages: [] });
    }
  });

  return router;
}

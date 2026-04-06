import { Router, Request, Response } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

import { parsePersonaMd } from './shared/utils.js';
import { PATHS, BRIDGE_URL } from '../config/paths.js';
import { bridgeChat } from '../lib/bridge-fetch.js';

// --- Task Management ---
interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;        // Persona ID
  status: 'backlog' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
  documentRef?: string;    // Optional: Business-Doc Path
  createdAt: string;
  updatedAt: string;
}

let tasks: Task[] = [];  // In-Memory for MVP - later DB

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
  router.get('/tasks', (req: Request, res: Response) => {
    const { assignee, status } = req.query;
    let filtered = tasks;

    if (assignee) filtered = filtered.filter(t => t.assignee === assignee);
    if (status) filtered = filtered.filter(t => t.status === status);

    res.json(filtered);
  });

  // POST /api/team/tasks
  router.post('/tasks', (req: Request, res: Response) => {
    const task: Task = {
      id: Date.now().toString(),
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.push(task);
    res.json(task);
  });

  // PATCH /api/team/tasks/:id
  router.patch('/tasks/:id', (req: Request, res: Response) => {
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).send('Task not found');

    const { title, description, status, priority, assignee } = req.body;
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (status !== undefined) task.status = status;
    if (priority !== undefined) task.priority = priority;
    if (assignee !== undefined) task.assignee = assignee;
    task.updatedAt = new Date().toISOString();
    res.json(task);
  });

  // DELETE /api/team/tasks/:id
  router.delete('/tasks/:id', (req: Request, res: Response) => {
    const index = tasks.findIndex(t => t.id === req.params.id);
    if (index === -1) return res.status(404).send('Task not found');

    tasks.splice(index, 1);
    res.json({ ok: true });
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

  // GET /api/team/task-board - Load tasks from tasks.json (for Task Board)
  router.get('/task-board', async (_req: Request, res: Response) => {
    const tasksPath = join(PATHS.dataDir, 'active/team/tasks.json');
    try {
      const content = await readFile(tasksPath, 'utf-8');
      const data = JSON.parse(content);
      res.json(data); // Returns { tasks: [...] }
    } catch (err: any) {
      console.error('Failed to load tasks.json:', err);
      res.status(500).json({ error: 'Failed to load tasks', tasks: [] });
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

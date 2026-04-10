/**
 * Partner Tasks Route — Task assignment and status tracking for partners.
 *
 * Endpoints:
 *   GET    /api/partner/tasks?userId=X   — Tasks for a specific user (or all, admin)
 *   POST   /api/partner/tasks            — Create task (admin only)
 *   PATCH  /api/partner/tasks/:id        — Update status / add comment
 *   DELETE /api/partner/tasks/:id        — Delete task (admin only)
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { requireRole } from '../auth/middleware.js';

// --- Types ---
export interface TaskComment {
  from: string;
  text: string;
  date: string;
}

export interface PartnerTask {
  id: string;
  title: string;
  description: string;
  assignedTo: string;
  assignedBy: string;
  status: 'assigned' | 'in-progress' | 'done' | 'review';
  priority: 'high' | 'medium' | 'low';
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
}

// --- State ---
let TASKS_FILE: string;

function loadTasks(): PartnerTask[] {
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`[partner-tasks] Failed to parse tasks file: ${err}`);
  }
}

function saveTasks(tasks: PartnerTask[]): void {
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Router ---
const router = Router();

export function initPartnerTasksRouter(dataDir: string): void {
  TASKS_FILE = join(dataDir, 'partner-tasks.json');
}

/** GET /api/partner/tasks — List tasks. Admin sees all, partner sees own. */
router.get('/tasks', (req, res) => {
  const tasks = loadTasks();
  const userId = req.query.userId as string | undefined;

  // If no auth (dev mode) or explicit userId filter: filter by userId
  // Admin with no userId filter → all tasks
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'product-owner';

  let result: PartnerTask[];
  if (userId) {
    result = tasks.filter(t => t.assignedTo === userId);
  } else if (isAdmin) {
    result = tasks;
  } else if (req.user) {
    // Authenticated non-admin: own tasks only
    result = tasks.filter(t => t.assignedTo === req.user!.sub);
  } else {
    // Auth disabled — return all (dev server)
    result = tasks;
  }

  res.json({ tasks: result });
});

/** POST /api/partner/tasks — Create task (admin only). */
router.post('/tasks', requireRole('admin', 'product-owner'), (req, res) => {
  const { title, description, assignedTo, priority, dueDate } = req.body as Partial<PartnerTask> & { dueDate?: string };

  if (!title?.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  if (!assignedTo?.trim()) {
    res.status(400).json({ error: 'assignedTo is required' });
    return;
  }
  if (priority && !['high', 'medium', 'low'].includes(priority)) {
    res.status(400).json({ error: 'priority must be high, medium, or low' });
    return;
  }

  const now = new Date().toISOString();
  const task: PartnerTask = {
    id: generateId(),
    title: title.trim(),
    description: (description ?? '').trim(),
    assignedTo: assignedTo.trim(),
    assignedBy: req.user?.sub ?? 'admin',
    status: 'assigned',
    priority: (priority as PartnerTask['priority']) ?? 'medium',
    dueDate: dueDate?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };

  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  res.status(201).json({ task });
});

/** PATCH /api/partner/tasks/:id — Update status or add comment. */
router.patch('/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const task = tasks[idx];
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'product-owner';
  const isAssignee = !req.user || req.user.sub === task.assignedTo;

  if (!isAdmin && !isAssignee) {
    res.status(403).json({ error: 'Not authorized to update this task' });
    return;
  }

  const { status, priority, title, description, dueDate, comment } = req.body as {
    status?: PartnerTask['status'];
    priority?: PartnerTask['priority'];
    title?: string;
    description?: string;
    dueDate?: string;
    comment?: { from: string; text: string };
  };

  if (status !== undefined) {
    if (!['assigned', 'in-progress', 'done', 'review'].includes(status)) {
      res.status(400).json({ error: 'Invalid status value' });
      return;
    }
    task.status = status;
  }

  // Admin-only field updates
  if (isAdmin) {
    if (priority !== undefined) {
      if (!['high', 'medium', 'low'].includes(priority)) {
        res.status(400).json({ error: 'Invalid priority value' });
        return;
      }
      task.priority = priority;
    }
    if (title !== undefined) task.title = title.trim();
    if (description !== undefined) task.description = description.trim();
    if (dueDate !== undefined) task.dueDate = dueDate?.trim() || undefined;
  }

  if (comment?.text?.trim()) {
    task.comments.push({
      from: comment.from?.trim() || req.user?.sub || 'unknown',
      text: comment.text.trim(),
      date: new Date().toISOString(),
    });
  }

  task.updatedAt = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  res.json({ task });
});

/** DELETE /api/partner/tasks/:id — Delete task (admin only). */
router.delete('/tasks/:id', requireRole('admin', 'product-owner'), (req, res) => {
  const tasks = loadTasks();
  const filtered = tasks.filter(t => t.id !== req.params.id);
  if (filtered.length === tasks.length) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  saveTasks(filtered);
  res.json({ ok: true });
});

export default router;

/**
 * Calendar API — CRUD for /root/projekte/local-storage/privat/calendar.json
 *
 * GET    /api/calendar/events         — list all events
 * POST   /api/calendar/events         — create event
 * PUT    /api/calendar/events/:id     — update event
 * DELETE /api/calendar/events/:id     — delete event
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

const CALENDAR_PATH = '/root/projekte/local-storage/privat/calendar.json';

interface CalendarEvent {
  id: string;
  date: string;       // ISO date: "2026-04-25"
  endDate: string;    // ISO date: "2026-04-27"
  title: string;
  type: string;
  notes: string;
}

interface CalendarFile {
  events: CalendarEvent[];
}

function readCalendar(): CalendarFile {
  if (!existsSync(CALENDAR_PATH)) {
    throw new Error(`Calendar file not found: ${CALENDAR_PATH}`);
  }
  const raw = readFileSync(CALENDAR_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as CalendarFile;
  if (!Array.isArray(parsed.events)) {
    throw new Error('Invalid calendar.json: missing events array');
  }
  return parsed;
}

function writeCalendar(data: CalendarFile): void {
  const dir = dirname(CALENDAR_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CALENDAR_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function validateEvent(body: Partial<CalendarEvent>): CalendarEvent {
  if (!body.date || typeof body.date !== 'string') {
    throw new Error('Missing required field: date');
  }
  if (!body.title || typeof body.title !== 'string') {
    throw new Error('Missing required field: title');
  }
  return {
    id: body.id || randomUUID(),
    date: body.date,
    endDate: body.endDate || body.date,
    title: body.title.trim(),
    type: body.type || 'misc',
    notes: body.notes || '',
  };
}

export function createCalendarRouter(): Router {
  const router = Router();

  // GET /api/calendar/events
  router.get('/api/calendar/events', (_req: Request, res: Response) => {
    const calendar = readCalendar();
    const sorted = [...calendar.events].sort((a, b) => a.date.localeCompare(b.date));
    res.json({ events: sorted });
  });

  // POST /api/calendar/events
  router.post('/api/calendar/events', (req: Request, res: Response) => {
    const event = validateEvent(req.body as Partial<CalendarEvent>);
    const calendar = readCalendar();
    const existing = calendar.events.find(e => e.id === event.id);
    if (existing) {
      throw new Error(`Event with id ${event.id} already exists`);
    }
    calendar.events.push(event);
    writeCalendar(calendar);
    res.status(201).json({ event });
  });

  // PUT /api/calendar/events/:id
  router.put('/api/calendar/events/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const calendar = readCalendar();
    const idx = calendar.events.findIndex(e => e.id === id);
    if (idx === -1) {
      res.status(404).json({ error: `Event not found: ${id}` });
      return;
    }
    const updated = validateEvent({ ...calendar.events[idx], ...(req.body as Partial<CalendarEvent>), id });
    calendar.events[idx] = updated;
    writeCalendar(calendar);
    res.json({ event: updated });
  });

  // DELETE /api/calendar/events/:id
  router.delete('/api/calendar/events/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const calendar = readCalendar();
    const idx = calendar.events.findIndex(e => e.id === id);
    if (idx === -1) {
      res.status(404).json({ error: `Event not found: ${id}` });
      return;
    }
    calendar.events.splice(idx, 1);
    writeCalendar(calendar);
    res.json({ ok: true });
  });

  return router;
}

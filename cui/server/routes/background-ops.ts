/**
 * Background Ops — Event Ring Buffer + Status API
 *
 * Collects events from Peer Awareness, AutoInject, and Bridge modules.
 * Exposes aggregated status via GET /api/background-ops.
 */

import { Router, Request, Response } from 'express';

// --- Event Types ---
export type BgEventSource = 'peer' | 'autoinject' | 'bridge' | 'system';
export type BgEventType = 'tick' | 'inject' | 'skip' | 'error' | 'summary' | 'start' | 'stop' | 'degraded';

export interface BgEvent {
  timestamp: string;
  source: BgEventSource;
  type: BgEventType;
  message: string;
  meta?: Record<string, unknown>;
}

// --- Ring Buffer ---
const MAX_EVENTS = 100;
const events: BgEvent[] = [];

export function logBackgroundEvent(
  source: BgEventSource,
  type: BgEventType,
  message: string,
  meta?: Record<string, unknown>,
) {
  const event: BgEvent = {
    timestamp: new Date().toISOString(),
    source,
    type,
    message,
    meta,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
}

export function getBackgroundEvents(): BgEvent[] {
  return [...events];
}

// --- Router ---
export function createBackgroundOpsRouter(): Router {
  const router = Router();

  router.get('/api/background-ops', (_req: Request, res: Response) => {
    const bridgeKeySet = !!process.env.AI_BRIDGE_API_KEY;

    res.json({
      events: getBackgroundEvents(),
      eventCount: events.length,
      maxEvents: MAX_EVENTS,
      bridgeKeySet,
      serverUptime: process.uptime(),
    });
  });

  return router;
}

// Log server start
logBackgroundEvent('system', 'start', 'CUI Workspace Server started');

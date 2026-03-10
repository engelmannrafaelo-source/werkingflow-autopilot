/**
 * Translates Gemini CLI stream-json NDJSON events to Claude Code-compatible message format.
 *
 * Actual Gemini CLI stream-json output (v0.32.1):
 *   { type: 'init', session_id: '...', model: 'auto-gemini-3' }
 *   { type: 'message', role: 'user', content: '...' }                    ← echo of user prompt (skip!)
 *   { type: 'message', role: 'assistant', content: '...', delta: true }   ← streamed chunk
 *   { type: 'tool_use', id: '...', name: '...', input: {...} }
 *   { type: 'tool_result', tool_use_id: '...', output: '...' }
 *   { type: 'error', message: '...' }
 *   { type: 'result', status: 'success', stats: {...} }                   ← no response text!
 */

import type { GeminiEvent } from './runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeMessage {
  type: 'user' | 'assistant';
  message: {
    role: 'user' | 'assistant';
    content: ClaudeContentBlock[];
    model?: string;
  };
  timestamp: string;
  isApiErrorMessage?: boolean;
  error?: string;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// ─── State ────────────────────────────────────────────────────────────────────

let currentModel = 'gemini-2.5-flash';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts a Gemini NDJSON event to a Claude-compatible message entry.
 * Returns null for events that don't map to a storable message (init, closed, etc.)
 */
export function geminiEventToClaude(event: GeminiEvent): ClaudeMessage | null {
  const now = new Date().toISOString();

  switch (event.type) {
    case 'init': {
      if (event.model) currentModel = event.model as string;
      return null; // Not a message — metadata only
    }

    case 'message': {
      const text = (event.content ?? event.text ?? '') as string;
      if (!text) return null;

      const role = (event.role as 'user' | 'assistant') || 'assistant';

      // Skip user message echoes — Gemini repeats the user prompt as a message event.
      // We already store the user prompt explicitly via appendUserPrompt().
      if (role === 'user') return null;

      // This is an assistant delta chunk — return it for buffering
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          model: currentModel,
        },
        timestamp: now,
      };
    }

    case 'tool_use': {
      const id = (event.id ?? event.tool_call_id ?? randomId()) as string;
      const name = (event.name ?? event.tool ?? 'unknown_tool') as string;
      const input = (event.arguments ?? event.input ?? {}) as Record<string, unknown>;

      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input }],
          model: currentModel,
        },
        timestamp: now,
      };
    }

    case 'tool_result': {
      const toolUseId = (event.tool_use_id ?? event.id ?? '') as string;
      const output = (event.output ?? event.result ?? event.content ?? '') as string;

      return {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: typeof output === 'string' ? output : JSON.stringify(output) }],
        },
        timestamp: now,
      };
    }

    case 'result': {
      // Final result event — Gemini v0.32.1 has stats only, no response text.
      // The actual response was already streamed via 'message' delta events.
      return null;
    }

    case 'error': {
      const msg = (event.message ?? event.error ?? 'Unknown Gemini error') as string;
      const isRateLimit = /rate.?limit|too many requests|429|quota/i.test(msg);

      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: msg }],
          model: '<synthetic>',
        },
        timestamp: now,
        isApiErrorMessage: true,
        error: isRateLimit ? 'rate_limit' : 'api_error',
      };
    }

    case 'closed':
      return null; // Stream-end marker — not a message

    default:
      console.warn(`[Translator] Unknown Gemini event type: ${event.type}`);
      return null;
  }
}

/**
 * Converts a Gemini NDJSON event to an SSE-compatible data string.
 * The CUI proxy's detectAttentionMarkers() scans SSE chunks for:
 *   - "type":"closed" → idle/done
 *   - "type":"message_stop" → idle/done
 */
export function geminiEventToSSE(event: GeminiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function getCurrentModel(): string {
  return currentModel;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomId(): string {
  return `gemini_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

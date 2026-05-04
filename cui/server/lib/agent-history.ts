// =============================================================================
// agent-history.ts — Transform raw LLM history into clean display messages.
// =============================================================================
// The agent loop persists history in a format optimised for the LLM:
//   - assistant turns are raw JSON envelopes ({"tool_calls": [...], "response": "..."})
//   - user turns may be Rafael's input OR a synthetic tool-result block
//
// The chat UI wants neither — it wants prose pairs (user → assistant). This
// helper merges JSON assistant turns with the following tool-result user turns,
// extracting the "response" field and appending a compact tool summary.
// =============================================================================

import { parseAgentResponse } from './agent-response-parser.js';

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const TOOL_RESULT_MARKER = 'Tool-Ergebnisse:';

/**
 * Convert raw LLM history into UI-friendly messages.
 *
 * Rules:
 *  - 'system' turns are dropped (system prompt is not part of UI history).
 *  - User turns whose content starts with the tool-result marker are dropped
 *    — their information is already folded into the preceding assistant turn.
 *  - Assistant turns are JSON-parsed; the "response" field becomes the body.
 *    If the assistant only emitted tool_calls (no response yet, e.g. mid-loop),
 *    we surface a compact "(Tool-Calls: ...)" placeholder so the UI shows progress.
 *  - If parsing fails (legacy turns from before the migration), the raw text
 *    passes through untouched.
 */
export function buildDisplayHistory(history: RawMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const msg of history) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      // Skip synthetic tool-result turns — they're absorbed into the prior assistant.
      if (msg.content.startsWith(TOOL_RESULT_MARKER)) continue;
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    // assistant
    out.push({ role: 'assistant', content: assistantToDisplay(msg.content) });
  }

  // Collapse consecutive empty assistant placeholders (mid-loop tool-only turns)
  // into a single "tool-progress" indicator before the final response, so the
  // UI shows: user → assistant(final) — not user → asst(empty) → asst(final).
  return collapseEmptyAssistants(out);
}

function assistantToDisplay(raw: string): string {
  try {
    const parsed = parseAgentResponse(raw);
    const response = parsed.response?.trim();
    if (response) return response;
    // No response yet — describe the tool calls compactly.
    if (parsed.tool_calls && parsed.tool_calls.length > 0) {
      const names = parsed.tool_calls.map(c => `${c.name}(${(c.args as any).path || (c.args as any).dir || ''})`);
      return `_(Lädt: ${names.join(', ')})_`;
    }
    return parsed.reasoning || '(leer)';
  } catch {
    // Legacy / unparsed: show raw, the user can deal with it.
    return raw;
  }
}

function collapseEmptyAssistants(messages: DisplayMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const msg of messages) {
    const isPlaceholder = msg.role === 'assistant' && msg.content.startsWith('_(Lädt:');
    const last = out[out.length - 1];
    if (isPlaceholder && last && last.role === 'assistant' && last.content.startsWith('_(Lädt:')) {
      // Drop duplicate progress placeholders.
      continue;
    }
    out.push(msg);
  }

  // If the final assistant is a placeholder (loop hit max-turns mid-tool), keep it
  // so the user sees something happened. Otherwise drop trailing placeholders that
  // got superseded by a real response (already handled above by ordering).
  return out;
}

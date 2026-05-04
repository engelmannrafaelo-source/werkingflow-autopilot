// =============================================================================
// agent-loop.ts — Multi-turn agent loop with native tool-use protocol.
// =============================================================================
// Pattern adopted from @werkingflow/agent-core's AgentLoop, reimplemented
// locally to avoid cross-repo dependencies (cui has no zod / tiktoken).
//
// Flow:
//   1. callBridge(messages) → AI returns JSON {tool_calls?, response?}
//   2. parse → if parse fails, feed error back, retry (next turn)
//   3. if tool_calls present → onToolCall for each → results back as user msg → next turn
//   4. if no tool_calls → response is final, return
//   5. maxTurns cap prevents runaway
//
// Defensive: bridge errors propagate, parse errors are recoverable via feedback.
// =============================================================================

import { parseAgentResponse, formatToolResultsForLLM, type ToolCall } from './agent-response-parser.js';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: string;
  error?: string;
}

export interface AgentLoopOptions {
  systemPrompt: string;
  /** Existing chat history (will be appended to internally during the loop). */
  history: AgentMessage[];
  /** New user message for this turn. */
  userMessage: string;
  /** Inject the bridge call. Receives full message list, returns AI text. */
  callBridge: (messages: AgentMessage[]) => Promise<string>;
  /** Execute one tool call, return a ToolResult. */
  onToolCall: (call: ToolCall) => Promise<ToolResult>;
  /** Hard cap on turns. Default 15. */
  maxTurns?: number;
  logPrefix?: string;
}

export interface AgentLoopResult {
  /** Final user-facing response text. */
  finalResponse: string;
  /** Flat log of every tool call across all turns (for UI display). */
  toolResults: ToolResult[];
  /** How many bridge round-trips happened. */
  turns: number;
  /** Updated history including assistant + tool-result turns (caller persists). */
  newHistory: AgentMessage[];
  /** True if maxTurns was hit before AI returned a final response. */
  hitMaxTurns: boolean;
}

const DEFAULT_MAX_TURNS = 15;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const log = opts.logPrefix ?? '[AgentLoop]';

  // Working history starts with the existing turns + the new user message.
  // This array is mutated through the loop and returned at the end.
  const history: AgentMessage[] = [...opts.history, { role: 'user', content: opts.userMessage }];

  const allToolResults: ToolResult[] = [];
  let finalResponse = '';
  let turns = 0;
  let hitMaxTurns = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;

    const messages: AgentMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      ...history,
    ];

    const raw = await opts.callBridge(messages);

    // Parse the AI's JSON envelope. On failure, feed the error back and let
    // the model retry on the next turn.
    let parsed;
    try {
      parsed = parseAgentResponse(raw);
    } catch (parseErr: any) {
      console.warn(`${log} turn ${turns}: parse error: ${parseErr.message}`);
      if (turn === maxTurns - 1) {
        // Last turn — return the raw response so the user at least sees something.
        finalResponse = raw;
        history.push({ role: 'assistant', content: raw });
        hitMaxTurns = true;
        break;
      }
      history.push({ role: 'assistant', content: raw });
      history.push({
        role: 'user',
        content:
          `[Parser-Fehler] Deine letzte Antwort war kein gültiges JSON-Objekt. ` +
          `Fehler: ${parseErr.message}\n\n` +
          `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt der Form ` +
          `{"reasoning"?: string, "tool_calls"?: [...], "response"?: string}. ` +
          `Keine Code-Fences, kein Vorwort.`,
      });
      continue;
    }

    // Push assistant turn into history (the raw JSON, so the model sees its own output).
    history.push({ role: 'assistant', content: raw });

    // Tool-call branch: execute each, inject results, continue loop.
    const calls = parsed.tool_calls ?? [];
    if (calls.length > 0) {
      console.log(`${log} turn ${turns}: ${calls.length} tool call(s): ${calls.map(c => c.name).join(', ')}`);

      const turnResults: ToolResult[] = [];
      for (const call of calls) {
        try {
          const result = await opts.onToolCall(call);
          turnResults.push(result);
        } catch (err: any) {
          turnResults.push({
            name: call.name,
            args: call.args,
            ok: false,
            error: err?.message || String(err),
          });
        }
      }
      allToolResults.push(...turnResults);

      history.push({
        role: 'user',
        content: formatToolResultsForLLM(turnResults),
      });
      continue;
    }

    // No tool calls → final response.
    finalResponse = parsed.response ?? '';
    if (!finalResponse.trim()) {
      // Defensive: AI sent no tool_calls AND no response. Fall back to reasoning,
      // otherwise prompt for completion.
      finalResponse = parsed.reasoning?.trim() || '(Leere Antwort)';
    }
    console.log(`${log} turn ${turns}: final response (${finalResponse.length} chars)`);
    break;
  }

  if (turns >= maxTurns && !finalResponse) {
    hitMaxTurns = true;
  }

  return {
    finalResponse,
    toolResults: allToolResults,
    turns,
    newHistory: history,
    hitMaxTurns,
  };
}

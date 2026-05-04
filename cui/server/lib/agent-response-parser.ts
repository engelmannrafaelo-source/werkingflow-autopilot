// =============================================================================
// agent-response-parser.ts — Defensive JSON extraction from LLM output.
// =============================================================================
// Sonnet usually returns clean JSON when instructed, but occasionally:
//   - wraps it in ```json ... ``` fences
//   - prefixes a one-line preamble ("Hier ist meine Antwort:")
//   - emits trailing text after the JSON
// We try strict parse first, then fence extraction, then "first { … last }"
// substring. Throws on hard failure — AgentLoop catches and feeds back.
// =============================================================================

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentResponseEnvelope {
  reasoning?: string;
  tool_calls?: ToolCall[];
  response?: string;
}

/**
 * Parse the LLM's response envelope. Throws on failure with a descriptive
 * message — the agent loop feeds that back to the model on the next turn.
 */
export function parseAgentResponse(raw: string): AgentResponseEnvelope {
  const text = raw.trim();
  if (!text) throw new Error('empty response');

  // 1) strict JSON
  try {
    return validate(JSON.parse(text));
  } catch {
    /* fall through */
  }

  // 2) ```json ... ``` or ``` ... ``` fenced
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return validate(JSON.parse(fenceMatch[1].trim()));
    } catch {
      /* fall through */
    }
  }

  // 3) substring from first { to last } — tolerant of pre/post text
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = text.slice(firstBrace, lastBrace + 1);
    try {
      return validate(JSON.parse(slice));
    } catch (err: any) {
      throw new Error(`JSON parse failed: ${err.message}`);
    }
  }

  throw new Error('no JSON object found in response');
}

function validate(obj: unknown): AgentResponseEnvelope {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('response is not a JSON object');
  }
  const o = obj as Record<string, unknown>;

  const env: AgentResponseEnvelope = {};

  if ('reasoning' in o) {
    if (typeof o.reasoning !== 'string') throw new Error('reasoning must be a string');
    env.reasoning = o.reasoning;
  }

  if ('response' in o) {
    if (typeof o.response !== 'string') throw new Error('response must be a string');
    env.response = o.response;
  }

  if ('tool_calls' in o) {
    if (!Array.isArray(o.tool_calls)) throw new Error('tool_calls must be an array');
    env.tool_calls = o.tool_calls.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`tool_calls[${i}] not an object`);
      const cc = c as Record<string, unknown>;
      if (typeof cc.name !== 'string' || !cc.name) throw new Error(`tool_calls[${i}].name missing`);
      const args = cc.args ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`tool_calls[${i}].args must be an object`);
      }
      return { name: cc.name, args: args as Record<string, unknown> };
    });
  }

  return env;
}

/**
 * Format tool results as a single user-message that goes back into the
 * conversation, so the model sees what happened and can continue.
 */
export function formatToolResultsForLLM(
  results: Array<{ name: string; args: Record<string, unknown>; ok: boolean; result?: string; error?: string }>,
): string {
  const blocks = results.map((r, i) => {
    const head = `[tool_result #${i + 1}: ${r.name}(${JSON.stringify(r.args)})]`;
    if (r.ok) {
      return `${head}\nstatus: ok\n${r.result ?? ''}`;
    }
    return `${head}\nstatus: error\nerror: ${r.error ?? 'unknown'}`;
  });
  return `Tool-Ergebnisse:\n\n${blocks.join('\n\n---\n\n')}\n\nFahre fort.`;
}

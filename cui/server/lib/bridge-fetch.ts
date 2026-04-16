// =============================================================================
// Bridge Fetch — central helper for all AI Bridge LLM calls
// =============================================================================
// Presidio anonymization is DISABLED by default (X-Privacy-Mode: none).
// Business context (names, EUR amounts, company names) must not be stripped.
// Workflows that need anonymization must opt in explicitly.
// =============================================================================

const BRIDGE_URL = process.env.AI_BRIDGE_URL;
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY;

export interface BridgeAttribution {
  userId?: string;
  appId?: string;
  agentId?: string;
  workflowId?: string;
  jobId?: string;
}

export interface BridgeChatOptions {
  model?: string;
  max_tokens?: number;
  messages: Array<{ role: string; content: string }>;
  privacy?: 'none' | 'standard' | 'strict';  // default: 'none'
  timeout?: number;  // ms, default: 300000 (5min)
  attribution?: BridgeAttribution;
}

export interface BridgeChatResponse {
  choices: Array<{ message: { content: string } }>;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 2;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bridgeChat(opts: BridgeChatOptions): Promise<string> {
  if (!BRIDGE_URL) throw new Error('AI_BRIDGE_URL not set');
  if (!BRIDGE_API_KEY) throw new Error('AI_BRIDGE_API_KEY not set');

  const privacy = opts.privacy ?? 'none';
  const timeout = opts.timeout ?? 300000;
  const attr = opts.attribution ?? {};

  // Attribution headers — EVERY Bridge call MUST be identifiable
  const attributionHeaders: Record<string, string> = {
    'X-App-ID': attr.appId || 'cui',
    'X-User-ID': attr.userId || 'system',
  };
  if (attr.agentId) attributionHeaders['X-Agent-ID'] = attr.agentId;
  if (attr.workflowId) attributionHeaders['X-Workflow-ID'] = attr.workflowId;
  if (attr.jobId) attributionHeaders['X-Job-ID'] = attr.jobId;

  const body = JSON.stringify({
    model: opts.model ?? 'claude-sonnet-4-5-20250929',
    max_tokens: opts.max_tokens ?? 8192,
    messages: opts.messages,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = attempt * 2000;
      console.warn(`[Bridge] Attempt ${attempt + 1}/${MAX_RETRIES + 1} after ${backoff}ms (last: ${lastError?.message})`);
      await sleep(backoff);
    }

    let resp: Response;
    try {
      resp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIDGE_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Privacy-Mode': privacy,
          ...attributionHeaders,
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (fetchErr: any) {
      // Network error without HTTP response (DNS failure, connection refused, AbortSignal timeout).
      // NOT retried — nginx already handles worker failover internally for these cases.
      throw fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
    }

    if (!resp.ok) {
      const errText = await resp.text();
      // Strip HTML (e.g. nginx 502 Bad Gateway pages) — show clean error
      const clean = errText.startsWith('<') ? `HTTP ${resp.status} (Bridge nicht erreichbar)` : errText.slice(0, 300);
      lastError = new Error(`Bridge API ${resp.status}: ${clean}`);

      if (RETRYABLE_STATUS.has(resp.status)) {
        console.warn(`[Bridge] Retryable error ${resp.status} on attempt ${attempt + 1}`);
        continue;
      }
      throw lastError;
    }

    const data = await resp.json() as BridgeChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Bridge returned empty response');
    return content;
  }

  throw lastError ?? new Error('Bridge: all retries exhausted');
}

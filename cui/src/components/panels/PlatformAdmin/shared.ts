// Shared fetch helper for the Platform Admin panel.
// Routes all calls through CUI server proxy /api/bridge-proxy — the browser
// has no direct line to the Hetzner Bridge.

const BRIDGE_URL = '/api/bridge-proxy';
const API_KEY = typeof window !== 'undefined'
  ? (window as any).__CUI_BRIDGE_API_KEY__ || ''
  : '';

export async function platformFetch(path: string, opts?: RequestInit & { timeout?: number }): Promise<Response> {
  const { timeout = 15_000, ...init } = opts ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...init?.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function platformJson<T = any>(path: string, opts?: RequestInit & { timeout?: number }): Promise<T> {
  const res = await platformFetch(path, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => 'unknown');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function formatEur(n: number): string {
  return '€' + n.toFixed(2);
}

// Model pricing kept locally; the Bridge exposes raw tokens, we estimate cost
// at the UI layer because the per-call model isn't yet tracked. Mirrors
// MODEL_PRICING_EUR_PER_MILLION in @werkingflow/usage-billing-admin/types/usage.ts.
// Default = Sonnet 4.5 rates because that is what the unified-tester + most
// app traffic uses today.
export const MODEL_PRICING_EUR_PER_MILLION = {
  // input EUR / 1M tokens, output EUR / 1M tokens
  sonnet:  { input: 2.90, output: 14.50 },   // claude-sonnet-4.5
  opus:    { input: 14.50, output: 72.50 },  // claude-opus-4.6/4.7
  haiku:   { input: 0.78, output: 3.84 },    // claude-haiku-4.5
} as const;

export type ModelKey = keyof typeof MODEL_PRICING_EUR_PER_MILLION;

export function estimateEur(inputTokens: number, outputTokens: number, model: ModelKey = 'sonnet'): number {
  const p = MODEL_PRICING_EUR_PER_MILLION[model];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

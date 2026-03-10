/**
 * Fetch wrapper that handles flaky network connections (Tailscale/VPN jitter).
 * - 20s timeout (instead of 8s) to tolerate latency spikes
 * - 1 automatic retry on timeout before throwing
 */
export async function resilientFetch(url: string, opts?: RequestInit): Promise<Response> {
  const timeout = 20000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      return res;
    } catch (err: any) {
      const isTimeout = err?.name === "TimeoutError" || err?.message?.includes("timed out");
      if (isTimeout && attempt === 0) {
        console.warn(`[resilientFetch] timeout on ${url}, retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

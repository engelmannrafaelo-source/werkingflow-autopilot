/**
 * resilientFetch — fetch with automatic retry on transient errors (502/503/504).
 * Drop-in replacement for fetch(), returns the same Response object.
 */
export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.ok || (res.status < 500 || res.status === 501)) return res;
      // Retry on 502/503/504
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

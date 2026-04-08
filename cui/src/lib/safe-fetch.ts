/**
 * Safe API Fetch & Formatting Utilities
 *
 * Shared defensive utilities for all CUI panels.
 * DEFENSIVE PROGRAMMING: Prevent undefined crashes from malformed API responses.
 *
 * Consolidated from:
 *   - BridgeMonitor/safe-fetch.ts (safeBridgeFetch)
 *   - WerkingReportAdmin/safe-fetch.ts (safeWRFetch)
 */

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Safely fetch JSON with validation.
 * Returns fallback data on error instead of throwing.
 */
export async function safeFetch<T>(
  url: string,
  fallback: T,
  options?: RequestInit
): Promise<{ data: T; error: string | null }> {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      return { data: fallback, error: `HTTP ${res.status}: ${text}` };
    }

    const json = await res.json();

    // Defensive: Handle null/undefined response
    if (json === null || json === undefined) {
      return { data: fallback, error: 'API returned null/undefined' };
    }

    return { data: json as T, error: null };
  } catch (err: any) {
    return { data: fallback, error: err.message || 'Unknown error' };
  }
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Safe number formatter - never crashes on undefined/null.
 * Formats large numbers with K/M suffixes.
 */
export function safeFormatNumber(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

/**
 * Safe currency formatter.
 * @param symbol - Currency symbol, defaults to EUR.
 */
export function safeFormatCurrency(
  num: number | undefined | null,
  symbol: string = '\u20AC'
): string {
  if (num === undefined || num === null || isNaN(num)) return `${symbol}0.00`;
  return `${symbol}${num.toFixed(2)}`;
}

/**
 * Safe percentage formatter.
 */
export function safeFormatPercent(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0%';
  return `${num.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * Safe date formatter - returns locale string or 'N/A'.
 */
export function safeFormatDate(date: string | Date | undefined | null): string {
  if (!date) return 'N/A';
  try {
    return new Date(date).toLocaleString();
  } catch {
    return 'Invalid Date';
  }
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

/**
 * Safe array accessor - always returns an array.
 */
export function safeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Safe deep-object accessor - returns defaultValue if any segment is missing.
 */
export function safeGet<T>(
  obj: any,
  path: string,
  defaultValue: T
): T {
  if (!obj) return defaultValue;

  const keys = path.split('.');
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined || !(key in current)) {
      return defaultValue;
    }
    current = current[key];
  }

  return current === undefined || current === null ? defaultValue : current;
}

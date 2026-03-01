/**
 * Safe API Fetch Utilities for WerkING Report Admin
 *
 * DEFENSIVE PROGRAMMING: Prevent undefined crashes from malformed API responses
 */

/**
 * Safely fetch JSON with validation for WR Admin APIs
 *
 * Returns fallback data on error instead of throwing
 */
export async function safeWRFetch<T>(
  endpoint: string,
  fallback: T,
  options?: RequestInit
): Promise<{ data: T; error: string | null }> {
  try {
    const res = await fetch(endpoint, options);
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

/**
 * Safe number formatter - never crashes on undefined/null
 */
export function safeFormatNumber(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

/**
 * Safe currency formatter (EUR)
 */
export function safeFormatCurrency(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '€0.00';
  return `€${num.toFixed(2)}`;
}

/**
 * Safe array accessor - always returns array
 */
export function safeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Safe object accessor - returns default if missing
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

/**
 * Safe percentage formatter
 */
export function safeFormatPercent(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0%';
  return `${num.toFixed(1)}%`;
}

/**
 * Safe date formatter
 */
export function safeFormatDate(date: string | Date | undefined | null): string {
  if (!date) return 'N/A';
  try {
    return new Date(date).toLocaleString();
  } catch {
    return 'Invalid Date';
  }
}

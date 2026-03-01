/**
 * Defensive Programming Utilities
 *
 * SECURITY & ROBUSTNESS: Fail-fast helpers that throw descriptive errors
 * instead of silently continuing with undefined/null values.
 *
 * Use these instead of:
 * - Non-null assertions (!) - hides bugs
 * - Optional chaining (?.) everywhere - makes bugs silent
 * - Default fallbacks - masks real issues
 */

/**
 * Assert value is not null/undefined. Throws if it is.
 *
 * Use this when a value MUST exist and it's a bug if it doesn't.
 *
 * @example
 * const userId = assertDefined(session?.user?.id, 'User ID missing from session');
 */
export function assertDefined<T>(
  value: T | null | undefined,
  errorMessage: string
): T {
  if (value === null || value === undefined) {
    throw new Error(`[Defensive Assert] ${errorMessage}`);
  }
  return value;
}

/**
 * Assert string is non-empty. Throws if empty/whitespace-only.
 *
 * @example
 * const email = assertNonEmpty(formData.get('email'), 'Email is required');
 */
export function assertNonEmpty(
  value: string | null | undefined,
  errorMessage: string
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`[Defensive Assert] ${errorMessage}`);
  }
  return trimmed;
}

/**
 * Assert array is non-empty. Throws if empty.
 *
 * @example
 * const items = assertNonEmptyArray(results, 'No results found');
 */
export function assertNonEmptyArray<T>(
  value: T[] | null | undefined,
  errorMessage: string
): T[] {
  if (!value || value.length === 0) {
    throw new Error(`[Defensive Assert] ${errorMessage}`);
  }
  return value;
}

/**
 * Get environment variable. Throws if not set.
 *
 * Use this instead of process.env.VAR || 'fallback' which hides missing config.
 *
 * @example
 * const apiKey = requireEnv('OPENAI_API_KEY', 'OpenAI API key not configured');
 */
export function requireEnv(key: string, errorMessage: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[Defensive Assert] ${errorMessage} (Missing env var: ${key})`);
  }
  return value;
}

/**
 * Assert value is one of allowed options (enum validation).
 *
 * @example
 * const role = assertEnum(user.role, ['admin', 'user'], 'Invalid user role');
 */
export function assertEnum<T extends string>(
  value: string | null | undefined,
  allowedValues: T[],
  errorMessage: string
): T {
  if (!value || !allowedValues.includes(value as T)) {
    throw new Error(`[Defensive Assert] ${errorMessage}. Got: ${value}, expected one of: ${allowedValues.join(', ')}`);
  }
  return value as T;
}

/**
 * Assert object has required keys.
 *
 * @example
 * assertHasKeys(user, ['id', 'email'], 'Invalid user object');
 */
export function assertHasKeys<T extends object>(
  obj: T | null | undefined,
  keys: (keyof T)[],
  errorMessage: string
): T {
  if (!obj) {
    throw new Error(`[Defensive Assert] ${errorMessage} (Object is null/undefined)`);
  }
  for (const key of keys) {
    if (!(key in obj) || obj[key] === undefined) {
      throw new Error(`[Defensive Assert] ${errorMessage} (Missing key: ${String(key)})`);
    }
  }
  return obj;
}

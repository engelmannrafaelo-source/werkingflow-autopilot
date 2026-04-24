/**
 * API Response Validator — Defensive Programming
 *
 * Validates that API responses contain expected fields before passing
 * them to React state. Throws descriptive errors instead of silent fallbacks.
 *
 * Usage:
 *   const raw = await res.json();
 *   const data = validateApiResponse(raw, '/api/bridge/metrics/usage', {
 *     endpoints: 'array',
 *     total_requests: 'number',
 *     timestamp: 'string',
 *   });
 *   // data is now guaranteed to have all fields — no ?? needed
 *
 * On missing fields:
 *   throws Error("API /api/bridge/metrics/usage: missing 'endpoints' (expected array, got undefined)")
 *   → caller catches and sets error state → user sees clear error message
 */

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

type FieldSpec = FieldType | { type: FieldType; optional?: boolean };

/**
 * Validates an API response has all required fields with correct types.
 * Throws a descriptive error on validation failure.
 *
 * @param data - Raw JSON from fetch response
 * @param endpoint - API endpoint URL (for error messages)
 * @param schema - Map of field names to expected types
 * @returns The validated data, cast to T
 * @throws Error with details about which field is missing/wrong
 */
export function validateApiResponse<T>(
  data: unknown,
  endpoint: string,
  schema: Record<string, FieldSpec>,
): T {
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new Error(
      `API ${endpoint}: expected object, got ${data === null ? 'null' : typeof data}`
    );
  }

  const record = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, spec] of Object.entries(schema)) {
    const expectedType = typeof spec === 'string' ? spec : spec.type;
    const isOptional = typeof spec === 'object' && spec.optional;

    const value = record[field];

    if (value === undefined || value === null) {
      if (!isOptional) {
        errors.push(`missing '${field}' (expected ${expectedType}, got ${value === null ? 'null' : 'undefined'})`);
      }
      continue;
    }

    if (expectedType === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`'${field}' should be array, got ${typeof value}`);
      }
    } else if (typeof value !== expectedType) {
      errors.push(`'${field}' should be ${expectedType}, got ${typeof value}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`API ${endpoint}: ${errors.join('; ')}`);
  }

  return data as T;
}

/**
 * Same as validateApiResponse but returns [data, null] on success
 * and [null, errorMessage] on failure. For cases where you want to
 * handle the error without try/catch.
 */
function tryValidateApiResponse<T>(
  data: unknown,
  endpoint: string,
  schema: Record<string, FieldSpec>,
): [T, null] | [null, string] {
  try {
    const validated = validateApiResponse<T>(data, endpoint, schema);
    return [validated, null];
  } catch (err: any) { // silent-ok: validation error returned as [null, message] tuple; caller handles explicitly
    return [null, err.message];
  }
}

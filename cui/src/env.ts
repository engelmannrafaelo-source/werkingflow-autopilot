/**
 * CUI Environment Detection — pure constants, NO side effects.
 *
 * Parsed once at module load from URLSearchParams.
 * Import these instead of reading window.location directly.
 */

const params = new URLSearchParams(window.location.search);

/** Running in local mode (?mode=local) — shows workDir inputs in project dialog */
export const IS_LOCAL = params.get('mode') === 'local';

/** Mobile mode active (?mobile or ?mode=mobile) — uses MobileLayout */
export const IS_MOBILE = params.has('mobile') || params.get('mode') === 'mobile';

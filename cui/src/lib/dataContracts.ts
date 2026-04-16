/**
 * Data Contract System — Layer-0 Architektur-Integrität
 *
 * Contracts definieren, was ein API-Endpoint GARANTIEREN muss.
 * Nicht nur "Feld existiert" (das macht validateApiResponse),
 * sondern "Daten sind PLAUSIBEL und VOLLSTÄNDIG".
 *
 * Violations werden nicht verschluckt, sondern als Banner im Panel angezeigt.
 */

export type ViolationSeverity = 'error' | 'warning';

export interface ContractViolation {
  code: string;           // z.B. "BRIDGE_NO_ATTRIBUTION"
  severity: ViolationSeverity;
  message: string;        // Menschenlesbar
  detail?: string;        // Technisches Detail
  count?: number;         // Wie viele Datensätze betroffen
  total?: number;         // Von wie vielen insgesamt
}

/**
 * Standard-Contract-Checks für Bridge-Daten.
 * Jeder Check liefert Violations zurück (leer = alles OK).
 */
export const BridgeContracts = {

  /** Jeder Call MUSS einem User zugeordnet sein */
  checkAttribution(requests: Array<{ user: string; app: string }>): ContractViolation[] {
    const violations: ContractViolation[] = [];
    const noUser = requests.filter(r => !r.user || r.user === 'anonymous' || r.user === '-');
    const noApp = requests.filter(r => !r.app || r.app === 'unknown' || r.app === 'chat');

    if (noUser.length > 0) {
      violations.push({
        code: 'BRIDGE_NO_USER',
        severity: 'error',
        message: `${noUser.length}/${requests.length} Calls ohne User-Attribution`,
        detail: 'Bridge sendet kein user_id — Kosten können keinem User zugeordnet werden',
        count: noUser.length,
        total: requests.length,
      });
    }
    if (noApp.length > 0) {
      violations.push({
        code: 'BRIDGE_NO_APP',
        severity: noApp.length === requests.length ? 'error' : 'warning',
        message: `${noApp.length}/${requests.length} Calls ohne App-Attribution`,
        detail: 'Bridge sendet kein app_id — Calls können keiner App zugeordnet werden',
        count: noApp.length,
        total: requests.length,
      });
    }
    return violations;
  },

  /** Token-Tracking MUSS funktionieren bei erfolgreichen Calls */
  checkTokenTracking(requests: Array<{ tokens: number; status: string }>): ContractViolation[] {
    const successful = requests.filter(r => r.status === 'success');
    const zeroTokens = successful.filter(r => r.tokens === 0);

    if (zeroTokens.length > 0 && successful.length > 0) {
      const pct = Math.round((zeroTokens.length / successful.length) * 100);
      return [{
        code: 'BRIDGE_NO_TOKENS',
        severity: pct > 50 ? 'error' : 'warning',
        message: `Token-Tracking ausgefallen: ${zeroTokens.length}/${successful.length} erfolgreiche Calls ohne Tokens (${pct}%)`,
        detail: 'Kosten können nicht berechnet werden — wahrscheinlich Fallback auf request-log Endpoint',
        count: zeroTokens.length,
        total: successful.length,
      }];
    }
    return [];
  },

  /** Kosten MÜSSEN auf echten Tokens basieren, nicht auf Schätzungen */
  checkCostReliability(data: { note?: string; estimated_cost_usd?: number; _note?: string }): ContractViolation[] {
    const isEstimated = data.note?.includes('estimate') || data._note?.includes('Fallback');
    if (isEstimated) {
      return [{
        code: 'BRIDGE_COST_ESTIMATED',
        severity: 'error',
        message: 'Kosten sind Schätzwerte, nicht echte Token-basierte Berechnung',
        detail: data.note || data._note || 'Bridge liefert keine Token-Daten',
      }];
    }
    return [];
  },

  /** Zusammenfassung: Datenqualität in Prozent */
  dataQuality(requests: Array<{ user: string; app: string; tokens: number; status: string }>): {
    score: number; // 0-100
    violations: ContractViolation[];
  } {
    const all = [
      ...this.checkAttribution(requests),
      ...this.checkTokenTracking(requests),
    ];

    if (requests.length === 0) return { score: 100, violations: all };

    // Score: gewichteter Durchschnitt der OK-Rate über alle Checks
    let totalChecked = 0;
    let totalOk = 0;
    for (const v of all) {
      if (v.total && v.count !== undefined) {
        totalChecked += v.total;
        totalOk += v.total - v.count;
      }
    }
    const score = totalChecked > 0 ? Math.round((totalOk / totalChecked) * 100) : 100;
    return { score, violations: all };
  },
};

/**
 * Prüft ob ein API-Response Contract-Violations enthält (Server-seitig angehängt).
 */
export function extractViolations(data: unknown): ContractViolation[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d._contractViolations)) {
    return d._contractViolations as ContractViolation[];
  }
  return [];
}

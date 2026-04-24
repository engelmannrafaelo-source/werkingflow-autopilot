/**
 * ContractBanner — Layer-0 Datenintegritäts-Anzeige
 *
 * Zeigt Contract-Violations als Banner ÜBER dem Panel-Inhalt.
 * Rot = Error (Daten unbrauchbar), Orange = Warning (Daten unvollständig).
 *
 * Usage:
 *   <ContractBanner violations={violations} dataQuality={score} />
 *   {children}
 */
import { useState } from 'react';
import type { ContractViolation } from '../lib/dataContracts';

interface ContractBannerProps {
  violations: ContractViolation[];
  /**
   * Datenqualitäts-Score 0-100, oder `null` wenn nicht beurteilbar
   * (z.B. Bridge offline / Fallback). `null` zeigt "N/A" statt grüner 100%.
   * `undefined` ⇒ gar kein Badge anzeigen.
   */
  dataQuality?: number | null;
}

export default function ContractBanner({ violations, dataQuality }: ContractBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (violations.length === 0) return null;

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');
  const hasErrors = errors.length > 0;

  const bgColor = hasErrors ? 'rgba(247, 118, 142, 0.12)' : 'rgba(224, 175, 104, 0.12)';
  const borderColor = hasErrors ? 'rgba(247, 118, 142, 0.5)' : 'rgba(224, 175, 104, 0.5)';
  const textColor = hasErrors ? '#f7768e' : '#e0af68';

  return (
    <div style={{
      borderBottom: `2px solid ${borderColor}`,
      background: bgColor,
      flexShrink: 0,
    }}>
      {/* Summary bar — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', border: 'none', cursor: 'pointer',
          background: 'transparent', color: textColor, fontSize: 11,
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 13 }}>{hasErrors ? '!' : '!'}</span>
        <span style={{ flex: 1, fontWeight: 600 }}>
          {errors.length > 0 && `${errors.length} Contract-Fehler`}
          {errors.length > 0 && warnings.length > 0 && ', '}
          {warnings.length > 0 && `${warnings.length} Warnung${warnings.length > 1 ? 'en' : ''}`}
        </span>
        {dataQuality !== undefined && (
          dataQuality === null ? (
            // Bridge offline / Fallback / keine verwertbaren Daten — kein false-green 100%.
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 3,
              background: 'rgba(122,162,247,0.15)',
              color: '#7aa2f7',
              fontWeight: 700,
            }}>
              Datenqualität: N/A
            </span>
          ) : (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 3,
              background: dataQuality > 80 ? 'rgba(158,206,106,0.2)' : dataQuality > 50 ? 'rgba(224,175,104,0.2)' : 'rgba(247,118,142,0.2)',
              color: dataQuality > 80 ? '#9ece6a' : dataQuality > 50 ? '#e0af68' : '#f7768e',
              fontWeight: 700,
            }}>
              Datenqualität: {dataQuality}%
            </span>
          )
        )}
        <span style={{ fontSize: 9, opacity: 0.6 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Detail list — expandable */}
      {expanded && (
        <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {violations.map((v, i) => (
            <div key={i} style={{
              display: 'flex', gap: 6, fontSize: 10, lineHeight: 1.4,
              padding: '4px 8px', borderRadius: 3,
              background: v.severity === 'error' ? 'rgba(247,118,142,0.08)' : 'rgba(224,175,104,0.08)',
            }}>
              <span style={{
                color: v.severity === 'error' ? '#f7768e' : '#e0af68',
                fontWeight: 700, flexShrink: 0,
              }}>
                [{v.code}]
              </span>
              <div>
                <div style={{ color: 'var(--tn-text)', fontWeight: 500 }}>{v.message}</div>
                {v.detail && <div style={{ color: 'var(--tn-text-muted)', marginTop: 2 }}>{v.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

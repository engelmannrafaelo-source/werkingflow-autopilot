/**
 * Attribution Dashboard Panel
 *
 * Embeds the new Attribution Monitor (http://localhost:3333/attribution)
 * as an iframe in the CUI.
 */

import React from 'react';

export default function AttributionDashboard() {
  const DASHBOARD_URL = 'http://localhost:3333/attribution';

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--tn-text)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          📊 Attribution Dashboard
        </div>
        <a
          href={DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 10,
            color: 'var(--tn-blue)',
            textDecoration: 'none',
            padding: '3px 8px',
            border: '1px solid var(--tn-border)',
            borderRadius: 3,
            background: 'var(--tn-bg-darker)'
          }}
        >
          Open in Browser ↗
        </a>
      </div>

      {/* Iframe */}
      <iframe
        src={DASHBOARD_URL}
        style={{
          flex: 1,
          width: '100%',
          border: 'none',
          background: '#0a0e14'
        }}
        title="Attribution Dashboard"
      />
    </div>
  );
}

/**
 * Environment Tab - Local Dev-Server Env Vars Monitoring
 *
 * Shows:
 * - Physical dev-server environment variables (/home/claude-user/.bashrc)
 * - Validation status (CRITICAL, DEV-ONLY, FORBIDDEN)
 * - Comparison: Local vs. Infisical Projects
 */

import { useState, useEffect } from 'react';

interface EnvVar {
  key: string;
  value: string; // Obfuscated (first 8 chars + ...)
  category: 'CRITICAL' | 'DEV_ONLY' | 'FORBIDDEN' | 'OPTIONAL';
  status: 'ok' | 'missing' | 'forbidden';
  description?: string;
}

interface EnvData {
  localVars: EnvVar[];
  infisicalProjects: string[];
  lastCheck: string;
}

const API = '/api';

export default function EnvironmentTab() {
  const [data, setData] = useState<EnvData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEnvData();
  }, []);

  async function fetchEnvData() {
    try {
      const res = await fetch(`${API}/infisical/environment`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const envData = await res.json();
      setData(envData);
      setError(null);
      setLoading(false);
    } catch (err: any) {
      console.error('[EnvironmentTab] Fetch failed:', err);
      setError(err.message);
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading environment status...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: 'var(--tn-red)', fontSize: 12 }}>
        Error: {error}
        <button
          onClick={fetchEnvData}
          style={{
            marginLeft: 12,
            padding: '4px 8px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  // Group vars by category
  const critical = data.localVars.filter(v => v.category === 'CRITICAL');
  const devOnly = data.localVars.filter(v => v.category === 'DEV_ONLY');
  const forbidden = data.localVars.filter(v => v.category === 'FORBIDDEN');
  const optional = data.localVars.filter(v => v.category === 'OPTIONAL');

  return (
    <div
      data-test-id="environment-tab"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Header */}
      <div style={{
        padding: 12,
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 6,
      }}>
        <h4 style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-text)',
        }}>
          🖥️ Physical Dev-Server Environment
        </h4>
        <div style={{
          fontSize: 11,
          color: 'var(--tn-text-muted)',
          marginTop: 4,
        }}>
          Source: <code>/home/claude-user/.bashrc</code>
        </div>
        <div style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          marginTop: 2,
        }}>
          Last checked: {new Date(data.lastCheck).toLocaleString()}
        </div>
      </div>

      {/* CRITICAL Variables */}
      <Section
        title="🔴 CRITICAL Variables"
        description="Must be set for apps to function"
        vars={critical}
      />

      {/* DEV-ONLY Variables */}
      <Section
        title="🟢 DEV-ONLY Variables"
        description="Local development keys (not in Infisical)"
        vars={devOnly}
      />

      {/* FORBIDDEN Variables */}
      {forbidden.length > 0 && (
        <Section
          title="⚠️ FORBIDDEN Variables"
          description="Production secrets should NOT be on dev-server!"
          vars={forbidden}
          highlight="danger"
        />
      )}

      {/* OPTIONAL Variables */}
      <Section
        title="⚫ OPTIONAL Variables"
        description="Non-critical, may be missing"
        vars={optional}
      />

      {/* Infisical Mapping */}
      <div style={{
        padding: 12,
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 6,
      }}>
        <h4 style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-text)',
        }}>
          🔄 Infisical Projects
        </h4>
        <div style={{
          fontSize: 11,
          color: 'var(--tn-text-muted)',
          marginTop: 8,
        }}>
          {data.infisicalProjects.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {data.infisicalProjects.map(project => (
                <li key={project} style={{ marginBottom: 4 }}>{project}</li>
              ))}
            </ul>
          ) : (
            <div style={{ fontStyle: 'italic' }}>No Infisical projects configured</div>
          )}
        </div>
      </div>

      {/* Refresh Button */}
      <button
        onClick={fetchEnvData}
        style={{
          alignSelf: 'flex-start',
          padding: '6px 12px',
          background: 'var(--tn-blue)',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 500,
        }}
      >
        ↻ Refresh Environment
      </button>
    </div>
  );
}

// Section Component
interface SectionProps {
  title: string;
  description: string;
  vars: EnvVar[];
  highlight?: 'danger';
}

function Section({ title, description, vars, highlight }: SectionProps) {
  if (vars.length === 0) return null;

  const borderColor = highlight === 'danger' ? 'var(--tn-red)' : 'var(--tn-border)';

  return (
    <div style={{
      padding: 12,
      background: 'var(--tn-surface)',
      border: `1px solid ${borderColor}`,
      borderRadius: 6,
    }}>
      <h4 style={{
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--tn-text)',
      }}>
        {title}
      </h4>
      <div style={{
        fontSize: 11,
        color: 'var(--tn-text-muted)',
        marginTop: 2,
        marginBottom: 8,
      }}>
        {description}
      </div>

      {/* Variables Table */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '200px 1fr 60px',
        gap: 8,
        fontSize: 11,
      }}>
        {/* Header */}
        <div style={{ fontWeight: 600, color: 'var(--tn-text-muted)' }}>Variable</div>
        <div style={{ fontWeight: 600, color: 'var(--tn-text-muted)' }}>Value</div>
        <div style={{ fontWeight: 600, color: 'var(--tn-text-muted)' }}>Status</div>

        {/* Rows */}
        {vars.map(v => (
          <VarRow key={v.key} envVar={v} />
        ))}
      </div>
    </div>
  );
}

// Variable Row Component
function VarRow({ envVar }: { envVar: EnvVar }) {
  const statusColor = {
    ok: 'var(--tn-green)',
    missing: 'var(--tn-yellow)',
    forbidden: 'var(--tn-red)',
  }[envVar.status];

  const statusIcon = {
    ok: '✅',
    missing: '⚠️',
    forbidden: '🔴',
  }[envVar.status];

  return (
    <>
      <div style={{
        fontFamily: 'monospace',
        fontSize: 10,
        color: 'var(--tn-text)',
      }}>
        {envVar.key}
      </div>
      <div style={{
        fontFamily: 'monospace',
        fontSize: 10,
        color: 'var(--tn-text-muted)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {envVar.value}
      </div>
      <div style={{
        fontSize: 10,
        color: statusColor,
        fontWeight: 600,
      }}>
        {statusIcon}
      </div>
    </>
  );
}

/**
 * Infisical Monitor Panel
 *
 * Provides monitoring and management for self-hosted Infisical instance
 * Server: 100.79.71.99 (Prod-Ops, Tailscale) / 46.225.139.121 (public)
 */

import { useState, useEffect } from 'react';
import ErrorBoundary from '../../ErrorBoundary';
import OverviewTab from './tabs/OverviewTab';
import ProjectsTab from './tabs/ProjectsTab';
import SyncsTab from './tabs/SyncsTab';
import HealthTab from './tabs/HealthTab';
import SettingsTab from './tabs/SettingsTab';
import EnvironmentTab from './tabs/EnvironmentTab';

const API = '/api';

export interface ServerInfo {
  server: string;
  tailscaleIP: string;
  publicIP: string;
  webUI: string;
  configured: boolean;
  docs: string;
  timestamp: string;
}

export interface Project {
  name: string;
  syncTarget: string;
  environment: string;
}

export interface Sync {
  project: string;
  integration: 'vercel' | 'railway';
  status: 'succeeded' | 'failed' | 'pending';
  lastSync: string;
  autoSync: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  server: string;
  response?: any;
  error?: string;
  timestamp: string;
}

export interface InfisicalData {
  serverInfo: ServerInfo | null;
  projects: Project[];
  syncs: Sync[];
  health: HealthStatus | null;
}

export default function InfisicalMonitor() {
  const [activeTab, setActiveTab] = useState<'overview' | 'projects' | 'syncs' | 'health' | 'environment' | 'settings'>('overview');
  const [data, setData] = useState<InfisicalData>({
    serverInfo: null,
    projects: [],
    syncs: [],
    health: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all data on mount and refresh interval
  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  async function fetchAllData() {
    if ((window as any).__cuiServerAlive === false) return;

    try {
      const [serverRes, projectsRes, syncsRes, healthRes] = await Promise.all([
        fetch(`${API}/infisical/server-info`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${API}/infisical/projects`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${API}/infisical/syncs`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${API}/infisical/health`, { signal: AbortSignal.timeout(5000) }),
      ]);

      if (!serverRes.ok || !projectsRes.ok || !syncsRes.ok || !healthRes.ok) {
        throw new Error('One or more API calls failed');
      }

      const [serverInfo, projectsData, syncsData, healthData] = await Promise.all([
        serverRes.json(),
        projectsRes.json(),
        syncsRes.json(),
        healthRes.json(),
      ]);

      setData({
        serverInfo,
        projects: projectsData.projects || [],
        syncs: syncsData.syncs || [],
        health: healthData,
      });
      setError(null);
      setLoading(false);
    } catch (err: any) {
      console.error('[InfisicalMonitor] Fetch failed:', err);
      setError(err.message);
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div
        data-ai-id="infisical-monitor-loading"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
        }}>
        Loading Infisical status...
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-ai-id="infisical-monitor-error-state"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '1rem',
          padding: '1rem',
        }}>
        <div
          data-ai-id="infisical-monitor-error-message"
          style={{ color: 'var(--tn-red)', fontSize: 14 }}>
          Error: {error}
        </div>
        <button
          data-ai-id="infisical-monitor-retry-button"
          onClick={fetchAllData}
          style={{
            padding: '6px 12px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const tabs = [
    { id: 'overview' as const, label: '📊 Overview' },
    { id: 'projects' as const, label: '📁 Projects' },
    { id: 'syncs' as const, label: '🔄 Syncs' },
    { id: 'health' as const, label: '❤️ Health' },
    { id: 'environment' as const, label: '🖥️ Environment' },
    { id: 'settings' as const, label: '⚙️ Settings' },
  ];

  return (
    <div
      className="infisical-monitor"
      data-ai-id="infisical-monitor-panel"
      data-panel-id="infisical"
      data-component="InfisicalMonitor"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--tn-bg)',
        overflow: 'hidden',
      }}>
      {/* Header with Tabs */}
      <div style={{
        borderBottom: '1px solid var(--tn-border)',
        background: 'var(--tn-surface)',
      }}>
        <div style={{
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            <h3 style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--tn-text)',
            }}>
              Infisical Monitor
            </h3>
            <div
              data-ai-id="infisical-monitor-status-dot"
              style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                marginTop: 2,
              }}>
              {data.serverInfo?.server || 'No server info'}
            </div>
          </div>
          <button
            data-ai-id="infisical-monitor-refresh-button"
            onClick={fetchAllData}
            style={{
              padding: '4px 8px',
              background: 'var(--tn-surface-alt)',
              color: 'var(--tn-text-muted)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Tab Bar */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 16px',
          borderTop: '1px solid var(--tn-border)',
        }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              data-ai-id={`infisical-monitor-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '8px 12px',
                background: activeTab === tab.id ? 'var(--tn-bg)' : 'transparent',
                color: activeTab === tab.id ? 'var(--tn-text)' : 'var(--tn-text-muted)',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid var(--tn-blue)' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 500,
                transition: 'all 0.2s ease',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div
        data-ai-id={`infisical-monitor-content-${activeTab}`}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
        }}>
        {activeTab === 'overview' && <OverviewTab data={data} onRefresh={fetchAllData} />}
        {activeTab === 'projects' && <ProjectsTab projects={data.projects} onRefresh={fetchAllData} />}
        {activeTab === 'syncs' && <SyncsTab syncs={data.syncs} onRefresh={fetchAllData} />}
        {activeTab === 'health' && <HealthTab health={data.health} onRefresh={fetchAllData} />}
        {activeTab === 'environment' && <EnvironmentTab />}
        {activeTab === 'settings' && <SettingsTab serverInfo={data.serverInfo} />}
      </div>
    </div>
  );
}

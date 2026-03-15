import type { ServerInfo } from '../InfisicalMonitor';

interface Props {
  serverInfo: ServerInfo | null;
}

export default function SettingsTab({ serverInfo }: Props) {
  if (!serverInfo) {
    return (
      <div data-ai-id="settings-tab-empty-state" style={{
        textAlign: 'center',
        padding: '40px 20px',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        No server info available
      </div>
    );
  }

  const sections = [
    {
      title: 'Server Configuration',
      items: [
        { label: 'Base URL', value: serverInfo.server, mono: true },
        { label: 'Tailscale IP', value: serverInfo.tailscaleIP, mono: true },
        { label: 'Public IP', value: serverInfo.publicIP, mono: true },
        { label: 'Web UI', value: serverInfo.webUI, link: true, mono: true },
      ],
    },
    {
      title: 'API Configuration',
      items: [
        { label: 'API Token Configured', value: serverInfo.configured ? 'Yes ✓' : 'No ✗', status: serverInfo.configured },
        { label: 'Documentation', value: serverInfo.docs, mono: true },
      ],
    },
    {
      title: 'Integration Targets',
      items: [
        { label: 'Vercel Projects', value: '5 (werking-report, engelmann, platform, safety-fe, energy-fe)' },
        { label: 'Railway Projects', value: '2 (safety-be, energy-be)' },
        { label: 'Total Syncs', value: '7 auto-syncs configured' },
      ],
    },
    {
      title: 'Security',
      items: [
        { label: 'Access Method', value: 'Tailscale VPN (private network)' },
        { label: 'Web UI Port', value: '80 (HTTP, Tailscale only)' },
        { label: 'Production Secrets', value: 'Stored in Infisical only' },
        { label: 'Dev Server', value: 'No production credentials' },
      ],
    },
  ];

  return (
    <div data-ai-id="settings-tab-container" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {sections.map((section, idx) => {
        const sectionId = section.title.toLowerCase().replace(/\s+/g, '-');
        return (
          <div
            key={idx}
            data-ai-id={`settings-tab-section-${sectionId}`}
            style={{
              background: 'var(--tn-surface)',
              border: '1px solid var(--tn-border)',
              borderRadius: 8,
              padding: '16px',
            }}
          >
            <h4 style={{
              margin: '0 0 12px 0',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--tn-text)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              {section.title}
            </h4>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '10px 16px',
              fontSize: 11,
            }}>
              {section.items.map((item, itemIdx) => {
                const fieldId = item.label.toLowerCase().replace(/\s+/g, '-');
                return (
                  <>
                    <span
                      key={`label-${itemIdx}`}
                      style={{
                        color: 'var(--tn-text-muted)',
                        fontWeight: 500,
                      }}
                    >
                      {item.label}:
                    </span>
                    <span
                      key={`value-${itemIdx}`}
                      data-ai-id={`settings-tab-${sectionId}-${fieldId}`}
                      style={{
                        color: item.status !== undefined
                          ? (item.status ? 'var(--tn-green)' : 'var(--tn-red)')
                          : 'var(--tn-text)',
                        fontFamily: item.mono ? 'monospace' : 'inherit',
                        fontSize: item.mono ? 10 : 11,
                        fontWeight: item.status !== undefined ? 600 : 400,
                      }}
                    >
                      {item.link ? (
                        <a
                          href={item.value}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: 'var(--tn-blue)',
                            textDecoration: 'none',
                          }}
                        >
                          {item.value}
                        </a>
                      ) : (
                        item.value
                      )}
                    </span>
                  </>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Documentation Link */}
      <div data-ai-id="settings-tab-documentation-section" style={{
        padding: '16px',
        background: 'var(--tn-blue-bg, #e3f2fd)',
        border: '1px solid var(--tn-blue, #1976d2)',
        borderRadius: 8,
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tn-blue, #1976d2)',
          marginBottom: 8,
        }}>
          📖 Documentation
        </div>
        <div style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          marginBottom: 8,
        }}>
          Complete setup and architecture documentation:
        </div>
        <code data-ai-id="settings-tab-docs-path" style={{
          display: 'block',
          padding: '8px 12px',
          background: 'var(--tn-bg)',
          borderRadius: 4,
          fontSize: 10,
          fontFamily: 'monospace',
          color: 'var(--tn-text)',
        }}>
          {serverInfo.docs}
        </code>
      </div>
    </div>
  );
}

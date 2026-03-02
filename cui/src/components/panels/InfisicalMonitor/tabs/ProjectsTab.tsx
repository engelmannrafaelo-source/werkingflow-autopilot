import type { Project } from '../InfisicalMonitor';

interface Props {
  projects: Project[];
  onRefresh: () => void;
}

export default function ProjectsTab({ projects }: Props) {
  if (projects.length === 0) {
    return (
      <div style={{
        textAlign: 'center',
        padding: '40px 20px',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        No projects found
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {projects.map((project, idx) => (
        <div
          key={idx}
          style={{
            padding: '16px',
            background: 'var(--tn-surface)',
            border: '1px solid var(--tn-border)',
            borderRadius: 8,
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--tn-blue)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--tn-border)';
          }}
        >
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 12,
          }}>
            <div>
              <h4 style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--tn-text)',
              }}>
                {project.name}
              </h4>
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                marginTop: 4,
              }}>
                {project.syncTarget}
              </div>
            </div>
            <div style={{
              padding: '4px 8px',
              background: project.environment === 'production'
                ? 'var(--tn-red-bg, #ffebee)'
                : 'var(--tn-blue-bg, #e3f2fd)',
              color: project.environment === 'production'
                ? 'var(--tn-red, #c62828)'
                : 'var(--tn-blue, #1976d2)',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
            }}>
              {project.environment}
            </div>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 12px',
            fontSize: 11,
          }}>
            <span style={{ color: 'var(--tn-text-muted)' }}>Sync Target:</span>
            <span style={{ color: 'var(--tn-text)', fontWeight: 500 }}>
              {project.syncTarget.split(':')[1]?.trim() || project.syncTarget}
            </span>

            <span style={{ color: 'var(--tn-text-muted)' }}>Platform:</span>
            <span style={{ color: 'var(--tn-text)', fontWeight: 500 }}>
              {project.syncTarget.toLowerCase().includes('vercel') ? 'Vercel' :
               project.syncTarget.toLowerCase().includes('railway') ? 'Railway' : 'Unknown'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

import { type Project } from '../types';

interface ProjectTabsProps {
  projects: Project[];
  activeId: string;
  attention?: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  missionActive?: boolean;
  onMissionClick?: () => void;
}

export default function ProjectTabs({ projects, activeId, attention, onSelect, onNew, onEdit, onDelete, missionActive, onMissionClick }: ProjectTabsProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 8px 0 80px',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        height: 36,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-blue)',
          marginRight: 12,
          whiteSpace: 'nowrap',
        }}
      >
        CUI Workspace
      </span>

      {/* Mission Control - permanent tab */}
      {onMissionClick && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: missionActive ? 'var(--tn-surface)' : 'transparent',
            borderBottom: missionActive ? '2px solid #e0af68' : '2px solid transparent',
            borderRadius: '4px 4px 0 0',
            marginRight: 4,
          }}
        >
          <button
            onClick={onMissionClick}
            title="Mission Control (Cmd+0)"
            style={{
              background: 'none',
              color: missionActive ? '#e0af68' : 'var(--tn-text-muted)',
              border: 'none',
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: missionActive ? 700 : 400,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            MC
          </button>
        </div>
      )}

      <div style={{ width: 1, height: 16, background: 'var(--tn-border)', marginRight: 4, opacity: 0.4 }} />

      {projects.map((p, idx) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            background: p.id === activeId ? 'var(--tn-surface)' : 'transparent',
            borderBottom: p.id === activeId ? '2px solid var(--tn-blue)' : '2px solid transparent',
            borderRadius: '4px 4px 0 0',
            transition: 'all 0.15s',
          }}
        >
          <button
            onClick={() => onSelect(p.id)}
            onDoubleClick={(e) => { e.preventDefault(); onEdit(p.id); }}
            title={`${p.name} — ${p.workDir}\nDoppelklick zum Bearbeiten${idx < 9 ? `\nCmd+${idx + 1}` : ''}`}
            style={{
              background: 'none',
              color: p.id === activeId ? 'var(--tn-text)' : 'var(--tn-text-muted)',
              border: 'none',
              padding: '6px 10px 6px 14px',
              fontSize: 12,
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {attention?.has(p.id) && p.id !== activeId && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#e0af68',
                display: 'inline-block', marginRight: 5, flexShrink: 0,
              }} />
            )}
            {idx < 9 && (
              <span style={{ fontSize: 9, opacity: 0.4, marginRight: 4, fontFamily: 'monospace' }}>
                {idx + 1}
              </span>
            )}
            {p.name}
          </button>
          {projects.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.id);
              }}
              title={`Delete ${p.name}`}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--tn-text-muted)',
                cursor: 'pointer',
                fontSize: 10,
                padding: '4px 6px 4px 0',
                opacity: 0.5,
                transition: 'opacity 0.15s',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.color = 'var(--tn-red)'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.5'; (e.target as HTMLElement).style.color = 'var(--tn-text-muted)'; }}
            >
              ✕
            </button>
          )}
        </div>
      ))}

      <button
        onClick={onNew}
        title="Neues Projekt (Cmd+N)"
        style={{
          background: 'none',
          border: '1px dashed var(--tn-border)',
          color: 'var(--tn-text-muted)',
          padding: '4px 10px',
          fontSize: 11,
          cursor: 'pointer',
          borderRadius: 4,
          marginLeft: 4,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        + Projekt
      </button>
    </div>
  );
}

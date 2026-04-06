interface BreadcrumbProps {
  filterHistory: string[];
  onNavigate: (index: number) => void;
}

export default function Breadcrumb({ filterHistory, onNavigate }: BreadcrumbProps) {
  if (filterHistory.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      gap: 4,
      alignItems: 'center',
      padding: '4px 10px',
      fontSize: 10,
      color: 'var(--tn-text-muted)',
      borderBottom: '1px solid var(--tn-border)',
      flexWrap: 'wrap',
    }}>
      <span
        onClick={() => onNavigate(-1)}
        style={{ cursor: 'pointer', color: 'var(--tn-blue)' }}
      >
        Gesamt
      </span>

      {filterHistory.map((filter, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--tn-text-muted)', opacity: 0.5 }}>&gt;</span>
          <span
            onClick={() => onNavigate(i)}
            style={{
              cursor: 'pointer',
              color: i === filterHistory.length - 1 ? 'var(--tn-text)' : 'var(--tn-blue)',
              fontWeight: i === filterHistory.length - 1 ? 600 : 400,
            }}
          >
            {filter}
          </span>
        </span>
      ))}
    </div>
  );
}

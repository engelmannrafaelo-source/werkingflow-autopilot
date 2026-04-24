interface PanelLoaderProps {
  message?: string;
}

export default function PanelLoader({ message = 'Loading...' }: PanelLoaderProps) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
      {message}
    </div>
  );
}

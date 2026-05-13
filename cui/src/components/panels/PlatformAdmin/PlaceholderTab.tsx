// Placeholder for the upcoming Users / Tenants / Billing / Activity / Feedback tabs.
// Renders a short explanation of what will live here and which Bridge endpoint
// will back it — so the panel never looks half-broken while the migration runs.

export default function PlaceholderTab({ title, endpoint, description }: { title: string; endpoint: string; description: string }) {
  return (
    <div style={style.root} data-ai-id={`platform-placeholder-${title.toLowerCase()}`}>
      <div style={style.title}>{title}</div>
      <div style={style.endpoint}>{endpoint}</div>
      <p style={style.desc}>{description}</p>
      <p style={style.desc}>Sobald die Bridge dieses Endpoint exposed, wird das Tab automatisch live geschaltet.</p>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', maxWidth: 520, margin: '0 auto' },
  title: { fontSize: 16, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 6 },
  endpoint: { fontSize: 11, fontFamily: 'monospace', color: 'var(--tn-blue)', marginBottom: 16 },
  desc: { fontSize: 12, color: 'var(--tn-text-muted)', lineHeight: 1.6, margin: '6px 0' },
};

import { useState, useEffect } from 'react';

export default function QuickStartBanner() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check if user has dismissed before (localStorage)
    const wasDismissed = localStorage.getItem('virtualOffice.quickStart.dismissed');
    if (wasDismissed) setDismissed(true);
  }, []);

  function handleDismiss() {
    localStorage.setItem('virtualOffice.quickStart.dismissed', 'true');
    setDismissed(true);
  }

  if (dismissed) return null;

  return (
    <div style={{
      padding: '12px 16px',
      background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(14, 165, 233, 0.1))',
      border: '1px solid rgba(99, 102, 241, 0.3)',
      borderRadius: 8,
      margin: '12px 16px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12
    }}>
      <div style={{ fontSize: 24 }}>👋</div>

      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-text)',
          marginBottom: 6
        }}>
          Welcome to Virtual Office!
        </div>

        <div style={{
          fontSize: 11,
          color: 'var(--tn-text-muted)',
          lineHeight: 1.6,
          marginBottom: 8
        }}>
          <strong>Quick Start:</strong>
          <br />
          1️⃣ Check <strong>"Next Up For You"</strong> (right panel) for pending work
          <br />
          2️⃣ Click any <strong>agent card</strong> to see their role and responsibilities
          <br />
          3️⃣ Use <strong>🎯 Agent Grid / 🏢 Org Chart / 📊 RACI Matrix</strong> tabs to switch views
          <br />
          4️⃣ Click <strong>▶ Run</strong> on any agent to start them manually
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleDismiss}
            style={{
              padding: '4px 12px',
              fontSize: 11,
              fontWeight: 600,
              background: 'var(--tn-blue)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer'
            }}
          >
            Got it!
          </button>
          <button
            onClick={handleDismiss}
            style={{
              padding: '4px 12px',
              fontSize: 11,
              background: 'transparent',
              color: 'var(--tn-text-muted)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              cursor: 'pointer'
            }}
          >
            Don't show again
          </button>
        </div>
      </div>

      <button
        onClick={handleDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--tn-text-muted)',
          fontSize: 18,
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1
        }}
      >
        ×
      </button>
    </div>
  );
}

import React from 'react';

interface PanelErrorFallbackProps {
  error?: Error;
}

export default function PanelErrorFallback({ error }: PanelErrorFallbackProps) {
  const handleCopyError = async () => {
    if (!error) return;

    const errorText = `Admin Panel Error\n\nError: ${error.toString()}\n\nStack:\n${error.stack}`;

    try {
      await navigator.clipboard.writeText(errorText);
      alert('Error details copied to clipboard');
    } catch (err) {
      console.error('Failed to copy error:', err);
      alert('Failed to copy error details');
    }
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        padding: '2rem',
        background: 'var(--tn-surface)',
        color: 'var(--tn-text)',
      }}
    >
      <div
        style={{
          maxWidth: '600px',
          width: '100%',
          background: 'var(--tn-bg-dark)',
          border: '2px solid var(--tn-red)',
          borderRadius: '8px',
          padding: '2.5rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: '64px',
            marginBottom: '1.5rem',
            opacity: 0.8,
          }}
        >
          💥
        </div>
        <h1
          style={{
            color: 'var(--tn-red)',
            marginBottom: '0.5rem',
            fontSize: '1.5rem',
            fontWeight: 700,
          }}
        >
          Admin Panel Error
        </h1>
        <p
          style={{
            color: 'var(--tn-text-muted)',
            marginBottom: '2rem',
            fontSize: '1rem',
          }}
        >
          A critical error occurred in the WerkING Report Admin panel.
          <br />
          Please refresh the page to continue.
        </p>

        {error && (
          <details
            style={{
              background: 'rgba(0,0,0,0.3)',
              padding: '1rem',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '2rem',
              textAlign: 'left',
            }}
          >
            <summary
              style={{
                fontWeight: 600,
                marginBottom: '0.5rem',
                cursor: 'pointer',
                color: 'var(--tn-text)',
              }}
            >
              Error Details
            </summary>
            <pre
              style={{
                fontSize: '0.75rem',
                overflow: 'auto',
                color: 'var(--tn-red)',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '200px',
              }}
            >
              {error.toString()}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          <button
            onClick={handleRefresh}
            style={{
              padding: '0.75rem 2rem',
              background: 'var(--tn-green)',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '1rem',
            }}
          >
            Refresh Page
          </button>
          {error && (
            <button
              onClick={handleCopyError}
              style={{
                padding: '0.75rem 2rem',
                background: 'var(--tn-blue)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '1rem',
              }}
            >
              Copy Error
            </button>
          )}
        </div>

        <p
          style={{
            marginTop: '2rem',
            fontSize: '0.8rem',
            color: 'var(--tn-text-muted)',
            fontStyle: 'italic',
          }}
        >
          If this problem persists after refreshing, please report the issue
          <br />
          with the error details above.
        </p>
      </div>
    </div>
  );
}

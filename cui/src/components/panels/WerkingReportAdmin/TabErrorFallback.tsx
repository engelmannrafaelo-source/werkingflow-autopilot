import React from 'react';

interface TabErrorFallbackProps {
  tabName: string;
  error?: Error;
  onRetry?: () => void;
}

export default function TabErrorFallback({ tabName, error, onRetry }: TabErrorFallbackProps) {
  const handleCopyError = async () => {
    if (!error) return;

    const errorText = `Tab Error (${tabName})\n\nError: ${error.toString()}\n\nStack:\n${error.stack}`;

    try {
      await navigator.clipboard.writeText(errorText);
      alert('Error details copied to clipboard');
    } catch (err) {
      console.error('Failed to copy error:', err);
      alert('Failed to copy error details');
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '2rem',
        background: 'var(--tn-surface)',
        color: 'var(--tn-text)',
      }}
    >
      <div
        style={{
          maxWidth: '500px',
          width: '100%',
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-red)',
          borderRadius: '8px',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: '48px',
            marginBottom: '1rem',
            opacity: 0.8,
          }}
        >
          ⚠️
        </div>
        <h2
          style={{
            color: 'var(--tn-red)',
            marginBottom: '0.5rem',
            fontSize: '1.25rem',
            fontWeight: 700,
          }}
        >
          {tabName} Tab Error
        </h2>
        <p
          style={{
            color: 'var(--tn-text-muted)',
            marginBottom: '1.5rem',
            fontSize: '0.9rem',
          }}
        >
          Something went wrong while rendering this tab. Other tabs should still work.
        </p>

        {error && (
          <details
            style={{
              background: 'rgba(0,0,0,0.3)',
              padding: '1rem',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '1.5rem',
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
              }}
            >
              {error.toString()}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{
                padding: '0.5rem 1.5rem',
                background: 'var(--tn-green)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Reload Tab
            </button>
          )}
          {error && (
            <button
              onClick={handleCopyError}
              style={{
                padding: '0.5rem 1.5rem',
                background: 'var(--tn-blue)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Copy Error
            </button>
          )}
        </div>

        <p
          style={{
            marginTop: '1.5rem',
            fontSize: '0.75rem',
            color: 'var(--tn-text-muted)',
            fontStyle: 'italic',
          }}
        >
          If this problem persists, please report the issue with the error details above.
        </p>
      </div>
    </div>
  );
}

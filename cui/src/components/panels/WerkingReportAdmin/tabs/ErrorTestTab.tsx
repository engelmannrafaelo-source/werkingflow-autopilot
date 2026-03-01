import React, { useState } from 'react';

interface ErrorTestTabProps {
  envMode: string;
}

/**
 * Test tab for verifying error boundaries work correctly.
 * This tab allows triggering different types of errors to test error handling.
 */
export default function ErrorTestTab({ envMode }: ErrorTestTabProps) {
  const [shouldThrowRenderError, setShouldThrowRenderError] = useState(false);
  const [shouldThrowAsyncError, setShouldThrowAsyncError] = useState(false);

  // Test: Immediate render error
  if (shouldThrowRenderError) {
    throw new Error('Test render error triggered by user');
  }

  const handleAsyncError = async () => {
    setShouldThrowAsyncError(true);
    // Simulate async error (not caught by error boundary)
    setTimeout(() => {
      throw new Error('Test async error - not caught by error boundary!');
    }, 100);
  };

  const handleRenderError = () => {
    setShouldThrowRenderError(true);
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h2 style={{ color: 'var(--tn-text)', marginBottom: '1rem' }}>
        Error Boundary Test Tab
      </h2>
      <p style={{ color: 'var(--tn-text-muted)', marginBottom: '2rem' }}>
        Use the buttons below to test error boundary behavior.
        <br />
        Current environment: <strong>{envMode}</strong>
      </p>

      <div
        style={{
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '1rem',
        }}
      >
        <h3
          style={{
            color: 'var(--tn-text)',
            marginBottom: '1rem',
            fontSize: '1rem',
            fontWeight: 600,
          }}
        >
          Test 1: Render Error (Caught by Error Boundary)
        </h3>
        <p style={{ color: 'var(--tn-text-muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          This will throw an error during render, which should be caught by the tab-level error
          boundary. You should see the TabErrorFallback component with a "Reload Tab" button.
        </p>
        <button
          onClick={handleRenderError}
          style={{
            padding: '0.5rem 1rem',
            background: 'var(--tn-red)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Trigger Render Error
        </button>
      </div>

      <div
        style={{
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '1rem',
        }}
      >
        <h3
          style={{
            color: 'var(--tn-text)',
            marginBottom: '1rem',
            fontSize: '1rem',
            fontWeight: 600,
          }}
        >
          Test 2: Async Error (NOT Caught by Error Boundary)
        </h3>
        <p style={{ color: 'var(--tn-text-muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          This will throw an async error after 100ms. Error boundaries do NOT catch async errors.
          Check the console for the error. The UI should remain functional.
        </p>
        <button
          onClick={handleAsyncError}
          disabled={shouldThrowAsyncError}
          style={{
            padding: '0.5rem 1rem',
            background: shouldThrowAsyncError
              ? 'var(--tn-text-muted)'
              : 'var(--tn-orange)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: shouldThrowAsyncError ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          {shouldThrowAsyncError ? 'Error Thrown (Check Console)' : 'Trigger Async Error'}
        </button>
      </div>

      <div
        style={{
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: '8px',
          padding: '1.5rem',
        }}
      >
        <h3
          style={{
            color: 'var(--tn-text)',
            marginBottom: '1rem',
            fontSize: '1rem',
            fontWeight: 600,
          }}
        >
          Expected Behavior
        </h3>
        <ul style={{ color: 'var(--tn-text-muted)', fontSize: '0.9rem', paddingLeft: '1.5rem' }}>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Render Error:</strong> Tab shows TabErrorFallback with error message and
            "Reload Tab" button. Other tabs remain functional.
          </li>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Async Error:</strong> Error appears in console. Tab and UI remain functional.
            Error boundaries cannot catch async errors.
          </li>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Tab Switch:</strong> Switching to another tab and back resets the error
            boundary (key prop on ErrorBoundary).
          </li>
          <li>
            <strong>Copy Error:</strong> "Copy Error" button copies full error details to
            clipboard for debugging.
          </li>
        </ul>
      </div>
    </div>
  );
}

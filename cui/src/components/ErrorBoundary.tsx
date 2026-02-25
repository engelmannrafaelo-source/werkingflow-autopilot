import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '2rem',
          background: '#1a1a2e',
          border: '1px solid #ff6b6b',
          borderRadius: '8px',
          color: '#fff'
        }}>
          <h2 style={{ color: '#ff6b6b', marginBottom: '1rem' }}>⚠️ Component Error</h2>
          <p style={{ marginBottom: '1rem' }}>
            Something went wrong rendering this component.
          </p>
          <details style={{
            background: '#0f0f1e',
            padding: '1rem',
            borderRadius: '4px',
            cursor: 'pointer'
          }}>
            <summary style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
              Error Details
            </summary>
            <pre style={{
              fontSize: '0.85rem',
              overflow: 'auto',
              color: '#ff6b6b'
            }}>
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.error?.stack}
            </pre>
          </details>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              background: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

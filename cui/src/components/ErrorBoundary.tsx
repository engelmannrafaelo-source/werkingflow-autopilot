import React, { Component, ReactNode } from 'react';

// Tokyo Night theme tokens
const TN = {
  bg: '#1a1b26',
  surface: '#24283b',
  border: '#3b4261',
  text: '#a9b1d6',
  textMuted: '#565f89',
  red: '#f7768e',
  blue: '#7aa2f7',
  green: '#9ece6a',
} as const;

interface Props {
  children: ReactNode;
  /** Optional fallback UI when an error is caught */
  fallback?: ReactNode;
  /** Human-readable name of the wrapped component (shown in error UI) */
  componentName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * React Error Boundary that prevents white-screen crashes.
 *
 * Usage:
 *   <ErrorBoundary componentName="BrowserPanel">
 *     <BrowserPanel />
 *   </ErrorBoundary>
 *
 * Shows a dark-themed error card with:
 *  - Which component crashed (componentName or componentStack)
 *  - The error message and stack trace
 *  - "Reset" button to attempt recovery by clearing error state
 *  - "Reload" button to hard-reload the page as last resort
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const label = this.props.componentName || 'unknown';
    console.error(
      `[ErrorBoundary] Component "${label}" crashed:`,
      error,
      errorInfo.componentStack,
    );
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    const { error, componentStack } = this.state;
    const { componentName } = this.props;

    // Extract a short crash origin from componentStack (first indented line)
    let crashOrigin = componentName || '';
    if (!crashOrigin && componentStack) {
      const match = componentStack.match(/^\s+at\s+(\S+)/m);
      if (match) crashOrigin = match[1];
    }

    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: TN.bg,
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            background: TN.surface,
            border: `1px solid ${TN.red}40`,
            borderRadius: 8,
            padding: 24,
            boxShadow: `0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px ${TN.red}20`,
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: `${TN.red}20`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                color: TN.red,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              !
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: TN.text }}>
                Component Crash
              </div>
              {crashOrigin && (
                <div style={{ fontSize: 11, color: TN.textMuted, marginTop: 2 }}>
                  {crashOrigin}
                </div>
              )}
            </div>
          </div>

          {/* Error message */}
          <div
            style={{
              fontSize: 12,
              color: TN.red,
              background: `${TN.red}10`,
              border: `1px solid ${TN.red}20`,
              borderRadius: 4,
              padding: '8px 12px',
              marginBottom: 12,
              fontFamily: 'monospace',
              wordBreak: 'break-word',
              maxHeight: 80,
              overflow: 'auto',
            }}
          >
            {error?.message || String(error)}
          </div>

          {/* Expandable stack trace */}
          <details
            style={{
              marginBottom: 16,
              fontSize: 11,
              color: TN.textMuted,
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                padding: '4px 0',
                color: TN.textMuted,
              }}
            >
              Stack trace
            </summary>
            <pre
              style={{
                marginTop: 8,
                padding: 10,
                background: TN.bg,
                border: `1px solid ${TN.border}`,
                borderRadius: 4,
                fontSize: 10,
                lineHeight: 1.5,
                overflow: 'auto',
                maxHeight: 200,
                color: TN.textMuted,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {error?.stack || 'No stack trace available'}
              {componentStack && (
                <>
                  {'\n\n--- Component Stack ---\n'}
                  {componentStack}
                </>
              )}
            </pre>
          </details>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={this.handleReset}
              style={{
                flex: 1,
                padding: '8px 16px',
                fontSize: 12,
                fontWeight: 600,
                border: `1px solid ${TN.border}`,
                borderRadius: 6,
                background: TN.bg,
                color: TN.text,
                cursor: 'pointer',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = TN.blue; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = TN.border; }}
              title="Clear error state and try re-rendering the component"
            >
              Reset
            </button>
            <button
              onClick={this.handleReload}
              style={{
                flex: 1,
                padding: '8px 16px',
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                borderRadius: 6,
                background: TN.blue,
                color: '#fff',
                cursor: 'pointer',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              title="Full page reload"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

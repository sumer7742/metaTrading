import { Component } from 'react';

/**
 * Top-level error boundary — wraps the entire app so a render-time crash
 * in any page doesn't blank the whole screen. Shows a recoverable fallback
 * with the reqId-style error hash + a "Reload" button.
 *
 * In production, hook this to Sentry / Bugsnag via `componentDidCatch`.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorId: null };
  }

  static getDerivedStateFromError(error) {
    // Short hash of the message so the user has something to quote in a
    // bug report without exposing the full stack trace.
    const errorId = `E-${Math.abs(Array.from(error.message || '').reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0)).toString(36).slice(0, 6).toUpperCase()}`;
    return { error, errorId };
  }

  componentDidCatch(error, info) {
    // Fan out to your error reporter here. Sentry browser SDK example:
    //   Sentry.captureException(error, { extra: info });
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-bg-dark flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-bg-card border border-border-dark rounded-xl p-8 text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-white mb-2">Something went wrong</h1>
          <p className="text-sm text-text-secondary mb-1">
            Sorry — the app hit an unexpected error.
          </p>
          <p className="text-xs text-text-muted mb-6 font-mono">
            Error ID: {this.state.errorId}
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-primary-500 text-bg-dark font-semibold text-sm"
            >
              Reload page
            </button>
            <button
              onClick={() => { this.setState({ error: null, errorId: null }); }}
              className="px-4 py-2 rounded-md border border-border-dark text-text-secondary text-sm hover:bg-bg-hover"
            >
              Try again
            </button>
          </div>
          {this.state.error?.message && (
            <details className="mt-4 text-left">
              <summary className="text-xs text-text-muted cursor-pointer">Technical details</summary>
              <pre className="text-[10px] text-text-muted mt-2 bg-bg-panel p-2 rounded overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}

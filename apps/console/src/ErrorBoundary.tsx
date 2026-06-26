import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level error boundary. Without it, any uncaught render error blanks the
 * whole console to a white screen with no recovery path. This renders a
 * bilingual fallback with a reload affordance instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the failure for debugging; the fallback UI already informs the user.
    console.error('Console render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-card">
            <h1>Something went wrong / 页面出错了</h1>
            <p>
              The console hit an unexpected error. Reloading usually fixes it.
              <br />
              控制台遇到意外错误，刷新通常即可恢复。
            </p>
            {this.state.error.message ? (
              <pre className="error-boundary-detail">{this.state.error.message}</pre>
            ) : null}
            <button className="primary" onClick={() => window.location.reload()} type="button">
              Reload / 刷新
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

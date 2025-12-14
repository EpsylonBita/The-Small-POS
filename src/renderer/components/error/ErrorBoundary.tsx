import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ErrorHandler, ErrorFactory, POSError } from '../../../shared/utils/error-handler';
import { ErrorDisplay } from './ErrorDisplay';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: POSError, resetError: () => void) => ReactNode;
  onError?: (error: POSError, errorInfo: ErrorInfo) => void;
  showDetails?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: POSError | null;
  errorInfo: ErrorInfo | null;
}

/**
 * ErrorBoundary - React error boundary component
 * 
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI.
 * 
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <YourComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private errorHandler = ErrorHandler.getInstance();

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Convert to POSError
    const posError = ErrorFactory.system(
      error.message || 'An unexpected error occurred',
      {
        componentStack: errorInfo.componentStack,
        stack: error.stack,
        name: error.name
      }
    );

    // Log the error
    this.errorHandler.handle(posError);
    console.error('ErrorBoundary caught an error:', posError);

    // Update state with error details
    this.setState({
      error: posError,
      errorInfo
    });

    // Call optional error callback
    if (this.props.onError) {
      this.props.onError(posError, errorInfo);
    }
  }

  resetError = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.resetError);
      }

      // Default fallback UI
      return (
        <div
          style={{
            padding: '40px',
            maxWidth: '800px',
            margin: '0 auto'
          }}
        >
          <ErrorDisplay
            error={this.state.error}
            onRetry={this.resetError}
            showDetails={this.props.showDetails ?? process.env.NODE_ENV === 'development'}
          />

          {/* Additional help text */}
          <div
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '8px',
              padding: '16px',
              marginTop: '16px'
            }}
          >
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#333' }}>
              What can you do?
            </h4>
            <ul style={{ margin: '0', paddingLeft: '20px', fontSize: '13px', color: '#666' }}>
              <li>Click the "Retry" button to try again</li>
              <li>Refresh the page to restart the application</li>
              <li>If the problem persists, contact support</li>
            </ul>
          </div>

          {/* Component Stack (development only) */}
          {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
            <details style={{ marginTop: '16px' }}>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#666',
                  marginBottom: '8px'
                }}
              >
                Component Stack
              </summary>
              <pre
                style={{
                  backgroundColor: '#f5f5f5',
                  borderRadius: '6px',
                  padding: '12px',
                  fontSize: '11px',
                  color: '#555',
                  overflow: 'auto',
                  maxHeight: '300px',
                  fontFamily: 'monospace'
                }}
              >
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;


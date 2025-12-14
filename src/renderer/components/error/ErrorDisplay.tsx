import React from 'react';
import { POSError, ErrorSeverity, ErrorType } from '../../../shared/utils/error-handler';
import { useI18n } from '../../contexts/i18n-context';

interface ErrorDisplayProps {
  error: POSError | Error | string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  showDetails?: boolean;
  className?: string;
}

/**
 * ErrorDisplay - User-friendly error display component
 * 
 * Displays errors with appropriate severity styling and action buttons.
 * Supports retry functionality and detailed error information.
 */
export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error,
  onRetry,
  onDismiss,
  showDetails = false,
  className = ''
}) => {
  const { t } = useI18n();
  if (!error) return null;

  // Convert error to POSError if needed
  const posError: POSError = typeof error === 'string'
    ? {
        type: ErrorType.UNKNOWN,
        severity: ErrorSeverity.MEDIUM,
        code: 'UNKNOWN_ERROR',
        message: error,
        timestamp: new Date().toISOString(),
        context: {}
      }
    : error instanceof Error && !('type' in error)
    ? {
        type: ErrorType.SYSTEM,
        severity: ErrorSeverity.MEDIUM,
        code: 'SYSTEM_ERROR',
        message: error.message,
        timestamp: new Date().toISOString(),
        context: {},
        stack: error.stack
      }
    : error as POSError;

  // Determine severity color
  const getSeverityColor = (severity: ErrorSeverity): string => {
    switch (severity) {
      case 'CRITICAL':
        return '#d32f2f'; // Red
      case 'HIGH':
        return '#f57c00'; // Orange
      case 'MEDIUM':
        return '#ffa726'; // Light orange
      case 'LOW':
        return '#fbc02d'; // Yellow
      default:
        return '#757575'; // Gray
    }
  };

  const getSeverityIcon = (severity: ErrorSeverity): string => {
    switch (severity) {
      case 'CRITICAL':
        return '🚨';
      case 'HIGH':
        return '⚠️';
      case 'MEDIUM':
        return '⚡';
      case 'LOW':
        return 'ℹ️';
      default:
        return '❓';
    }
  };

  const severityColor = getSeverityColor(posError.severity);
  const severityIcon = getSeverityIcon(posError.severity);

  return (
    <div
      className={`error-display ${className}`}
      style={{
        backgroundColor: '#fff',
        border: `2px solid ${severityColor}`,
        borderRadius: '12px',
        padding: '20px',
        marginBottom: '16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div
          style={{
            fontSize: '32px',
            marginRight: '12px',
            lineHeight: '1'
          }}
        >
          {severityIcon}
        </div>
        <div style={{ flex: '1' }}>
          <h3
            style={{
              margin: '0 0 8px 0',
              color: severityColor,
              fontSize: '18px',
              fontWeight: '600'
            }}
          >
            {posError.severity === 'CRITICAL' ? 'Critical Error' :
             posError.severity === 'HIGH' ? 'Error' :
             posError.severity === 'MEDIUM' ? 'Warning' :
             'Notice'}
          </h3>
          <p
            style={{
              margin: '0',
              color: '#333',
              fontSize: '14px',
              lineHeight: '1.5'
            }}
          >
            {posError.message}
          </p>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '0',
              marginLeft: '12px',
              color: '#999',
              lineHeight: '1'
            }}
            aria-label={t('errors.dismissError')}
          >
            ✕
          </button>
        )}
      </div>

      {/* Error Code */}
      {posError.code && (
        <div
          style={{
            fontSize: '12px',
            color: '#666',
            marginBottom: '12px',
            fontFamily: 'monospace'
          }}
        >
          Error Code: {posError.code}
        </div>
      )}

      {/* Details (expandable) */}
      {showDetails && posError.details && (
        <div
          style={{
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            padding: '12px',
            marginBottom: '12px',
            fontSize: '13px',
            color: '#555'
          }}
        >
          <strong>Details:</strong>
          <pre
            style={{
              margin: '8px 0 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '12px'
            }}
          >
            {typeof posError.details === 'string'
              ? posError.details
              : JSON.stringify(posError.details, null, 2)}
          </pre>
        </div>
      )}

      {/* Stack Trace (only in development) */}
      {showDetails && posError.stack && process.env.NODE_ENV === 'development' && (
        <details style={{ marginBottom: '12px' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: '13px',
              color: '#666',
              marginBottom: '8px'
            }}
          >
            Stack Trace
          </summary>
          <pre
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '6px',
              padding: '12px',
              fontSize: '11px',
              color: '#555',
              overflow: 'auto',
              maxHeight: '200px',
              fontFamily: 'monospace'
            }}
          >
            {posError.stack}
          </pre>
        </details>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              backgroundColor: severityColor,
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'opacity 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
          >
            🔄 Retry
          </button>
        )}
        {onDismiss && !onRetry && (
          <button
            onClick={onDismiss}
            style={{
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#e0e0e0')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#f5f5f5')}
          >
            Dismiss
          </button>
        )}
      </div>

      {/* Timestamp */}
      {posError.timestamp && (
        <div
          style={{
            fontSize: '11px',
            color: '#999',
            marginTop: '12px',
            textAlign: 'right'
          }}
        >
          {new Date(posError.timestamp).toLocaleString()}
        </div>
      )}
    </div>
  );
};

export default ErrorDisplay;


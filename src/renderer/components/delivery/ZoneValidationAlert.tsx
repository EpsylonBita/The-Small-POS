/**
 * ZoneValidationAlert
 *
 * Alert component for delivery zone validation feedback
 * Displays validation results, zone information, and override options
 */

import React, { useState } from 'react';
import type { DeliveryBoundaryValidationResponse } from '../../../../../shared/types/delivery-validation';
import { useTheme } from '../../contexts/theme-context';

interface ZoneValidationAlertProps {
  validationResult: DeliveryBoundaryValidationResponse;
  onOverride?: () => void;
  onChangeAddress?: () => void;
  onSwitchToPickup?: () => void;
  className?: string;
}

export const ZoneValidationAlert: React.FC<ZoneValidationAlertProps> = ({
  validationResult,
  onOverride,
  onChangeAddress,
  onSwitchToPickup,
  className = ''
}) => {
  const { resolvedTheme } = useTheme();
  const [showOverrideForm, setShowOverrideForm] = useState(false);

  // Theme colors based on resolvedTheme
  const themeColors = {
    text: resolvedTheme === 'dark' ? '#e5e7eb' : '#1f2937',
    textSecondary: resolvedTheme === 'dark' ? '#9ca3af' : '#6b7280',
    border: resolvedTheme === 'dark' ? '#374151' : '#d1d5db',
    primary: '#3b82f6',
    warning: '#fbbf24'
  };

  // Determine alert state from validation result
  const getAlertState = () => {
    if (validationResult.deliveryAvailable && validationResult.zone) {
      return 'success';
    }
    if (!validationResult.deliveryAvailable && validationResult.uiState?.requiresManagerApproval) {
      return 'warning';
    }
    if (validationResult.uiState?.indicator === 'error' || (!validationResult.success && validationResult.reason)) {
      return 'error';
    }
    return 'info';
  };

  const alertState = getAlertState();

  // Get colors based on state
  const getColors = () => {
    switch (alertState) {
      case 'success':
        return {
          bg: 'rgba(34, 197, 94, 0.1)',
          border: '#22c55e',
          text: '#22c55e',
          icon: '✓'
        };
      case 'warning':
        return {
          bg: 'rgba(251, 191, 36, 0.1)',
          border: '#fbbf24',
          text: '#fbbf24',
          icon: '⚠'
        };
      case 'error':
        return {
          bg: 'rgba(239, 68, 68, 0.1)',
          border: '#ef4444',
          text: '#ef4444',
          icon: '✕'
        };
      default:
        return {
          bg: 'rgba(59, 130, 246, 0.1)',
          border: '#3b82f6',
          text: '#3b82f6',
          icon: 'ℹ'
        };
    }
  };

  const colors = getColors();

  // Format delivery time
  const formatDeliveryTime = (zone: NonNullable<typeof validationResult.zone>) => {
    if (zone.estimatedTime) {
      return `${zone.estimatedTime.min}-${zone.estimatedTime.max} min`;
    }
    return 'N/A';
  };

  // Format currency
  const formatCurrency = (amount: number) => {
    return `€${amount.toFixed(2)}`;
  };

  return (
    <div
      className={className}
      style={{
        backgroundColor: colors.bg,
        border: `2px solid ${colors.border}`,
        borderRadius: '12px',
        padding: '16px',
        marginBottom: '16px',
        backdropFilter: 'blur(10px)'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
        <span
          style={{
            fontSize: '24px',
            marginRight: '12px',
            color: colors.text
          }}
        >
          {colors.icon}
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            color: themeColors.text
          }}
        >
          {validationResult.message || 'Delivery Validation'}
        </h3>
      </div>

      {/* Success State - Zone Info */}
      {alertState === 'success' && validationResult.zone && (
        <div style={{ marginBottom: '12px' }}>
          {/* Zone Name Badge */}
          <div
            style={{
              display: 'inline-block',
              backgroundColor: colors.border,
              color: '#ffffff',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 600,
              marginBottom: '12px'
            }}
          >
            {validationResult.zone.name}
          </div>

          {/* Zone Details */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
              marginTop: '12px'
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '12px',
                  color: themeColors.textSecondary,
                  marginBottom: '4px'
                }}
              >
                Delivery Fee
              </div>
              <div
                style={{
                  fontSize: '16px',
                  fontWeight: 600,
                  color: themeColors.text
                }}
              >
                {formatCurrency(validationResult.zone.deliveryFee)}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: '12px',
                  color: themeColors.textSecondary,
                  marginBottom: '4px'
                }}
              >
                Estimated Time
              </div>
              <div
                style={{
                  fontSize: '16px',
                  fontWeight: 600,
                  color: themeColors.text
                }}
              >
                {formatDeliveryTime(validationResult.zone)}
              </div>
            </div>

            {validationResult.zone.minimumOrderAmount > 0 && (
              <div>
                <div
                  style={{
                    fontSize: '12px',
                    color: themeColors.textSecondary,
                    marginBottom: '4px'
                  }}
                >
                  Minimum Order
                </div>
                <div
                  style={{
                    fontSize: '16px',
                    fontWeight: 600,
                    color: themeColors.text
                  }}
                >
                  {formatCurrency(validationResult.zone.minimumOrderAmount)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Out-of-Zone State - Warning */}
      {alertState === 'warning' && (
        <div style={{ marginBottom: '12px' }}>
          <p
            style={{
              margin: '0 0 12px 0',
              fontSize: '14px',
              color: themeColors.text
            }}
          >
            {validationResult.message || 'Address is outside our delivery area'}
          </p>

          {/* Show nearest zone if available */}
          {validationResult.alternatives?.nearestZone && (
            <div
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.05)',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '12px'
              }}
            >
              <div
                style={{
                  fontSize: '12px',
                  color: themeColors.textSecondary,
                  marginBottom: '4px'
                }}
              >
                Nearest Delivery Zone
              </div>
              <div style={{ fontSize: '14px', color: themeColors.text }}>
                <strong>{validationResult.alternatives.nearestZone.name}</strong>
                {' - '}
                {(validationResult.alternatives.nearestZone.distance / 1000).toFixed(1)} km away
              </div>
            </div>
          )}

          {/* Alternative Options */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {onOverride && (
              <button
                onClick={() => setShowOverrideForm(true)}
                style={{
                  backgroundColor: colors.border,
                  color: '#ffffff',
                  border: 'none',
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'opacity 0.2s'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.8')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                Request Override
              </button>
            )}

            {onChangeAddress && (
              <button
                onClick={onChangeAddress}
                style={{
                  backgroundColor: 'transparent',
                  color: themeColors.text,
                  border: `2px solid ${themeColors.border}`,
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Choose Different Address
              </button>
            )}

            {onSwitchToPickup && validationResult.alternatives?.pickup && (
              <button
                onClick={onSwitchToPickup}
                style={{
                  backgroundColor: 'transparent',
                  color: themeColors.text,
                  border: `2px solid ${themeColors.border}`,
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Switch to Pickup
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error State */}
      {alertState === 'error' && (
        <div>
          <p
            style={{
              margin: '0 0 8px 0',
              fontSize: '14px',
              color: themeColors.text
            }}
          >
            {validationResult.message || 'Validation failed'}
          </p>
          {validationResult.reason && (
            <p
              style={{
                margin: '8px 0 0 0',
                fontSize: '12px',
                color: themeColors.textSecondary,
                fontStyle: 'italic'
              }}
            >
              Reason: {validationResult.reason}
            </p>
          )}
        </div>
      )}

      {/* Override Form (if shown) */}
      {showOverrideForm && onOverride && (
        <div
          style={{
            marginTop: '16px',
            paddingTop: '16px',
            borderTop: `1px solid ${themeColors.border}`
          }}
        >
          <h4
            style={{
              margin: '0 0 12px 0',
              fontSize: '14px',
              fontWeight: 600,
              color: themeColors.text
            }}
          >
            Request Delivery Override
          </h4>
          <p
            style={{
              margin: '0 0 12px 0',
              fontSize: '12px',
              color: themeColors.textSecondary
            }}
          >
            This will request manager approval for out-of-zone delivery.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                onOverride();
                setShowOverrideForm(false);
              }}
              style={{
                flex: 1,
                backgroundColor: themeColors.primary,
                color: '#ffffff',
                border: 'none',
                padding: '10px 16px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Confirm Request
            </button>
            <button
              onClick={() => setShowOverrideForm(false)}
              style={{
                flex: 1,
                backgroundColor: 'transparent',
                color: themeColors.text,
                border: `2px solid ${themeColors.border}`,
                padding: '10px 16px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Additional message or reason */}
      {validationResult.reason && validationResult.reason !== 'VALIDATION_SERVICE_UNAVAILABLE' && (
        <div
          style={{
            marginTop: '12px',
            padding: '8px 12px',
            backgroundColor: 'rgba(251, 191, 36, 0.1)',
            borderRadius: '6px',
            fontSize: '12px',
            color: themeColors.warning
          }}
        >
          <div>{validationResult.reason}</div>
        </div>
      )}
    </div>
  );
};

import React, { useState, useEffect, useCallback } from 'react';
import { MapPin, AlertTriangle, CheckCircle, Clock, Shield, Settings } from 'lucide-react';
import { 
  DeliveryBoundaryValidationRequest,
  DeliveryBoundaryValidationResponse,
} from '../../../shared/types/delivery-validation';
import { DeliveryValidationService } from '../../../shared/services/DeliveryValidationService';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';

// UI State type for delivery validation
interface DeliveryValidationUIState {
  isValidating: boolean;
  indicator?: 'success' | 'warning' | 'error' | 'info';
  showOverrideOption?: boolean;
  requiresManagerApproval?: boolean;
  canProceed?: boolean;
  message?: string;
  showOverrideModal?: boolean;
  showZoneSelector?: boolean;
  showManagerApproval?: boolean;
  addressInput?: string;
  error?: string;
  validationResult?: DeliveryBoundaryValidationResponse;
}

interface DeliveryValidationComponentProps {
  orderAmount: number;
  onValidationResult: (result: DeliveryBoundaryValidationResponse) => void;
  onAddressChange: (address: string, coordinates?: { lat: number; lng: number }) => void;
  staffId: string;
  staffRole: 'staff' | 'manager' | 'admin';
  className?: string;
}

export function DeliveryValidationComponent({
  orderAmount,
  onValidationResult,
  onAddressChange,
  staffId,
  staffRole,
  className = ''
}: DeliveryValidationComponentProps) {
  const { t } = useTranslation()
  const [uiState, setUIState] = useState<DeliveryValidationUIState>({
    isValidating: false,
    showOverrideModal: false,
    showZoneSelector: false,
    showManagerApproval: false,
    addressInput: '',
    error: undefined
  });

  const [validationService] = useState(() => 
    DeliveryValidationService.getInstance(
      process.env.REACT_APP_API_URL || 'http://localhost:3001/api',
      {
        enableBoundaryValidation: true,
        enableOverrides: true,
        requireManagerApprovalForOverrides: staffRole !== 'manager' && staffRole !== 'admin',
        maxCustomDeliveryFee: staffRole === 'admin' ? 100 : staffRole === 'manager' ? 50 : 20,
        defaultOutOfBoundsMessage: 'This address is outside our delivery area.',
        enableRealTimeValidation: true,
        enableGeocoding: true,
        geocodingProvider: 'google',
        cacheValidationResults: true,
        logAllValidationAttempts: true,
        showAlternativeZones: true,
        enableDistanceCalculation: true,
        maxDeliveryDistance: 15000 // 15km
      }
    )
  );

  // Debounced validation
  const [validationTimeout, setValidationTimeout] = useState<NodeJS.Timeout | null>(null);

  const validateAddress = useCallback(async (address: string, skipValidation = false) => {
    if (!address.trim()) {
      setUIState(prev => ({ ...prev, validationResult: undefined, error: undefined }));
      return;
    }

    setUIState(prev => ({ ...prev, isValidating: true, error: undefined }));

    try {
      const request: DeliveryBoundaryValidationRequest = {
        address,
        orderAmount,
        staffId,
        skipValidation,
        overrideReason: skipValidation ? 'Staff override for customer convenience' : undefined
      };

      const result = await validationService.validateDeliveryAddress(request);
      
      setUIState(prev => ({ 
        ...prev, 
        validationResult: result,
        isValidating: false,
        coordinates: result.coordinates
      }));

      onValidationResult(result);
      
      if (result.coordinates) {
        onAddressChange(address, result.coordinates);
      }

    } catch (error) {
      console.error('Validation error:', error);
      setUIState(prev => ({ 
        ...prev, 
        isValidating: false,
        error: 'Failed to validate address. Please try again.'
      }));
    }
  }, [orderAmount, staffId, validationService, onValidationResult, onAddressChange]);

  const handleAddressInput = useCallback((value: string) => {
    setUIState(prev => ({ ...prev, addressInput: value }));
    onAddressChange(value);

    // Clear existing timeout
    if (validationTimeout) {
      clearTimeout(validationTimeout);
    }

    // Set new timeout for debounced validation
    const timeout = setTimeout(() => {
      validateAddress(value);
    }, 500);

    setValidationTimeout(timeout);
  }, [validateAddress, validationTimeout]);

  const handleOverride = useCallback(() => {
    if (uiState.addressInput) {
      validateAddress(uiState.addressInput, true);
      setUIState(prev => ({ ...prev, showOverrideModal: false }));
    }
  }, [uiState.addressInput, validateAddress]);

  const getValidationIndicator = () => {
    if (uiState.isValidating) {
      return (
        <div className="flex items-center gap-2 text-blue-600">
          <Clock className="w-4 h-4 animate-spin" />
          <span className="text-sm">{t('delivery.zone.validating')}</span>
        </div>
      );
    }

    if (!uiState.validationResult) {
      return null;
    }

    const { validationResult } = uiState;

    switch (validationResult.uiState?.indicator) {
      case 'success':
        return (
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle className="w-4 h-4" />
            <span className="text-sm">
              {t('delivery.zone.deliveryAvailable')}
              {' | '}
              {validationResult.zone?.name}
              {' | '}
              {t('delivery.fields.deliveryFee', { defaultValue: 'Delivery fee' })}: {formatCurrency(validationResult.zone?.deliveryFee ?? 0)}
            </span>
          </div>
        );

      case 'warning':
        return (
          <div className="flex items-center gap-2 text-orange-600">
            <Shield className="w-4 h-4" />
            <span className="text-sm">{t('delivery.zone.overrideApplied')}</span>
          </div>
        );
      
      case 'error':
        return (
          <div className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm">{validationResult.message}</span>
          </div>
        );
      
      default:
        return null;
    }
  };

  const canShowOverride = () => {
    return uiState.validationResult?.uiState?.showOverrideOption && 
           (staffRole === 'manager' || staffRole === 'admin' || 
            !uiState.validationResult?.uiState?.requiresManagerApproval);
  };

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Address Input */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('delivery.fields.deliveryAddress')}
        </label>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={uiState.addressInput}
            onChange={(e) => handleAddressInput(e.target.value)}
            placeholder={t('forms.placeholders.enterAddress')}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg 
                     bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                     focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Validation Indicator */}
      <div className="min-h-[24px]">
        {getValidationIndicator()}
        {uiState.error && (
          <div className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm">{uiState.error}</span>
          </div>
        )}
      </div>

      {/* Validation Details */}
      {uiState.validationResult && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
          {/* Zone Information */}
          {uiState.validationResult.zone && (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-600 dark:text-gray-400">{t('delivery.zone.zoneLabel')}</span>
                <span className="ml-2 font-medium">{uiState.validationResult.zone.name}</span>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">{t('delivery.zone.deliveryFeeLabel')}</span>
                <span className="ml-2 font-medium">{formatCurrency(uiState.validationResult.zone.deliveryFee)}</span>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">{t('delivery.zone.minimumOrderLabel')}</span>
                <span className="ml-2 font-medium">{formatCurrency(uiState.validationResult.zone.minimumOrderAmount)}</span>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">{t('delivery.zone.estTimeLabel')}</span>
                <span className="ml-2 font-medium">
                  {uiState.validationResult.zone.estimatedTime.min}-{uiState.validationResult.zone.estimatedTime.max} min
                </span>
              </div>
            </div>
          )}

          {/* Validation Status */}
          {uiState.validationResult.validation && (
            <div className="space-y-2">
              {!uiState.validationResult.validation.meetsMinimumOrder && (
                <div className="text-sm text-orange-600 dark:text-orange-400">
                  <span className="inline-flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                    Order amount ({formatCurrency(orderAmount)}) is below minimum ({formatCurrency(uiState.validationResult.zone?.minimumOrderAmount || 0)}).
                  </span>
                  <div className="mt-1">Add {formatCurrency(uiState.validationResult.validation.shortfall)} more to qualify for delivery.</div>
                </div>
              )}
            </div>
          )}

          {/* Override Information */}
          {uiState.validationResult.override?.applied && (
            <div className="bg-orange-100 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded p-3">
              <div className="flex items-center gap-2 text-orange-800 dark:text-orange-400">
                <Shield className="w-4 h-4" />
                <span className="font-medium">Delivery Override Applied</span>
              </div>
              <div className="mt-1 text-sm text-orange-700 dark:text-orange-300">
                Reason: {uiState.validationResult.override.reason}
              </div>
              {uiState.validationResult.override.customDeliveryFee && (
                <div className="mt-1 text-sm text-orange-700 dark:text-orange-300">
                  Custom delivery fee: {formatCurrency(uiState.validationResult.override.customDeliveryFee)}
                </div>
              )}
            </div>
          )}

          {/* Alternative Options */}
          {uiState.validationResult.alternatives && !uiState.validationResult.deliveryAvailable && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Alternative Options:
              </div>
              {uiState.validationResult.alternatives.pickup && (
                <div className="text-sm text-blue-600 dark:text-blue-400">
                  <span className="inline-flex items-center gap-2"><CheckCircle className="w-4 h-4" aria-hidden="true" />Pickup available at our location</span>
                </div>
              )}
              {uiState.validationResult.alternatives.nearestZone && (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Nearest delivery zone: {uiState.validationResult.alternatives.nearestZone.name} 
                  ({Math.round(uiState.validationResult.alternatives.nearestZone.distance / 1000 * 10) / 10}km away)
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Override Button */}
      {canShowOverride() && !uiState.validationResult?.deliveryAvailable && (
        <div className="flex gap-2">
          <button
            onClick={() => setUIState(prev => ({ ...prev, showOverrideModal: true }))}
            className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Override Delivery Restriction
          </button>
        </div>
      )}

      {/* Override Confirmation Modal */}
      {uiState.showOverrideModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Override Delivery Restriction
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              This address is outside the normal delivery area. Are you sure you want to proceed with delivery?
            </p>
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded p-3 mb-4">
              <div className="text-sm text-yellow-800 dark:text-yellow-400">
                <span className="inline-flex items-center gap-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" />This action will be logged for review.</span>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleOverride}
                className="flex-1 bg-orange-600 text-white py-2 px-4 rounded-lg hover:bg-orange-700 transition-colors"
              >
                Confirm Override
              </button>
              <button
                onClick={() => setUIState(prev => ({ ...prev, showOverrideModal: false }))}
                className="flex-1 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 py-2 px-4 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

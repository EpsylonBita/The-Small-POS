import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, AlertTriangle, CheckCircle, Clock, Shield, Settings } from 'lucide-react';
import { 
  DeliveryBoundaryValidationRequest,
  DeliveryBoundaryValidationResponse,
} from '../../../shared/types/delivery-validation';
import { DeliveryValidationService } from '../../../shared/services/DeliveryValidationService';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import { renderModalPortal } from '../../utils/render-modal-portal';

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
  initialAddress?: string;
}

export function DeliveryValidationComponent({
  orderAmount,
  onValidationResult,
  onAddressChange,
  staffId,
  staffRole,
  className = '',
  initialAddress = '',
}: DeliveryValidationComponentProps) {
  const { t } = useTranslation()
  const [uiState, setUIState] = useState<DeliveryValidationUIState>({
    isValidating: false,
    showOverrideModal: false,
    showZoneSelector: false,
    showManagerApproval: false,
    addressInput: initialAddress,
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
  const initializedAddressRef = useRef<string | null>(null);

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

  useEffect(() => {
    const address = initialAddress.trim();
    if (initializedAddressRef.current === address) {
      return;
    }
    initializedAddressRef.current = address;
    setUIState(prev => ({ ...prev, addressInput: address }));
    if (address) {
      void validateAddress(address);
    }
  }, [initialAddress, validateAddress]);

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
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-300">
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
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-300">
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
          {t('delivery.fields.deliveryAddress')} *
        </label>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={uiState.addressInput}
            onChange={(e) => handleAddressInput(e.target.value)}
            placeholder={t('forms.placeholders.enterAddress')}
            required
            aria-required="true"
            className="w-full rounded-2xl border border-gray-300 bg-white/80 py-2.5 pl-10 pr-4 text-gray-900 outline-none backdrop-blur-sm transition-shadow focus:border-amber-400 focus:ring-2 focus:ring-amber-400/35 dark:border-white/10 dark:bg-zinc-950/70 dark:text-white"
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
        <div className="space-y-3 rounded-[22px] border border-gray-200/80 bg-white/72 p-4 shadow-[0_14px_34px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/62 dark:shadow-[0_18px_42px_rgba(0,0,0,0.34)]">
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
                <div className="text-sm text-amber-700 dark:text-amber-300">
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
            <div className="rounded-2xl border border-amber-300/70 bg-amber-100/70 p-3 dark:border-amber-400/25 dark:bg-amber-500/12">
              <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
                <Shield className="w-4 h-4" />
                <span className="font-medium">Delivery Override Applied</span>
              </div>
              <div className="mt-1 text-sm text-amber-800 dark:text-amber-200/85">
                Reason: {uiState.validationResult.override.reason}
              </div>
              {uiState.validationResult.override.customDeliveryFee && (
                <div className="mt-1 text-sm text-amber-800 dark:text-amber-200/85">
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
                <div className="text-sm text-emerald-700 dark:text-emerald-300">
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
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl bg-amber-400 px-4 py-2 font-semibold text-black transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 disabled:opacity-50"
          >
            <Settings className="w-4 h-4" />
            Override Delivery Restriction
          </button>
        </div>
      )}

      {/* Override Confirmation Modal */}
      {uiState.showOverrideModal && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 backdrop-blur-md">
          <div className="mx-4 w-full max-w-md rounded-[28px] border border-white/25 bg-white/72 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl dark:border-white/12 dark:bg-zinc-950/74">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Override Delivery Restriction
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              This address is outside the normal delivery area. Are you sure you want to proceed with delivery?
            </p>
            <div className="mb-4 rounded-2xl border border-amber-300/70 bg-amber-100/70 p-3 dark:border-amber-400/25 dark:bg-amber-500/12">
              <div className="text-sm text-amber-900 dark:text-amber-200">
                <span className="inline-flex items-center gap-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" />This action will be logged for review.</span>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleOverride}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-2xl bg-amber-400 px-4 py-2 font-semibold text-black transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80"
              >
                Confirm Override
              </button>
              <button
                onClick={() => setUIState(prev => ({ ...prev, showOverrideModal: false }))}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-2xl bg-red-600 px-4 py-2 font-semibold text-white transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/80"
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

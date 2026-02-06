/**
 * useDeliveryValidation
 *
 * React hook for delivery zone validation in POS renderer
 * Provides easy-to-use validation interface with:
 * - Loading and error states
 * - Debounced validation calls
 * - Result caching
 * - Analytics tracking
 * - Override request handling
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { DeliveryZoneValidator } from '../../services/DeliveryZoneValidator';
import { useShift } from '../contexts/shift-context';
import { supabase } from '../lib/supabase';
import {
  getCachedTerminalCredentials,
  updateTerminalCredentialCache,
} from '../services/terminal-credentials';
import type {
  DeliveryBoundaryValidationResponse,
  DeliveryOverrideResponse
} from '../../shared/types/delivery-validation';

interface UseDeliveryValidationOptions {
  debounceMs?: number;
  autoValidate?: boolean;
  cacheResults?: boolean;
}

interface UseDeliveryValidationReturn {
  validateAddress: (
    address: string | { lat: number; lng: number },
    orderAmount?: number
  ) => Promise<DeliveryBoundaryValidationResponse>;
  validationResult: DeliveryBoundaryValidationResponse | null;
  isValidating: boolean;
  error: string | null;
  clearValidation: () => void;
  requestOverride: (
    reason: string,
    customFee?: number
  ) => Promise<DeliveryOverrideResponse>;
}

export function useDeliveryValidation(
  options: UseDeliveryValidationOptions = {}
): UseDeliveryValidationReturn {
  const {
    debounceMs = 500,
    autoValidate = true,
    cacheResults = true
  } = options;

  // State
  const [validationResult, setValidationResult] =
    useState<DeliveryBoundaryValidationResponse | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const validatorRef = useRef<DeliveryZoneValidator | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastAddressRef = useRef<string | { lat: number; lng: number } | null>(null);

  // Get shift context for branch, terminal, staff
  const shift = useShift();

  // Initialize validator
  useEffect(() => {
    if (!shift.activeShift) return;

    const apiKey = getCachedTerminalCredentials().apiKey || '';

    try {
      validatorRef.current = new DeliveryZoneValidator({
        branchId: shift.activeShift.branch_id,
        terminalId: shift.activeShift.terminal_id,
        staffId: shift.activeShift.staff_id,
        enableCaching: cacheResults,
        cacheExpiryMs: 30 * 60 * 1000, // 30 minutes
        enableAnalytics: true,
        apiKey: apiKey || undefined
      });

      // Always try to get API key from IPC to ensure we have the latest
      if (typeof window !== 'undefined' && (window as any).electronAPI?.getTerminalApiKey) {
        (window as any).electronAPI.getTerminalApiKey().then((ipcApiKey: string) => {
          if (ipcApiKey && validatorRef.current) {
            validatorRef.current.updateAuth(undefined, ipcApiKey);
            updateTerminalCredentialCache({ apiKey: ipcApiKey });
          }
        }).catch((err: Error) => {
          console.warn('[useDeliveryValidation] Failed to get API key from IPC:', err);
        });
      }
    } catch (err) {
      console.error('[useDeliveryValidation] Error initializing validator:', err);
      setError('Failed to initialize delivery validator');
    }

    // Cleanup
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [shift.activeShift, cacheResults]);

  // Subscribe to delivery_zones changes for realtime updates
  useEffect(() => {
    // DISABLED: Real-time subscriptions are now handled by the main process (sync-service)
    // to prevent multiple WebSocket connections which cause connection failures.
    console.log('[useDeliveryValidation] Real-time subscription disabled - using main process IPC instead');
    return; // Exit early - no subscription created

    /* DISABLED - Real-time subscription handled by main process
    // Only subscribe if we have an active shift
    if (!shift.activeShift) return;

    console.log('[useDeliveryValidation] Setting up realtime subscription to delivery_zones');

    // Subscribe to delivery_zones table changes
    const channel = supabase
      .channel('delivery_zones_changes')
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to all events (INSERT, UPDATE, DELETE)
          schema: 'public',
          table: 'delivery_zones'
        },
        (payload) => {
          console.log('[useDeliveryValidation] Delivery zone changed:', payload);

          // Clear validator cache when zones are updated
          if (validatorRef.current) {
            validatorRef.current.clearCache();
            console.log('[useDeliveryValidation] Cache cleared due to zone update');
          }

          // If we have a current validation result, re-validate
          if (lastAddressRef.current && autoValidate && validatorRef.current) {
            console.log('[useDeliveryValidation] Re-validating address after zone update');
            // Call validator directly to avoid dependency issues
            validatorRef.current.validateAddress(lastAddressRef.current).catch((err) => {
              console.error('[useDeliveryValidation] Re-validation failed:', err);
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('[useDeliveryValidation] Realtime subscription status:', status);
      });

    // Cleanup subscription
    return () => {
      console.log('[useDeliveryValidation] Cleaning up realtime subscription');
      supabase.removeChannel(channel);
    };
    */
  }, [shift.activeShift, autoValidate]);

  /**
   * Validate delivery address
   */
  const validateAddress = useCallback(
    async (
      address: string | { lat: number; lng: number },
      orderAmount?: number
    ): Promise<DeliveryBoundaryValidationResponse> => {
      // Clear existing error
      setError(null);

      // Check if validator is initialized
      if (!validatorRef.current) {
        const errorMsg = 'Validator not initialized. Please ensure shift is active.';
        setError(errorMsg);
        return {
          isValid: false,
          success: false,
          deliveryAvailable: false,
          message: errorMsg,
          reason: 'VALIDATION_SERVICE_UNAVAILABLE',
          uiState: {
            indicator: 'error',
            showOverrideOption: false,
            requiresManagerApproval: true,
            canProceed: false
          }
        };
      }

      // Clear existing debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Store last address for reference
      lastAddressRef.current = address;

      // Debounce validation
      return new Promise((resolve) => {
        debounceTimerRef.current = setTimeout(async () => {
          setIsValidating(true);
          setError(null);

          try {
            const result = await validatorRef.current!.validateAddress(
              address,
              orderAmount
            );

            setValidationResult(result);
            setIsValidating(false);
            resolve(result);
          } catch (err) {
            const errorMsg =
              err instanceof Error ? err.message : 'Validation failed';
            setError(errorMsg);
            setIsValidating(false);

            const errorResult: DeliveryBoundaryValidationResponse = {
              isValid: false,
              success: false,
              deliveryAvailable: false,
              message: errorMsg,
              reason: 'VALIDATION_SERVICE_UNAVAILABLE',
              uiState: {
                indicator: 'error',
                showOverrideOption: false,
                requiresManagerApproval: true,
                canProceed: false
              }
            };

            setValidationResult(errorResult);
            resolve(errorResult);
          }
        }, debounceMs);
      });
    },
    [debounceMs]
  );

  /**
   * Request override for out-of-zone delivery
   */
  const requestOverride = useCallback(
    async (
      reason: string,
      customFee?: number
    ): Promise<DeliveryOverrideResponse> => {
      if (!validatorRef.current) {
        return {
          success: false,
          approved: false,
          message: 'Validator not initialized',
          requiresManagerApproval: true
        };
      }

      if (!validationResult || !lastAddressRef.current) {
        return {
          success: false,
          approved: false,
          message: 'No validation result available',
          requiresManagerApproval: true
        };
      }

      // Get coordinates from validation result or last address
      let coordinates: { lat: number; lng: number };

      if (typeof lastAddressRef.current === 'object') {
        coordinates = lastAddressRef.current;
      } else if (validationResult.coordinates) {
        coordinates = validationResult.coordinates;
      } else {
        return {
          success: false,
          approved: false,
          message: 'No coordinates available for override',
          requiresManagerApproval: true
        };
      }

      try {
        const response = await validatorRef.current.requestOverride(
          undefined, // orderId will be set when order is created
          coordinates,
          reason,
          customFee
        );

        return response;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Override request failed';
        return {
          success: false,
          approved: false,
          message: errorMsg,
          requiresManagerApproval: true
        };
      }
    },
    [validationResult]
  );

  /**
   * Clear validation result and error
   */
  const clearValidation = useCallback(() => {
    setValidationResult(null);
    setError(null);
    setIsValidating(false);
    lastAddressRef.current = null;
  }, []);

  return {
    validateAddress,
    validationResult,
    isValidating,
    error,
    clearValidation,
    requestOverride
  };
}

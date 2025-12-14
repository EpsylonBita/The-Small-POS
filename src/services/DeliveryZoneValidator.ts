/**
 * DeliveryZoneValidator
 *
 * POS-specific service for delivery zone validation
 * Wraps shared DeliveryValidationService with POS-specific features:
 * - IPC communication for analytics tracking
 * - Offline caching and fallback
 * - Terminal and staff context
 * - Real-time validation with UI feedback
 */

import { DeliveryValidationService } from '../../../shared/services/DeliveryValidationService';
import type {
  DeliveryBoundaryValidationRequest,
  DeliveryBoundaryValidationResponse,
  DeliveryOverrideRequest,
  DeliveryOverrideResponse,
  ValidationEvent
} from '../../../shared/types/delivery-validation';
import { environment } from '../config/environment';

interface ValidatorConfig {
  branchId: string;
  terminalId: string;
  staffId?: string;
  enableCaching?: boolean;
  cacheExpiryMs?: number;
  enableAnalytics?: boolean;
  authToken?: string;
  apiKey?: string;
}

interface CachedValidation {
  result: DeliveryBoundaryValidationResponse;
  timestamp: number;
}

export class DeliveryZoneValidator {
  private validationService: DeliveryValidationService;
  private config: ValidatorConfig;
  private cache: Map<string, CachedValidation> = new Map();
  private readonly CACHE_KEY = 'pos_delivery_validation_cache';
  private readonly DEFAULT_CACHE_EXPIRY = 30 * 60 * 1000; // 30 minutes

  constructor(config: ValidatorConfig) {
    this.config = {
      enableCaching: true,
      cacheExpiryMs: this.DEFAULT_CACHE_EXPIRY,
      enableAnalytics: true,
      ...config
    };

    // Initialize shared validation service using getInstance
    const apiUrl = environment.ADMIN_API_BASE_URL.replace(/\/+$/, '');
    this.validationService = DeliveryValidationService.getInstance(apiUrl, {
      enableBoundaryValidation: true,
      enableOverrides: true,
      requireManagerApprovalForOverrides: true,
      maxCustomDeliveryFee: 10.0,
      defaultOutOfBoundsMessage: 'Address is outside our delivery area',
      enableRealTimeValidation: true,
      enableGeocoding: true,
      geocodingProvider: 'google',
      cacheValidationResults: this.config.enableCaching || false,
      logAllValidationAttempts: true,
      showAlternativeZones: true,
      enableDistanceCalculation: true,
      maxDeliveryDistance: 10000,
      // Pass authentication credentials
      authToken: this.config.authToken,
      apiKey: this.config.apiKey || environment.POS_API_KEY,
      terminalId: this.config.terminalId
    });

    // Load cache from localStorage
    this.loadCacheFromStorage();
  }

  /**
   * Validate a delivery address
   * Supports both string addresses and coordinate objects
   */
  async validateAddress(
    address: string | { lat: number; lng: number },
    orderAmount?: number
  ): Promise<DeliveryBoundaryValidationResponse> {
    const startTime = Date.now();

    try {
      // Check cache first
      const cacheKey = this.getCacheKey(address);
      const cached = this.getCachedValidation(cacheKey);
      if (cached) {
        console.log('[DeliveryZoneValidator] Using cached validation result');
        return cached;
      }

      // Build validation request with correct shape
      const request: DeliveryBoundaryValidationRequest = {
        address: address, // Can be string or {lat, lng} object
        branchId: this.config.branchId,
        orderAmount
      };

      // Call shared validation service
      const result = await this.validationService.validateDeliveryAddress(request);

      // Track analytics
      const responseTimeMs = Date.now() - startTime;
      if (this.config.enableAnalytics) {
        await this.trackValidationAttempt(result, address, orderAmount, responseTimeMs);
      }

      // Cache successful results
      if (result.success || result.zone) {
        this.setCachedValidation(cacheKey, result);
      }

      return result;
    } catch (error) {
      console.error('[DeliveryZoneValidator] Validation error:', error);

      // Track error in analytics
      const responseTimeMs = Date.now() - startTime;
      if (this.config.enableAnalytics) {
        await this.trackValidationError(address, orderAmount, responseTimeMs, error);
      }

      // Try to return cached result if available
      const cacheKey = this.getCacheKey(address);
      const cached = this.getCachedValidation(cacheKey);
      if (cached) {
        console.warn('[DeliveryZoneValidator] API failed, using cached result');
        return {
          ...cached,
          message: 'Using cached validation result due to network error'
        };
      }

      // Return error response matching shared type
      return {
        success: false,
        deliveryAvailable: false,
        message: error instanceof Error ? error.message : 'Validation failed',
        reason: 'VALIDATION_SERVICE_UNAVAILABLE',
        uiState: {
          indicator: 'error',
          showOverrideOption: false,
          requiresManagerApproval: true,
          canProceed: false
        }
      };
    }
  }

  /**
   * Validate address with specific coordinates
   */
  async validateAddressWithCoordinates(
    lat: number,
    lng: number,
    orderAmount?: number
  ): Promise<DeliveryBoundaryValidationResponse> {
    return this.validateAddress({ lat, lng }, orderAmount);
  }

  /**
   * Get delivery zone information for an address
   * Returns zone details without full validation
   */
  async getZoneForAddress(
    address: string | { lat: number; lng: number }
  ): Promise<NonNullable<DeliveryBoundaryValidationResponse['zone']> | null> {
    try {
      const result = await this.validateAddress(address);
      return result.zone || null;
    } catch (error) {
      console.error('[DeliveryZoneValidator] Error getting zone:', error);
      return null;
    }
  }

  /**
   * Request override for out-of-zone delivery
   */
  async requestOverride(
    orderId: string | undefined,
    address: { lat: number; lng: number },
    reason: string,
    customFee?: number
  ): Promise<DeliveryOverrideResponse> {
    try {
      const request: DeliveryOverrideRequest = {
        orderId,
        address,
        reason,
        customDeliveryFee: customFee,
        staffId: this.config.staffId || 'unknown',
        staffRole: 'staff', // Default to staff, would need to be fetched from actual staff data
        customerConsent: true // Assumed true when staff is making the request
      };

      const response = await this.validationService.requestDeliveryOverride(request);

      // Track override request
      if (this.config.enableAnalytics && window.electronAPI) {
        try {
          await window.electronAPI.requestDeliveryOverride({
            orderId,
            address,
            reason,
            customDeliveryFee: customFee,
            staffId: this.config.staffId || 'unknown'
          });
        } catch (error) {
          console.error('[DeliveryZoneValidator] Error tracking override:', error);
        }
      }

      return response;
    } catch (error) {
      console.error('[DeliveryZoneValidator] Override request error:', error);
      return {
        success: false,
        approved: false,
        message: error instanceof Error ? error.message : 'Override request failed',
        requiresManagerApproval: true
      };
    }
  }

  /**
   * Track validation attempt to analytics
   */
  private async trackValidationAttempt(
    result: DeliveryBoundaryValidationResponse,
    address: string | { lat: number; lng: number },
    orderAmount: number | undefined,
    responseTimeMs: number
  ): Promise<void> {
    if (!window.electronAPI) {
      console.warn('[DeliveryZoneValidator] electronAPI not available for analytics');
      return;
    }

    try {
      const validationResult = result.success
        ? 'success'
        : result.reason === 'VALIDATION_SERVICE_UNAVAILABLE'
        ? 'error'
        : 'out_of_zone';

      const coordinates = typeof address === 'object'
        ? address
        : result.coordinates || undefined;

      const event: ValidationEvent = {
        zoneId: result.zone?.id,
        address: typeof address === 'string' ? address : `${address.lat},${address.lng}`,
        coordinates,
        result: validationResult,
        orderAmount,
        deliveryFee: result.zone?.deliveryFee,
        source: 'pos-system',
        terminalId: this.config.terminalId,
        staffId: this.config.staffId,
        overrideApplied: false,
        responseTimeMs,
        timestamp: new Date().toISOString()
      };

      await window.electronAPI.trackDeliveryValidation(event);
    } catch (error) {
      console.error('[DeliveryZoneValidator] Error tracking validation:', error);
    }
  }

  /**
   * Track validation error to analytics
   */
  private async trackValidationError(
    address: string | { lat: number; lng: number },
    orderAmount: number | undefined,
    responseTimeMs: number,
    error: unknown
  ): Promise<void> {
    if (!window.electronAPI) return;

    try {
      const event: ValidationEvent = {
        address: typeof address === 'string' ? address : `${address.lat},${address.lng}`,
        coordinates: typeof address === 'object' ? address : undefined,
        result: 'error',
        orderAmount,
        source: 'pos-system',
        terminalId: this.config.terminalId,
        staffId: this.config.staffId,
        overrideApplied: false,
        responseTimeMs,
        timestamp: new Date().toISOString()
      };

      await window.electronAPI.trackDeliveryValidation(event);
    } catch (err) {
      console.error('[DeliveryZoneValidator] Error tracking validation error:', err);
    }
  }

  /**
   * Get cached validation result
   */
  getCachedValidation(key: string): DeliveryBoundaryValidationResponse | null {
    if (!this.config.enableCaching) return null;

    const cached = this.cache.get(key);
    if (!cached) return null;

    // Check if cache is expired
    const now = Date.now();
    const expiryMs = this.config.cacheExpiryMs || this.DEFAULT_CACHE_EXPIRY;
    if (now - cached.timestamp > expiryMs) {
      this.cache.delete(key);
      this.saveCacheToStorage();
      return null;
    }

    return cached.result;
  }

  /**
   * Set cached validation result
   */
  private setCachedValidation(key: string, result: DeliveryBoundaryValidationResponse): void {
    if (!this.config.enableCaching) return;

    this.cache.set(key, {
      result,
      timestamp: Date.now()
    });

    this.saveCacheToStorage();
  }

  /**
   * Generate cache key for address
   */
  private getCacheKey(address: string | { lat: number; lng: number }): string {
    if (typeof address === 'string') {
      return `address:${address.toLowerCase().trim()}`;
    }
    return `coords:${address.lat.toFixed(6)},${address.lng.toFixed(6)}`;
  }

  /**
   * Load cache from localStorage
   */
  private loadCacheFromStorage(): void {
    try {
      const stored = localStorage.getItem(this.CACHE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.cache = new Map(Object.entries(parsed));
      }
    } catch (error) {
      console.error('[DeliveryZoneValidator] Error loading cache:', error);
      this.cache = new Map();
    }
  }

  /**
   * Save cache to localStorage
   */
  private saveCacheToStorage(): void {
    try {
      const cacheObject = Object.fromEntries(this.cache.entries());
      localStorage.setItem(this.CACHE_KEY, JSON.stringify(cacheObject));
    } catch (error) {
      console.error('[DeliveryZoneValidator] Error saving cache:', error);
    }
  }

  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.cache.clear();
    localStorage.removeItem(this.CACHE_KEY);
  }

  /**
   * Update authentication credentials at runtime
   * Call this when auth token becomes available or changes
   */
  updateAuth(authToken?: string, apiKey?: string): void {
    if (authToken !== undefined) {
      this.config.authToken = authToken;
    }
    if (apiKey !== undefined) {
      this.config.apiKey = apiKey;
    }
    // Update the underlying service
    this.validationService.updateAuth(authToken, apiKey);
  }
}

/**
 * DeliveryValidationService (POS-local stub)
 */

import type {
  DeliveryBoundaryValidationRequest,
  DeliveryBoundaryValidationResponse,
  DeliveryOverrideRequest,
  DeliveryOverrideResponse,
} from '../types/delivery-validation';

export interface DeliveryValidationConfig {
  enableBoundaryValidation?: boolean;
  enableOverrides?: boolean;
  requireManagerApprovalForOverrides?: boolean;
  maxCustomDeliveryFee?: number;
  defaultOutOfBoundsMessage?: string;
  enableRealTimeValidation?: boolean;
  enableGeocoding?: boolean;
  geocodingProvider?: string;
  cacheValidationResults?: boolean;
  logAllValidationAttempts?: boolean;
  showAlternativeZones?: boolean;
  enableDistanceCalculation?: boolean;
  maxDeliveryDistance?: number;
  authToken?: string;
  apiKey?: string;
  terminalId?: string;
}

export class DeliveryValidationService {
  private static instance: DeliveryValidationService | null = null;
  private apiUrl: string;
  private config: DeliveryValidationConfig;

  private constructor(apiUrl: string, config: DeliveryValidationConfig = {}) {
    this.apiUrl = apiUrl;
    this.config = config;
  }

  static getInstance(apiUrl: string, config: DeliveryValidationConfig = {}): DeliveryValidationService {
    if (!DeliveryValidationService.instance) {
      DeliveryValidationService.instance = new DeliveryValidationService(apiUrl, config);
    }
    return DeliveryValidationService.instance;
  }

  async validateDeliveryBoundary(
    request: DeliveryBoundaryValidationRequest
  ): Promise<DeliveryBoundaryValidationResponse> {
    // Stub implementation - always returns valid for now
    return {
      isValid: true,
      success: true,
      deliveryAvailable: true,
      message: 'Delivery validation service stub - always valid',
    };
  }

  /**
   * Validate delivery address (alias for validateDeliveryBoundary)
   */
  async validateDeliveryAddress(
    request: DeliveryBoundaryValidationRequest
  ): Promise<DeliveryBoundaryValidationResponse> {
    return this.validateDeliveryBoundary(request);
  }

  async requestOverride(
    request: DeliveryOverrideRequest
  ): Promise<DeliveryOverrideResponse> {
    return {
      success: true,
      approved: true,
      message: 'Override request stub',
    };
  }

  /**
   * Request delivery override (alias for requestOverride)
   */
  async requestDeliveryOverride(
    request: DeliveryOverrideRequest
  ): Promise<DeliveryOverrideResponse> {
    return this.requestOverride(request);
  }

  /**
   * Update authentication credentials at runtime
   */
  updateAuth(authToken?: string, apiKey?: string): void {
    if (authToken !== undefined) {
      this.config.authToken = authToken;
    }
    if (apiKey !== undefined) {
      this.config.apiKey = apiKey;
    }
  }
}

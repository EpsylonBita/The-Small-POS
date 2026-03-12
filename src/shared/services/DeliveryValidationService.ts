import type {
  DeliveryBoundaryValidationRequest,
  DeliveryBoundaryValidationResponse,
  DeliveryOverrideRequest,
  DeliveryOverrideResponse,
} from '../types/delivery-validation';
import { getBridge } from '../../lib';

type LatLng = { lat: number; lng: number };

interface CachedValidationResult {
  expiresAt: number;
  result: DeliveryBoundaryValidationResponse;
}

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

const CACHE_TTL_MS = 5 * 60 * 1000;

export class DeliveryValidationService {
  private static instance: DeliveryValidationService | null = null;

  private apiUrl: string;
  private config: DeliveryValidationConfig;
  private readonly cache = new Map<string, CachedValidationResult>();

  private constructor(apiUrl: string, config: DeliveryValidationConfig = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.config = config;
  }

  static getInstance(apiUrl: string, config: DeliveryValidationConfig = {}): DeliveryValidationService {
    if (!DeliveryValidationService.instance) {
      DeliveryValidationService.instance = new DeliveryValidationService(apiUrl, config);
    } else {
      DeliveryValidationService.instance.apiUrl = apiUrl.replace(/\/+$/, '');
      DeliveryValidationService.instance.config = {
        ...DeliveryValidationService.instance.config,
        ...config,
      };
    }

    return DeliveryValidationService.instance;
  }

  async validateDeliveryBoundary(
    request: DeliveryBoundaryValidationRequest
  ): Promise<DeliveryBoundaryValidationResponse> {
    try {
      const preparedRequest = this.prepareRequest(request);
      const cacheKey = this.getCacheKey(preparedRequest);

      if (cacheKey) {
        const cached = this.getCachedResult(cacheKey);
        if (cached) {
          return cached;
        }
      }

      if (preparedRequest.skipValidation && preparedRequest.staffId) {
        return this.handleValidationOverride(preparedRequest);
      }

      const result = await this.performBoundaryValidation(preparedRequest);

      if (cacheKey && result.success !== false) {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          result,
        });
      }

      return result;
    } catch (error) {
      console.error('[DeliveryValidationService] Validation error:', error);
      return this.createErrorResponse(
        'VALIDATION_SERVICE_UNAVAILABLE',
        error instanceof Error ? error.message : 'Validation service is temporarily unavailable'
      );
    }
  }

  async validateDeliveryAddress(
    request: DeliveryBoundaryValidationRequest
  ): Promise<DeliveryBoundaryValidationResponse> {
    return this.validateDeliveryBoundary(request);
  }

  async requestOverride(
    request: DeliveryOverrideRequest
  ): Promise<DeliveryOverrideResponse> {
    if (
      request.customDeliveryFee != null &&
      this.config.maxCustomDeliveryFee != null &&
      request.customDeliveryFee > this.config.maxCustomDeliveryFee
    ) {
      return {
        success: false,
        approved: false,
        message: `Custom delivery fee cannot exceed ${this.config.maxCustomDeliveryFee} EUR`,
      };
    }

    return {
      success: true,
      approved: true,
      message: 'Override recorded locally',
    };
  }

  async requestDeliveryOverride(
    request: DeliveryOverrideRequest
  ): Promise<DeliveryOverrideResponse> {
    return this.requestOverride(request);
  }

  updateAuth(authToken?: string, apiKey?: string): void {
    if (authToken !== undefined) {
      this.config.authToken = authToken;
    }
    if (apiKey !== undefined) {
      this.config.apiKey = apiKey;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private prepareRequest(
    request: DeliveryBoundaryValidationRequest
  ): DeliveryBoundaryValidationRequest & { coordinates?: LatLng } {
    const coordinates = this.extractCoordinates(request);

    return {
      ...request,
      address: coordinates ?? request.address,
      coordinates,
    };
  }

  private extractCoordinates(request: DeliveryBoundaryValidationRequest): LatLng | undefined {
    if (this.isLatLng(request.address)) {
      return request.address;
    }

    const extraCoordinates = (request as any).coordinates;
    if (this.isLatLng(extraCoordinates)) {
      return extraCoordinates;
    }

    const latitude = Number((request as any).latitude);
    const longitude = Number((request as any).longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { lat: latitude, lng: longitude };
    }

    return undefined;
  }

  private getBridge() {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      return getBridge();
    } catch {
      return null;
    }
  }

  private toAdminApiPath(endpoint: string): string {
    const trimmed = endpoint.trim();
    if (!trimmed) {
      return '/api';
    }

    let relative = trimmed;
    if (relative.startsWith(this.apiUrl)) {
      relative = relative.slice(this.apiUrl.length);
    }

    if (!relative.startsWith('/')) {
      relative = `/${relative}`;
    }

    return relative.startsWith('/api/') ? relative : `/api${relative}`;
  }

  private async performBoundaryValidation(
    request: DeliveryBoundaryValidationRequest & { coordinates?: LatLng }
  ): Promise<DeliveryBoundaryValidationResponse> {
    const endpoint = this.config.apiKey
      ? `${this.apiUrl}/pos/delivery-zones/validate`
      : `${this.apiUrl}/delivery-zones/validate`;
    const requestBody = {
      ...request,
      coordinates: request.coordinates,
    };
    const bridge = this.getBridge();

    if (bridge) {
      const ipcResult = await bridge.adminApi.fetchFromAdmin(this.toAdminApiPath(endpoint), {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      if (!ipcResult?.success) {
        throw new Error(String(ipcResult?.error || 'Delivery validation failed'));
      }

      return this.enhanceValidationResponse(ipcResult?.data ?? ipcResult, request);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
    });

    const data = await this.parseResponse(response);

    if (!response.ok) {
      throw new Error(
        String(data?.error || data?.message || `HTTP error ${response.status}`)
      );
    }

    return this.enhanceValidationResponse(data, request);
  }

  private async parseResponse(response: Response): Promise<any> {
    const text = await response.text();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(text.slice(0, 200));
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }

    if (this.config.apiKey) {
      headers['x-pos-api-key'] = this.config.apiKey;
    }

    if (this.config.terminalId) {
      headers['x-terminal-id'] = this.config.terminalId;
    }

    return headers;
  }

  private enhanceValidationResponse(
    apiResponse: any,
    request: DeliveryBoundaryValidationRequest & { coordinates?: LatLng }
  ): DeliveryBoundaryValidationResponse {
    const selectedZone = apiResponse?.selectedZone;
    const validationStatus = String(apiResponse?.validation_status || '');
    const isValid = apiResponse?.isValid === true || validationStatus === 'in_zone';
    const success = apiResponse?.success !== false;
    const deliveryAvailable = apiResponse?.deliveryAvailable ?? isValid;

    const zone = selectedZone
      ? {
          id: selectedZone.id,
          name: selectedZone.name,
          deliveryFee: selectedZone.delivery_fee ?? selectedZone.deliveryFee ?? 0,
          minimumOrderAmount:
            selectedZone.minimum_order_amount ?? selectedZone.minimumOrderAmount ?? 0,
          estimatedTime: {
            min:
              selectedZone.estimated_delivery_time_min ??
              selectedZone.estimatedTime?.min ??
              20,
            max:
              selectedZone.estimated_delivery_time_max ??
              selectedZone.estimatedTime?.max ??
              35,
          },
          color: selectedZone.color ?? selectedZone.color_code,
          priority: selectedZone.priority,
        }
      : undefined;

    const orderAmount = Number(request.orderAmount ?? 0);
    const deliveryFee = zone?.deliveryFee ?? 0;
    const meetsMinimumOrder = apiResponse?.meetsMinimumOrder ?? apiResponse?.validation?.meetsMinimumOrder;
    const shortfall = apiResponse?.shortfall ?? apiResponse?.validation?.shortfall ?? 0;

    const coordinates =
      this.isLatLng(apiResponse?.coordinates)
        ? apiResponse.coordinates
        : request.coordinates;

    return {
      ...apiResponse,
      success,
      isValid,
      deliveryAvailable,
      selectedZone,
      zone,
      coordinates,
      message: apiResponse?.message ?? apiResponse?.reason,
      reason: apiResponse?.reason,
      validation: zone
        ? {
            meetsMinimumOrder: meetsMinimumOrder ?? orderAmount >= (zone.minimumOrderAmount ?? 0),
            orderAmount,
            estimatedTotal: orderAmount + deliveryFee,
            shortfall,
            isInBounds: isValid,
            distanceFromBoundary: apiResponse?.validation?.distanceFromBoundary,
          }
        : apiResponse?.validation,
      uiState: {
        ...apiResponse?.uiState,
        indicator: this.resolveIndicator(apiResponse, isValid),
        showOverrideOption:
          apiResponse?.uiState?.showOverrideOption ??
          apiResponse?.requires_override ??
          (!isValid && this.config.enableOverrides === true),
        requiresManagerApproval:
          apiResponse?.uiState?.requiresManagerApproval ??
          this.config.requireManagerApprovalForOverrides ??
          true,
        canProceed:
          apiResponse?.uiState?.canProceed ??
          (
            isValid ||
            apiResponse?.override?.applied === true ||
            (apiResponse?.requires_override === true && this.config.enableOverrides === true)
          ),
      },
    };
  }

  private resolveIndicator(
    apiResponse: any,
    isValid: boolean
  ): 'success' | 'warning' | 'error' | 'info' {
    const explicitIndicator = apiResponse?.uiState?.indicator;
    if (
      explicitIndicator === 'success' ||
      explicitIndicator === 'warning' ||
      explicitIndicator === 'error' ||
      explicitIndicator === 'info'
    ) {
      return explicitIndicator;
    }

    if (apiResponse?.override?.applied === true) {
      return 'warning';
    }

    if (apiResponse?.validation_status === 'requires_selection') {
      return 'info';
    }

    if (apiResponse?.requires_override === true) {
      return 'warning';
    }

    return isValid ? 'success' : 'error';
  }

  private handleValidationOverride(
    request: DeliveryBoundaryValidationRequest & { coordinates?: LatLng }
  ): DeliveryBoundaryValidationResponse {
    return {
      success: true,
      isValid: true,
      deliveryAvailable: true,
      coordinates: request.coordinates,
      reason: 'OVERRIDE_APPLIED',
      message: 'Delivery validation bypassed by staff override.',
      override: {
        applied: true,
        reason: (request as any).overrideReason,
        staffId: (request as any).staffId,
        managerApproval: (request as any).managerApproval,
        customDeliveryFee: (request as any).customDeliveryFee,
        timestamp: new Date().toISOString(),
      },
      uiState: {
        indicator: 'warning',
        showOverrideOption: false,
        requiresManagerApproval: false,
        canProceed: true,
      },
    };
  }

  private createErrorResponse(
    code: string,
    message: string
  ): DeliveryBoundaryValidationResponse {
    return {
      isValid: false,
      success: false,
      deliveryAvailable: false,
      reason: code,
      message,
      uiState: {
        indicator: 'error',
        showOverrideOption: this.config.enableOverrides === true,
        requiresManagerApproval: this.config.requireManagerApprovalForOverrides ?? true,
        canProceed: false,
      },
    };
  }

  private getCacheKey(
    request: DeliveryBoundaryValidationRequest & { coordinates?: LatLng }
  ): string | null {
    if (!this.config.cacheValidationResults) {
      return null;
    }

    const coordinates = request.coordinates;
    const addressKey = coordinates
      ? `${coordinates.lat.toFixed(6)},${coordinates.lng.toFixed(6)}`
      : String(request.address || '').trim().toLowerCase();

    if (!addressKey) {
      return null;
    }

    return `${request.branchId || 'default'}|${addressKey}|${Number(request.orderAmount ?? 0).toFixed(2)}`;
  }

  private getCachedResult(cacheKey: string): DeliveryBoundaryValidationResponse | null {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  private isLatLng(value: unknown): value is LatLng {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const record = value as Record<string, unknown>;
    return Number.isFinite(Number(record.lat)) && Number.isFinite(Number(record.lng));
  }
}

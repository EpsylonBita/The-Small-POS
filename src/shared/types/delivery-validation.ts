/**
 * Delivery Validation Types (POS-local stub)
 * Using flexible types to avoid build errors
 */

export interface DeliveryBoundaryValidationRequest {
  latitude?: number;
  longitude?: number;
  address?: string | { lat: number; lng: number };
  branchId?: string;
  organizationId?: string;
  orderAmount?: number;
  [key: string]: any;
}

export interface DeliveryBoundaryValidationResponse {
  isValid: boolean;
  success?: boolean;
  deliveryAvailable?: boolean;
  zoneId?: string;
  zoneName?: string;
  deliveryFee?: number;
  estimatedTime?: number;
  message?: string;
  distance?: number;
  zone?: any;
  uiState?: any;
  coordinates?: { lat: number; lng: number };
  validation?: any;
  override?: any;
  reason?: string;
  [key: string]: any;
}

export interface DeliveryOverrideRequest {
  validationId?: string;
  reason: string;
  staffId: string;
  staffRole?: string;
  customerConsent?: boolean;
  overrideType?: 'zone' | 'fee' | 'time';
  orderId?: string;
  address?: { lat: number; lng: number };
  customDeliveryFee?: number;
  [key: string]: any;
}

export interface DeliveryOverrideResponse {
  success: boolean;
  approved?: boolean;
  overrideId?: string;
  message?: string;
  requiresManagerApproval?: boolean;
  [key: string]: any;
}

export interface ValidationEvent {
  type?: 'validation' | 'override';
  timestamp: string;
  data?: any;
  zoneId?: string;
  address?: string;
  coordinates?: { lat: number; lng: number };
  result?: string;
  orderAmount?: number;
  deliveryFee?: number;
  source?: string;
  terminalId?: string;
  staffId?: string;
  overrideApplied?: boolean;
  responseTimeMs?: number;
  [key: string]: any;
}

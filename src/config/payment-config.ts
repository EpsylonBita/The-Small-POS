// Payment configuration for POS system
import { environment } from './environment';

export interface TestCard {
  success: boolean;
  name?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PaymentConfig {
  mode: 'test' | 'production';
  testCardsEnabled: boolean;
  testCards: Record<string, TestCard>;
  processingDelay: number;
  gateway: {
    apiKey?: string;
    apiSecret?: string;
    merchantId?: string;
    endpoint?: string;
  };
}

// Test card numbers for development/testing
export const getTestCards = (): Record<string, TestCard> => {
  if (!environment.PAYMENT_TEST_CARDS_ENABLED) {
    return {};
  }

  return {
    '4111111111111111': { 
      success: true, 
      name: 'Success Card' 
    },
    '4000000000000002': { 
      success: false, 
      errorCode: 'INSUFFICIENT_FUNDS', 
      errorMessage: 'Insufficient funds' 
    },
    '4000000000000119': { 
      success: false, 
      errorCode: 'PROCESSING_ERROR', 
      errorMessage: 'Processing error' 
    },
    '4000000000000127': { 
      success: false, 
      errorCode: 'INVALID_CVC', 
      errorMessage: 'Invalid security code' 
    },
    '4000000000000069': { 
      success: false, 
      errorCode: 'EXPIRED_CARD', 
      errorMessage: 'Card has expired' 
    }
  };
};

// Payment configuration
export const paymentConfig: PaymentConfig = {
  mode: environment.PAYMENT_MODE,
  testCardsEnabled: environment.PAYMENT_TEST_CARDS_ENABLED,
  testCards: getTestCards(),
  processingDelay: environment.NODE_ENV === 'development' ? 100 : 500, // Minimal delay for UX feedback
  gateway: {
    // Production gateway configuration would go here
    apiKey: process.env.PAYMENT_GATEWAY_API_KEY,
    apiSecret: process.env.PAYMENT_GATEWAY_API_SECRET,
    merchantId: process.env.PAYMENT_GATEWAY_MERCHANT_ID,
    endpoint: process.env.PAYMENT_GATEWAY_ENDPOINT || 'https://localhost:8443/api/v1'
  }
};

// Utility functions
export const isTestMode = () => paymentConfig.mode === 'test';
export const isProductionMode = () => paymentConfig.mode === 'production';
export const areTestCardsEnabled = () => paymentConfig.testCardsEnabled;

// Get payment processing delay
export const getProcessingDelay = () => paymentConfig.processingDelay;

// Validate payment configuration
export const validatePaymentConfig = (): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (isProductionMode()) {
    if (!paymentConfig.gateway.apiKey) {
      errors.push('Payment gateway API key is required for production mode');
    }
    if (!paymentConfig.gateway.merchantId) {
      errors.push('Payment gateway merchant ID is required for production mode');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

// Export configuration for debugging
if (environment.DEBUG_LOGGING) {
  // Payment configuration logging removed
}
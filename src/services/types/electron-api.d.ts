// Minimal global Window typings for Electron preload API used in services
// This keeps renderer type-checking happy without importing from preload.

export {};

declare global {
  interface Window {
    electronAPI?: {
      // Used by DeliveryZoneValidator
      requestDeliveryOverride: (data: {
        orderId?: string;
        address: { lat: number; lng: number };
        reason: string;
        customDeliveryFee?: number;
        staffId: string;
      }) => Promise<any>;
      trackDeliveryValidation: (data: any) => Promise<any>;
    };
  }
}


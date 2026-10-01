/**
 * Public new-offer display returned by GET /api/modules/launch-catalog.
 * It contains no organization ownership or permission to charge.
 * Amounts are major units in the returned catalog currency.
 */
export interface PublicLaunchCatalogDTO {
  version: string | null;
  currency: string | null;
  available: boolean;
  reason: string | null;
  base: null | {
    id: string;
    planName: string;
    displayName: string;
    monthly: number;
    annual: number;
    includedModuleIds: readonly string[];
    builtInScreens: readonly string[];
    includedResources: { branches: number; posTerminals: number };
    staffLimit: number | null;
    action: 'checkout';
  };
  modules: readonly {
    module_id: string;
    display_name: string;
    description: string;
    icon: string | null;
    monthly: number;
    annual: number;
    includes: readonly string[];
    included_in: readonly string[];
    required_module_ids: readonly string[];
    action: 'checkout' | 'included';
    release: { available: true };
    hardwareIncluded: false;
  }[];
}

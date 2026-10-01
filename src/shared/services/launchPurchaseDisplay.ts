import type { PublicLaunchCatalogDTO } from '../types/launchCatalog'

/** Public offer display only. The browser must obtain a fresh authorized quote. */
export interface LaunchPurchaseDisplay {
  name: string
  currency: string
  monthly: number
  annual: number
  includes: readonly string[]
  includedIn: readonly string[]
  resources: { branches: number; posTerminals: number } | null
  staffLimit: number | null | undefined
}

const validPrice = (amount: unknown): amount is number =>
  typeof amount === 'number' && Number.isFinite(amount) && amount > 0

export function launchPurchaseDisplay(
  catalog: PublicLaunchCatalogDTO | null | undefined,
  feature: string,
): LaunchPurchaseDisplay | null {
  if (!feature || feature === 'ai_assistant' || feature === 'plugin_integrations' ||
      catalog?.available !== true || !catalog.currency || !/^[A-Z]{3}$/.test(catalog.currency) ||
      !Array.isArray(catalog.modules)) return null
  const base = catalog.base
  if (base?.builtInScreens?.includes(feature)) return null
  const displayName = (id: string) => catalog.modules.find(row => row.module_id === id)?.display_name || id
  if (base?.includedModuleIds?.includes(feature)) {
    if (!validPrice(base.monthly) || !validPrice(base.annual) || !base.displayName) return null
    return {
      name: base.displayName, currency: catalog.currency, monthly: base.monthly, annual: base.annual,
      includes: base.includedModuleIds.map(displayName), includedIn: [],
      resources: base.includedResources, staffLimit: base.staffLimit,
    }
  }
  const row = catalog.modules.find(module => module.module_id === feature)
  if (!row || row.release?.available !== true) return null
  // An included-only child must name one unambiguous purchasable owner.
  const offer = row.action === 'checkout' ? row : row.included_in?.length === 1
    ? catalog.modules.find(module => module.module_id === row.included_in[0] && module.action === 'checkout')
    : null
  if (!offer || offer.release?.available !== true || !validPrice(offer.monthly) ||
      !validPrice(offer.annual) || !offer.display_name || !Array.isArray(offer.includes)) return null
  return {
    name: offer.display_name, currency: catalog.currency, monthly: offer.monthly, annual: offer.annual,
    includes: offer.includes.map(displayName), includedIn: (row.included_in || []).map(displayName),
    resources: null, staffLimit: undefined,
  }
}

export function launchPriceText(offer: LaunchPurchaseDisplay, cycle: 'monthly' | 'annual', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency }).format(offer[cycle])
}

export function isPurchaseOrganizationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

import type { GreeceOrderVatSettings } from '../../../../shared/services/GreeceOrderVat';

/**
 * The branch VAT profile this till holds (founder, 21/10/2026): the `tax.*`
 * terminal settings the server feed fills from the branch's VAT profile. The
 * native VAT mirror (`fiscal::greece_vat::branch_vat_settings`) reads the same
 * keys, so a renderer preview and the order's stored VAT agree.
 */

export type TerminalSettingReader = <T = unknown>(category: string, key: string, defaultValue?: T) => T | undefined;

/** A boolean terminal setting as the feed stores it (`true`/`false`, or text); null when unset or unreadable. */
export function settingBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

const settingText = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() ? raw.trim() : null;

/**
 * `tax.vat_default_category_code`, `tax.vat_region_profile`, `tax.vat_country`
 * (any store country, Greece when unset) and `tax.vat_registered` (registered when unset).
 */
export function readBranchVatSettings(getSetting: TerminalSettingReader): GreeceOrderVatSettings {
  const jsonObject = (key: string): Record<string, any> => {
    const raw = getSetting<unknown>('tax', key);
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  return {
    channelDefaults: {
      dine_in: settingText(getSetting('tax', 'vat_channel_default_dine_in')),
      takeaway: settingText(getSetting('tax', 'vat_channel_default_takeaway')),
      own_delivery: settingText(getSetting('tax', 'vat_channel_default_delivery')),
      platform: settingText(getSetting('tax', 'vat_channel_default_platform')),
    },
    classCategoryCodes: jsonObject('vat_class_category_codes'),
    platformVatOptIn: jsonObject('vat_platform_opt_in'),
    chargesVatMode: settingText(getSetting('tax', 'vat_charges_mode')),
    deliveryFeeVatCategoryCode: settingText(getSetting('tax', 'vat_delivery_fee_category_code')),
    tipsOutsideVat: settingBoolean(getSetting('tax', 'vat_tips_outside_vat')),
    defaultVatCategoryCode: settingText(getSetting<unknown>('tax', 'vat_default_category_code')),
    vatRegionProfile: settingText(getSetting<unknown>('tax', 'vat_region_profile')),
    country: settingText(getSetting<unknown>('tax', 'vat_country')),
    vatRegistered: settingBoolean(getSetting<unknown>('tax', 'vat_registered')),
  };
}

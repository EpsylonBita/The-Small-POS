import { VAT_PROFILE_PRESETS_BY_COUNTRY, orderVatSettingsFromPreset } from '../../../../../shared/services/vat-country-presets';
import { describe, expect, it } from 'vitest';
import { calculateGreeceOrderVat } from '../../../../../shared/services/GreeceOrderVat';
import { previewOrderVat, readPrintedVatAmount, readSlipsPrintVat } from '../printedVat';
import { readBranchVatSettings, settingBoolean } from '../branchVatSettings';

const reader = (values: Record<string, unknown>) =>
  (<T = unknown>(category: string, key: string, defaultValue?: T): T | undefined => {
    const value = values[`${category}.${key}`];
    return (value === undefined ? defaultValue : value) as T | undefined;
  });

describe('the VAT a screen shows (founder rule 21/10/2026: one VAT per order)', () => {
  it('shows the native printed VAT and never the stored canonical VAT', () => {
    // Tomikro: the order stores 2.52 of VAT, the switch is off, the slip prints none.
    expect(readPrintedVatAmount({ taxAmount: 2.52, tax_amount: 2.52, printedVatAmount: null })).toBe(0);
    // An order object from a reader that does not resolve the rule shows none.
    expect(readPrintedVatAmount({ taxAmount: 2.52 })).toBe(0);
    expect(readPrintedVatAmount({ printedVatAmount: 2.52 })).toBe(2.52);
    expect(readPrintedVatAmount({ printed_vat_amount: '4.44' })).toBe(4.44);
    expect(readPrintedVatAmount({ printedVatAmount: 0 })).toBe(0);
    expect(readPrintedVatAmount(null)).toBe(0);
  });

  it('prints by the «VAT on receipts» switch, and by the owner rate only while the switch is missing', () => {
    expect(readSlipsPrintVat(reader({}))).toBe(false);
    expect(readSlipsPrintVat(reader({ 'tax.vat_print_on_receipt': false }), true)).toBe(true);
    expect(readSlipsPrintVat(reader({ 'tax.default_tax_rate': '0' }))).toBe(false);
    expect(readSlipsPrintVat(reader({ 'tax.default_tax_rate': 24 }))).toBe(true);
    expect(readSlipsPrintVat(reader({ 'tax.tax_rate_percentage': 24, 'general.tax_rate': 24 }))).toBe(false);
    expect(readSlipsPrintVat(reader({ 'tax.vat_print_on_receipt': 'false', 'tax.default_tax_rate': 24 }))).toBe(false);
    expect(readSlipsPrintVat(reader({ 'tax.vat_print_on_receipt': true }))).toBe(true);
    expect(readSlipsPrintVat(reader({ 'tax.vat_print_on_receipt': 'true', 'tax.default_tax_rate': 0 }))).toBe(true);
  });

  it('reads the branch VAT profile the feed stores', () => {
    expect(readBranchVatSettings(reader({}))).toMatchObject({
      defaultVatCategoryCode: null, vatRegionProfile: null, country: null, vatRegistered: null,
    });
    expect(readBranchVatSettings(reader({
      'tax.vat_default_category_code': ' ch_reduced_26 ', 'tax.vat_region_profile': 'mainland',
      'tax.vat_country': 'CH', 'tax.vat_registered': 'false',
    }))).toMatchObject({
      defaultVatCategoryCode: 'ch_reduced_26', vatRegionProfile: 'mainland', country: 'CH', vatRegistered: false,
    });
    expect([true, 'TRUE', '1', false, 'false', '0', 'maybe', null, 3].map(settingBoolean))
      .toEqual([true, true, true, false, false, false, null, null, null]);
  });

  it('maps every v3 setting and tolerates malformed JSON', () => {
    const profile = readBranchVatSettings(reader({
      'tax.vat_country': 'CH',
      'tax.vat_channel_default_dine_in': 'ch_standard_81',
      'tax.vat_channel_default_takeaway': 'ch_reduced_26',
      'tax.vat_channel_default_delivery': 'ch_reduced_26',
      'tax.vat_channel_default_platform': 'ch_exempt_platform',
      'tax.vat_class_category_codes': '{"food":{"delivery":"ch_reduced_26"}}',
      'tax.vat_platform_opt_in': '{"wolt":true}',
      'tax.vat_charges_mode': 'follow_lines',
      'tax.vat_delivery_fee_category_code': 'ch_standard_81',
      'tax.vat_tips_outside_vat': 'false',
    }));
    expect(profile).toMatchObject({country:'CH', channelDefaults:{dine_in:'ch_standard_81',takeaway:'ch_reduced_26',own_delivery:'ch_reduced_26',platform:'ch_exempt_platform'},
      classCategoryCodes:{food:{delivery:'ch_reduced_26'}},platformVatOptIn:{wolt:true},chargesVatMode:'follow_lines',deliveryFeeVatCategoryCode:'ch_standard_81',tipsOutsideVat:false});
    expect(readBranchVatSettings(reader({'tax.vat_class_category_codes':'broken','tax.vat_platform_opt_in':'[]'}))).toMatchObject({classCategoryCodes:{},platformVatOptIn:{}});
    expect(readSlipsPrintVat(reader({'tax.vat_registered':'false','tax.vat_print_on_receipt':true}),true)).toBe(false);
  });

  it('preserves the inclusive price sum under GR and CH presets on every channel', () => {
    for (const preset of Object.values(VAT_PROFILE_PRESETS_BY_COUNTRY)) {
      if (!preset) continue;
      for (const [orderType, platform] of [['dine-in',null],['pickup',null],['delivery',null],['delivery','wolt']] as const) {
        const input = {...orderVatSettingsFromPreset(preset),orderType,platform,
          items:[{quantity:2,unitPrice:6.5,vatClass:'food'},{quantity:1,unitPrice:3,vatClass:'non_alcoholic_drink'}],deliveryFee:1.8,serviceFee:0.5,tipAmount:1};
        expect(previewOrderVat(input)).toBeGreaterThanOrEqual(0);
        // Read the shared calculator's actual charged gross as well as the preview.
        expect(calculateGreeceOrderVat(input).breakdown.totalGrossAmount).toBe(19.3);
      }
    }
  });

  it('previews the VAT the server will store, never a VAT at the owner rate', () => {
    const items = [{ menuItemId: 'crepe', quantity: 2, unitPrice: 6.5 }];
    expect(previewOrderVat({ items })).toBe(2.52);
    expect(previewOrderVat({ items, deliveryFee: 1.8 })).toBe(2.73);
    expect(previewOrderVat({ items, country: 'CH' })).toBe(0.97);
    expect(previewOrderVat({ items, vatRegistered: false })).toBe(0);
  });
});

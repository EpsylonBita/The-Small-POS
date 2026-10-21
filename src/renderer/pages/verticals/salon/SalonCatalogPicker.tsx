import { resolveMenuItemPrice } from '../../../utils/order-type-pricing';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useServices } from '../../../hooks/useServices';
import { useProductCatalog } from '../../../hooks/useProductCatalog';
import { useAcquiredModules } from '../../../hooks/useAcquiredModules';
import { formatCurrency } from '../../../utils/format';
import { serviceGrossPrice, serviceSaleLine, serviceVatDefaults } from './salon-sale';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';
import { variantBlocked, variantProduct } from '../../../utils/retail-sale';

/** Uses the normal cart and checkout journal; duration never changes the price. */
export function SalonCatalogPicker({ branchId, organizationId, search, menuItems, onAdd }: {
  branchId: string; organizationId: string; search: string; menuItems: any[]; onAdd: (line: any) => void;
}) {
  const { t } = useTranslation();
  const { getSetting } = useTerminalSettings();
  const setting = getSetting<unknown>('retail', 'block_overselling', false);
  const vatDefaults = serviceVatDefaults(getSetting);
  const blockOverselling = [true, 'true', 1, '1'].includes(setting as string | boolean | number);
  const { hasModule } = useAcquiredModules();
  const { services, isLoading } = useServices({ branchId, organizationId, enableRealtime: false });
  const retail = hasModule('product_catalog');
  const { products } = useProductCatalog({ branchId, organizationId: retail ? organizationId : '', enableRealtime: false });
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const catalog = [
    ...services.filter(s => s.isActive).map(s => ({ key: `service:${s.id}`, disabled: false, name: s.name, price: serviceGrossPrice(s, s.price, vatDefaults), line: () => serviceSaleLine(s, undefined, undefined, vatDefaults) })),
    ...products.filter(p => retail && p.isActive && !p.soldByMeasure && !p.depositAmount && !p.ageRestriction).flatMap(p => {
      // A variant product always requires an explicit active choice.
      const choices = p.variants?.length ? p.variants.filter(v => v.isActive).map(v => v.id) : [null];
      return choices.map(id => {
        const product = variantProduct(p, id);
        return { key: `retail:${p.id}:${id || ''}`, disabled: Boolean(id && variantBlocked(p.variants!.find(v => v.id === id)!, blockOverselling)), name: product.name, price: product.price,
          line: () => ({ id: crypto.randomUUID(), menuItemId: p.id, menu_item_id: p.id,
            retail_product_id: p.id, retail_variant_id: id, name: product.name,
            quantity: 1, price: product.price, unitPrice: product.price, basePrice: product.price, totalPrice: product.price,
            originalUnitPrice: product.price, customizations: [], vat_category_code: p.vatCategoryCode,
            price_includes_vat: p.priceIncludesVat, tax_exemption_reason: p.taxExemptionReason }),
        };
      });
    }),
    ...menuItems.filter(p => p.is_active !== false && p.isActive !== false).map(p => {
      const price = resolveMenuItemPrice(p, 'pickup');
      return { key: `menu:${p.id}`, disabled: false, name: p.name, price, line: () => ({ ...p, id: crypto.randomUUID(),
        menuItemId: p.id, menu_item_id: p.id, quantity: 1, price, unitPrice: price, basePrice: price, totalPrice: price, customizations: [] }) };
    }),
  ].filter(p => matches(p.name));
  return <div className="flex-1 overflow-y-auto p-4 text-slate-900 dark:text-white">
    {isLoading && <p role="status">{t('common.loading')}</p>}
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">{catalog.map(item => <button key={item.key} type="button"
      disabled={item.disabled} onClick={() => onAdd(item.line())} className="rounded-xl border border-slate-200 bg-white p-4 text-left dark:border-white/15 dark:bg-slate-900">
      <span className="block font-semibold">{item.name}</span><span>{formatCurrency(item.price)}</span>
      <span className="block text-sm">{t('salonSale.add')}</span>
    </button>)}</div>
  </div>;
}

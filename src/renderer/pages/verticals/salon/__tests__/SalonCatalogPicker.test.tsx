import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ retail: true, blockOverselling: false, inclusive: true, shampooStock: 5, unsynced: [] as any[], toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { error: state.toastError } }));
vi.mock('../../../../../lib', () => ({
  getBridge: () => ({ orders: { getUnsyncedRetailQuantities: async () => ({ success: true, quantities: state.unsynced }) } }),
  isBrowser: () => false,
}));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../hooks/useAcquiredModules', () => ({ useAcquiredModules: () => ({ hasModule: () => state.retail }) }));
vi.mock('../../../../hooks/useServices', () => ({ useServices: () => ({ isLoading: false, services: [{ id: 'haircut', name: 'Haircut', price: 25, isActive: true, durationMinutes: 45, vatCategoryCode: 'gr_standard_24', priceIncludesVat: state.inclusive }] }) }));
vi.mock('../../../../hooks/useProductCatalog', () => ({ useProductCatalog: () => ({ products: [{ id: 'shampoo', name: 'Shampoo', price: 8, quantity: state.shampooStock, isActive: true, vatCategoryCode: 'retail-vat' }, { id: 'dye', name: 'Dye', price: 10, isActive: true, variants: [{ id: 'red', name: 'Red', quantity: 0, priceAdjustment: 3, isActive: true }, { id: 'blue', name: 'Blue', quantity: 1, priceAdjustment: 3, isActive: true }, { id: 'old', name: 'Old', priceAdjustment: 9, isActive: false }] }] }) }));
// Only the overselling switch is set; the VAT keys stay unset (registered, Greek defaults).
vi.mock('../../../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: (category: string, key: string) => (category === 'retail' && key === 'block_overselling' ? state.blockOverselling : undefined) }) }));
// The walk-in stylist question is covered in SalonCatalogPicker.stylist.test.tsx.
vi.mock('../StylistPicker', () => ({ useStylistChoice: () => ({ chooseStylist: (_name: string, add: (stylist: null) => void) => add(null), stylistPicker: null }) }));
import { SalonCatalogPicker } from '../SalonCatalogPicker';
import { resetRetailStockGuardCache } from '../../../../services/retail-stock-guard';
beforeEach(() => { resetRetailStockGuardCache(); state.shampooStock = 5; state.unsynced = []; });
afterEach(() => { cleanup(); state.inclusive = true; state.blockOverselling = false; });
describe('mixed salon ticket catalog', () => {
  it('shows and adds the gross sale price of a net-priced service', () => {
    state.inclusive = false;
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    const button = screen.getByRole('button', { name: /Haircut/ });
    expect(button.textContent).toContain('31');
    fireEvent.click(button);
    expect(add.mock.calls[0][0]).toMatchObject({price:31, totalPrice:31, price_includes_vat:true});
  });
  it('adds haircut, retail and menu lines to the same normal ticket with separate identities', () => {
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[{ id: 'tea', name: 'Tea', price: 3 }]} onAdd={add} />);
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Tea/ }));
    expect(add.mock.calls[0][0]).toMatchObject({ service_id: 'haircut', menu_item_id: null, price: 25, quantity: 1, vat_category_code: 'gr_standard_24' });
    expect(add.mock.calls[1][0]).toMatchObject({ menu_item_id: 'shampoo', price: 8, vat_category_code: 'retail-vat' });
    expect(add.mock.calls[2][0].menu_item_id).toBe('tea');
  });
  it('requires an active variant choice and preserves explicit retail identity and adjusted price', () => {
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    expect(screen.queryByRole('button', { name: /Old/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Dye - Red/ }));
    expect(add.mock.calls[0][0]).toMatchObject({ retail_product_id: 'dye', retail_variant_id: 'red', menu_item_id: 'dye', price: 13 });
  });
  it('honors the same variant overselling setting as the retail picker', () => {
    state.blockOverselling = true;
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Dye - Red/ })).toBeDisabled();
    state.blockOverselling = false;
  });
  it('hides retail when its module is absent, without blocking services', () => {
    state.retail = false;
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Shampoo/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Haircut/ })).toBeTruthy();
    state.retail = true;
  });
});

describe('salon picker products under retail.block_overselling', () => {
  const shampooLine = { id: 'line-1', retail_product_id: 'shampoo', retail_variant_id: null, quantity: 1 };
  const show = (cartItems: any[] = [], add = vi.fn()) => {
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} cartItems={cartItems} />);
    return add;
  };

  it('refuses a product whose last unit is already on the ticket', async () => {
    state.blockOverselling = true; state.shampooStock = 1;
    const add = show([shampooLine]);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    expect(add).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledWith('retailStock.onlyAvailable');
  });

  it("counts this till's unsynced sales of the product", async () => {
    state.blockOverselling = true; state.shampooStock = 1;
    state.unsynced = [{ productId: 'shampoo', variantId: null, quantity: 1 }];
    const add = show();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    expect(add).not.toHaveBeenCalled();
  });

  it('adds the product while stock is left, and always when the setting is off', async () => {
    state.blockOverselling = true; state.shampooStock = 1;
    let add = show();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    expect(add).toHaveBeenCalledTimes(1);
    cleanup();
    state.blockOverselling = false; state.shampooStock = 0;
    add = show([shampooLine]);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('disables a variant whose last unit is on the ticket', async () => {
    state.blockOverselling = true;
    show([{ id: 'line-2', retail_product_id: 'dye', retail_variant_id: 'blue', quantity: 1 }]);
    await act(async () => {});
    expect(screen.getByRole('button', { name: /Dye - Blue/ })).toBeDisabled();
    cleanup();
    show();
    await act(async () => {});
    expect(screen.getByRole('button', { name: /Dye - Blue/ })).toBeEnabled();
  });
});

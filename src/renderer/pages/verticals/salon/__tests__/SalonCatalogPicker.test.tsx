import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ retail: true, blockOverselling: false, inclusive: true }));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../hooks/useAcquiredModules', () => ({ useAcquiredModules: () => ({ hasModule: () => state.retail }) }));
vi.mock('../../../../hooks/useServices', () => ({ useServices: () => ({ isLoading: false, services: [{ id: 'haircut', name: 'Haircut', price: 25, isActive: true, durationMinutes: 45, vatCategoryCode: 'gr_standard_24', priceIncludesVat: state.inclusive }] }) }));
vi.mock('../../../../hooks/useProductCatalog', () => ({ useProductCatalog: () => ({ products: [{ id: 'shampoo', name: 'Shampoo', price: 8, isActive: true, vatCategoryCode: 'retail-vat' }, { id: 'dye', name: 'Dye', price: 10, isActive: true, variants: [{ id: 'red', name: 'Red', quantity: 0, priceAdjustment: 3, isActive: true }, { id: 'old', name: 'Old', priceAdjustment: 9, isActive: false }] }] }) }));
vi.mock('../../../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: () => state.blockOverselling }) }));
import { SalonCatalogPicker } from '../SalonCatalogPicker';
afterEach(() => { cleanup(); state.inclusive = true; });
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

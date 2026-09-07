import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BusinessCategoryDashboard } from '../BusinessCategoryDashboard';

const { serviceImported, productImported } = vi.hoisted(() => ({
  serviceImported: vi.fn(),
  productImported: vi.fn(),
}));

vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ businessType: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../FoodDashboard', () => ({
  FoodDashboard: ({ className }: { className?: string }) => <div role="region" aria-label="Food dashboard" className={className} />,
}));
vi.mock('../ServiceDashboard', () => {
  serviceImported();
  return { ServiceDashboard: ({ className }: { className?: string }) => <div role="region" aria-label="Service dashboard" className={className} /> };
});
vi.mock('../ProductDashboard', () => {
  productImported();
  return { ProductDashboard: ({ className }: { className?: string }) => <div role="region" aria-label="Product dashboard" className={className} /> };
});

afterEach(cleanup);

it('defaults to food without importing optional dashboards, then loads only the selected category', async () => {
  const { rerender } = render(<BusinessCategoryDashboard className="dashboard-layout" />);
  expect(screen.getByRole('region', { name: 'Food dashboard' })).toHaveClass('dashboard-layout');
  // These spies run in module factories, so a hidden eager import also fails this check.
  expect(serviceImported).not.toHaveBeenCalled();
  expect(productImported).not.toHaveBeenCalled();

  rerender(<BusinessCategoryDashboard className="dashboard-layout" overrideBusinessType="salon" />);
  expect(await screen.findByRole('region', { name: 'Service dashboard' })).toHaveClass('dashboard-layout');
  expect(serviceImported).toHaveBeenCalledOnce();
  expect(productImported).not.toHaveBeenCalled();

  rerender(<BusinessCategoryDashboard className="dashboard-layout" overrideBusinessType="retail" />);
  expect(await screen.findByRole('region', { name: 'Product dashboard' })).toHaveClass('dashboard-layout');
  expect(productImported).toHaveBeenCalledOnce();
  expect(serviceImported).toHaveBeenCalledOnce();

  rerender(<BusinessCategoryDashboard className="dashboard-layout" overrideCategory="service" />);
  expect(await screen.findByRole('region', { name: 'Service dashboard' })).toHaveClass('dashboard-layout');
  expect(serviceImported).toHaveBeenCalledOnce();
});

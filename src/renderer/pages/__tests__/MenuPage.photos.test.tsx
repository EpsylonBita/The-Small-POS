import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MenuPage from '../MenuPage';

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>, loadItems: vi.fn(), clearCache: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock('../../services/MenuService', () => ({ menuService: {
  getMenuItems: () => mocks.loadItems(),
  getMenuCategories: async () => [{ id: 'drinks', name: 'Drinks' }],
  clearCache: mocks.clearCache, getIngredients: async () => [],
} }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ terminalConfig: { getBranchId: async () => 'branch-1' } }),
  onEvent: (event: string, handler: () => void) => mocks.handlers.set(event, handler),
  offEvent: (event: string) => mocks.handlers.delete(event),
}));
vi.mock('../../components/menu', () => ({
  MenuGrid: ({ items }: { items: Array<{ id: string; name: string; image?: string }> }) => <div>
    {items.map(item => <div key={item.id}>{item.name}{item.image && <img src={item.image} alt={item.name} />}</div>)}
  </div>,
  MenuItemModal: () => null, CartSummary: () => null, MenuCategoryTabs: () => null,
}));
vi.mock('../../hooks/useOrderStore', () => ({ useOrderStore: () => ({ createOrder: vi.fn(), isOperationLoading: false }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: () => undefined }) }));
vi.mock('../../hooks/useRealTimeMenuSync', () => ({ useRealTimeMenuSync: () => ({ getEffectiveMenuItem: (item: unknown) => item }) }));
vi.mock('../../hooks/useFeaturedItems', () => ({ useFeaturedItems: () => ({ topSellerIds: new Set() }) }));
vi.mock('../../components/modals/CustomerInfoModal', () => ({ CustomerInfoModal: () => null }));
vi.mock('../../components/skeletons', () => ({ MenuPageSkeleton: () => null }));
vi.mock('../../components/error', () => ({ ErrorDisplay: () => null }));
vi.mock('../../components/ui/page-motion', () => ({ pageMotionContainer: {}, pageMotionItem: {} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams()] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: React.PropsWithChildren) => <div>{children}</div> } }));

const photo = 'https://images.example.test/coffee.jpg';
const row = { id: 'coffee', category_id: 'drinks', name: 'Coffee', price: 3, image_url: photo };
beforeEach(() => {
  mocks.items = [row];
  mocks.handlers.clear();
  mocks.loadItems.mockReset().mockImplementation(async () => mocks.items);
});
afterEach(cleanup);

describe('mounted Windows ordering screen after durable photo sync', () => {
  it('reloads the saved projection and removes a photo without removing Coffee', async () => {
    render(<MenuPage />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Coffee' })).toHaveAttribute('src', photo));
    mocks.items = [{ ...row, image_url: null, show_image_in_pos: false }];
    await act(async () => mocks.handlers.get('menu:sync')!());
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Coffee' })).toBeNull());
    expect(screen.getByText('Coffee')).toBeVisible();
    expect(mocks.clearCache).toHaveBeenCalled();
  });

  it('does not let an older in-flight snapshot restore a removed photograph', async () => {
    let releaseOld!: (items: Array<Record<string, unknown>>) => void;
    mocks.loadItems.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    render(<MenuPage />);
    await waitFor(() => expect(releaseOld).toBeDefined());
    mocks.items = [{ ...row, image_url: null, show_image_in_pos: false }];
    await act(async () => mocks.handlers.get('menu:sync')!());
    await waitFor(() => expect(screen.getByText('Coffee')).toBeVisible());
    await act(async () => releaseOld([row]));
    expect(screen.queryByRole('img', { name: 'Coffee' })).toBeNull();
  });
});

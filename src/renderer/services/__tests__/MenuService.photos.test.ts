import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuService } from '../MenuService';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), browser: false, query: vi.fn() }));
vi.mock('../../../lib', () => ({ isBrowser: () => mocks.browser, getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('../../../shared/supabase', () => ({ isSupabaseConfigured: () => true, supabase: { from: () => mocks.query() } }));
vi.mock('../../utils/api-helpers', () => ({ posApiGet: vi.fn() }));
vi.mock('../../utils/session-utils', () => ({ isOwnEvent: () => false, addSessionId: (value: unknown) => value }));

const row = { id: 'coffee', category_id: 'drinks', name: 'Coffee', price: 3, pickup_price: 3,
  delivery_price: 4, is_available: true, image_url: 'https://images.example.test/coffee.jpg' };
beforeEach(() => {
  menuService.clearCache();
  mocks.browser = false;
  mocks.invoke.mockReset();
});

describe('Windows POS photo contract through actual MenuService', () => {
  it.each([[true, true], [true, false], [false, true], [false, false]])(
    'POS=%s kiosk=%s preserves orderable products and prices', async (pos, kiosk) => {
      mocks.invoke.mockResolvedValue([{ ...row, show_image_in_pos: pos, show_image_in_kiosk: kiosk }]);
      const items = await menuService.getMenuItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: row.id, price: 3, pickup_price: 3, delivery_price: 4,
        is_available: true, image_url: pos ? row.image_url : null });
    }
  );

  it('refreshing the native JSON snapshot clears an old URL, then restores a new visible URL', async () => {
    mocks.invoke.mockResolvedValue([row]);
    expect((await menuService.getMenuItems())[0].image_url).toBe(row.image_url);
    mocks.invoke.mockResolvedValue([{ ...row, image_url: null, show_image_in_pos: false }]);
    menuService.clearCache();
    expect((await menuService.getMenuItems())[0].image_url).toBeNull();
    const replacement = 'https://images.example.test/replacement.jpg';
    mocks.invoke.mockResolvedValue([{ ...row, image_url: replacement }]);
    menuService.clearCache();
    expect((await menuService.getMenuItems())[0].image_url).toBe(replacement);
  });

  it('the direct browser fallback for an individual item suppresses a kiosk-only photo', async () => {
    mocks.browser = true;
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order']) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    query.single = vi.fn(async () => ({ data: { ...row, show_image_in_pos: false }, error: null }));
    mocks.query.mockReturnValue(query);
    expect(await menuService.getMenuItemById(row.id)).toMatchObject({ id: row.id, price: 3, image_url: null });
  });

  it('nested combo products are filtered without changing the combo artwork or availability', async () => {
    mocks.invoke.mockResolvedValue([{ id: 'combo', is_active: true, image_url: 'https://images.example.test/combo.jpg',
      items: [{ subcategory: { ...row, show_image_in_pos: false } }] }]);
    const combos = await menuService.getMenuCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0].image_url).toBe('https://images.example.test/combo.jpg');
    expect(combos[0].items[0].subcategory).toMatchObject({ id: row.id, price: 3, image_url: null });
  });
});

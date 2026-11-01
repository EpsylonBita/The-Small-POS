/**
 * The order of the sidebar icons, one per till (founder 31/10: «η μεταφορά και η στοίχιση των εικονιδίων
 * μετά την επανεκκίνηση πάνε ξανά όλα στις θέσεις που ήταν … όπως βολεύει το κατάστημα»).
 *
 * It used to be saved under organization + terminal + the staff member on shift. After a restart the
 * shift came back from storage without its organization, so the key changed and the rail fell back to
 * the default order; every staff member also had an order of their own. The till's storage belongs to
 * the till, so one key holds the store's arrangement for every staff member and every restart.
 */
export const NAVIGATION_ORDER_STORAGE_KEY = 'pos-navigation-module-order';
const LEGACY_PREFIX = `${NAVIGATION_ORDER_STORAGE_KEY}:`;

type OrderStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>;

const parseOrder = (raw: string | null): string[] | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : null;
  } catch {
    return null;
  }
};

/**
 * The saved order, or [] when none. The first time, an order saved under the old per-staff keys is
 * adopted -- this till and staff member's first, then any of this till, then any -- so an arrangement
 * made before the fix is kept.
 */
export function loadNavigationOrder(
  storage: OrderStorage,
  legacyHint: { terminalId?: string | null; staffId?: string | null } = {},
): string[] {
  const saved = parseOrder(storage.getItem(NAVIGATION_ORDER_STORAGE_KEY));
  if (saved) return saved;

  const legacy: Array<{ terminalId: string; staffId: string; order: string[] }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
    const order = parseOrder(storage.getItem(key));
    if (!order || order.length === 0) continue;
    // Old key: pos-navigation-module-order:<organization>:<terminal>:<staff>
    const [, terminalId = '', staffId = ''] = key.slice(LEGACY_PREFIX.length).split(':');
    legacy.push({ terminalId, staffId, order });
  }
  const { terminalId, staffId } = legacyHint;
  const adopted = legacy.find((entry) => !!terminalId && entry.terminalId === terminalId && entry.staffId === staffId)
    ?? legacy.find((entry) => !!terminalId && entry.terminalId === terminalId)
    ?? legacy[0];
  if (!adopted) return [];
  try {
    storage.setItem(NAVIGATION_ORDER_STORAGE_KEY, JSON.stringify(adopted.order));
  } catch {
    // Storage full or blocked: the rail still uses the adopted order for this session.
  }
  return adopted.order;
}

export function saveNavigationOrder(storage: Pick<Storage, 'setItem'>, order: string[]): void {
  storage.setItem(NAVIGATION_ORDER_STORAGE_KEY, JSON.stringify(order));
}

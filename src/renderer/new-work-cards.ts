import type { resolveTauriPrimaryActions } from './primary-actions';

/**
 * The (+) button opens ONE picker that lists every kind of work this business
 * can start, side by side and in the same visual language — Παράδοση,
 * Παραλαβή, Τραπέζι, Δωμάτιο, Ραντεβού, Επισκευή, Γρήγορη υπηρεσία — filtered
 * by the modules the organization has acquired (founder, 05/09/2026: «το (+)
 * θα εμφανίζει τις δυνατότητες της κάθε επιχείρησης»). There is no
 * intermediate «Νέα πώληση» step: a retail store with delivery sees
 * pickup + delivery, an appointments-only business sees only appointments,
 * an electronics repair shop that also sells sees sale + repair.
 *
 * This resolver is the single source of truth for which cards exist, in
 * which order, and whether each is launchable right now. The dashboard only
 * renders what it returns.
 */
export type NewWorkCardId =
  | 'delivery'
  | 'pickup'
  | 'table'
  | 'room'
  | 'service'
  | 'repair'
  | 'quick_service';

export interface NewWorkCard {
  id: NewWorkCardId;
  /** Position among the visible cards, used for the responsive grid spans. */
  visibleIndex: number;
  enabled: boolean;
  /** i18n key explaining a disabled card; undefined when enabled. */
  disabledReasonKey?: string;
}

export interface ResolveNewWorkCardsInput {
  hasOrdersModule: boolean;
  hasDeliveryModule: boolean;
  hasTablesModule: boolean;
  hasRoomsModule: boolean;
  hasServicesModule: boolean;
  primaryActions: ReturnType<typeof resolveTauriPrimaryActions>;
  isShiftActive: boolean;
}

/** Cards that move money through the drawer need an open cash shift. */
const SHIFT_REQUIRED: ReadonlySet<NewWorkCardId> = new Set([
  'delivery',
  'pickup',
  'table',
  'room',
  'repair',
  'quick_service',
]);

export function resolveNewWorkCards(input: ResolveNewWorkCardsInput): NewWorkCard[] {
  const actionEnabled = (id: string) =>
    input.primaryActions.some((action) => action.id === id && action.enabled);

  const ordered: Array<{ id: NewWorkCardId; visible: boolean; entitled: boolean }> = [
    { id: 'delivery', visible: input.hasDeliveryModule, entitled: true },
    // Pickup is the plain sale; without the orders module there is no sale.
    { id: 'pickup', visible: input.hasOrdersModule, entitled: true },
    { id: 'table', visible: input.hasTablesModule, entitled: true },
    { id: 'room', visible: input.hasRoomsModule, entitled: true },
    { id: 'service', visible: input.hasServicesModule, entitled: true },
    {
      id: 'repair',
      visible: input.primaryActions.some((action) => action.id === 'new_repair'),
      entitled: actionEnabled('new_repair'),
    },
    {
      id: 'quick_service',
      visible: input.primaryActions.some((action) => action.id === 'quick_service'),
      entitled: actionEnabled('quick_service'),
    },
  ];

  const cards: NewWorkCard[] = [];
  for (const candidate of ordered) {
    if (!candidate.visible) continue;
    const shiftBlocked = SHIFT_REQUIRED.has(candidate.id) && !input.isShiftActive;
    const enabled = candidate.entitled && !shiftBlocked;
    cards.push({
      id: candidate.id,
      visibleIndex: cards.length,
      enabled,
      disabledReasonKey: enabled
        ? undefined
        : shiftBlocked
          ? 'orders.startShiftFirst'
          : 'primaryActions.status.comingSoon',
    });
  }
  return cards;
}

/** Whether the (+) trigger itself should be clickable. */
export function hasLaunchableNewWork(cards: NewWorkCard[]): boolean {
  return cards.some((card) => card.enabled);
}

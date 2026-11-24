import type { RecoveryActionLogEntry } from '../../../lib';

/**
 * How the Health window's history («Τι δοκιμάστηκε») reads one row of the
 * till's audit log (`recovery_action_log`).
 *
 * The log holds two different things: attempts to repair a problem, which
 * carry one of the four shipped outcomes, and plain records of something a
 * person or the till did (a payment's method changed, a platform order's cash
 * booked to its driver). A record is not a repair, so it never reads «not
 * confirmed»; it reads «recorded», and only for the kinds listed below whose
 * row is written in the same transaction as the action itself.
 */
export const HISTORY_STATES = ['resolved', 'recorded', 'pending', 'failed', 'unknown'] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

interface HistoryKind {
  /** Sentences live under `tillHealth.history.kinds.<key>.<state>`. */
  key: string;
  /** The till writes it by itself: nobody pressed anything for it. */
  automatic: boolean;
  /** A record written with the action it records; see the note above. */
  record: boolean;
  /** States with a plain sentence; any other state falls back to the generic line. */
  states: readonly HistoryState[];
  /** States whose sentence counts orders (`_one` / `_other`), so repeats fold into one row. */
  counted: readonly HistoryState[];
}

/** Closed list, by `action_id`. Add a kind only with its sentences in all six locales. */
export const HISTORY_KINDS = {
  // sync.rs: a platform order's print waited for its items; the till fetched them.
  hydrate_food_print_items: {
    key: 'orderItems', automatic: true, record: false,
    states: ['resolved', 'pending', 'failed', 'unknown'], counted: ['resolved'],
  },
  // platform_cash_assignment.rs: written inside the driver assignment's transaction.
  platform_cash_at_assignment: {
    key: 'platformCash', automatic: true, record: true,
    states: ['recorded'], counted: ['recorded'],
  },
  // payments.rs: written in the transaction that changes the method.
  manual_payment_method_correction: {
    key: 'paymentMethod', automatic: false, record: true,
    states: ['recorded'], counted: [],
  },
} as const satisfies Record<string, HistoryKind>;

/**
 * Other rows the till writes with nobody acting. They keep the label they
 * already have (or the generic line); only their actor reads «Αυτόματα».
 */
export const AUTOMATIC_ACTION_IDS: readonly string[] = [
  'auto_retry',
  'print_orphan_attempt_closed',
  'bind_order_create_base',
];

export type HistoryActor =
  | { type: 'staff'; name: string }
  | { type: 'automatic' }
  | { type: 'unknown' };

export interface HistoryRow {
  /** Stable across renders: the newest entry's id. */
  id: string;
  /** Newest first; more than one only for a folded group. */
  entries: RecoveryActionLogEntry[];
  actionId: string;
  kind: HistoryKind | null;
  state: HistoryState;
  actor: HistoryActor;
  /** Set when the kind has a plain sentence for this state. */
  sentenceKey: string | null;
  count: number;
}

function historyKind(actionId: string): HistoryKind | null {
  return Object.prototype.hasOwnProperty.call(HISTORY_KINDS, actionId)
    ? HISTORY_KINDS[actionId as keyof typeof HISTORY_KINDS]
    : null;
}

export function historyState(entry: RecoveryActionLogEntry): HistoryState {
  if (entry.outcome) return entry.outcome;
  return historyKind(entry.actionId)?.record && entry.success ? 'recorded' : 'unknown';
}

/**
 * A stored name wins. «Αυτόματα» needs both: no staff id on the row and a
 * kind the till writes by itself. A row with a staff id and no name stays
 * «not identified»: a person acted, the till just cannot name them.
 */
export function historyActor(entry: RecoveryActionLogEntry): HistoryActor {
  const name = entry.actor?.staffName?.trim();
  if (name) return { type: 'staff', name };
  // Rows the order notice writes for its own automatic resend.
  if (entry.actionId.toLowerCase().includes('automatic') || entry.id.startsWith('automatic:')) {
    return { type: 'automatic' };
  }
  const selfWritten = historyKind(entry.actionId)?.automatic || AUTOMATIC_ACTION_IDS.includes(entry.actionId);
  return selfWritten && !entry.actor?.staffId ? { type: 'automatic' } : { type: 'unknown' };
}

/** The local calendar day of a timestamp; the raw text when it cannot be read. */
function localDay(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * One row per entry, except that automatic rows of the same kind that
 * finished the same way on the same day fold into one counted row, placed
 * where their newest entry was. Only finished rows fold: every pending,
 * failed or unconfirmed row stays on its own line.
 */
export function buildHistoryRows(entries: readonly RecoveryActionLogEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const groups = new Map<string, HistoryRow>();
  for (const entry of entries) {
    const kind = historyKind(entry.actionId);
    const state = historyState(entry);
    const actor = historyActor(entry);
    const hasSentence = Boolean(kind && (kind.states as readonly HistoryState[]).includes(state));
    const folds = Boolean(kind && actor.type === 'automatic'
      && (state === 'resolved' || state === 'recorded')
      && (kind.counted as readonly HistoryState[]).includes(state));
    const groupKey = folds ? `${entry.actionId}|${state}|${localDay(entry.timestamp)}` : null;
    const group = groupKey ? groups.get(groupKey) : undefined;
    if (group) {
      group.entries.push(entry);
      group.count += 1;
      continue;
    }
    const row: HistoryRow = {
      id: entry.id,
      entries: [entry],
      actionId: entry.actionId,
      kind,
      state,
      actor,
      sentenceKey: kind && hasSentence ? `tillHealth.history.kinds.${kind.key}.${state}` : null,
      count: 1,
    };
    rows.push(row);
    if (groupKey) groups.set(groupKey, row);
  }
  return rows;
}

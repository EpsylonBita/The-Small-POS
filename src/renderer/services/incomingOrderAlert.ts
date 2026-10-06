/**
 * Incoming-order alert: the POS's own alert for orders that wait at this
 * register for accept / decline (efood, Wolt, Box… and the customer's own QR,
 * web and kiosk orders; the rule is root shared/order-approval.ts).
 *
 * Why it lives at the App level (IncomingOrderAlertManager, mounted in App.tsx
 * outside every route) and not inside the Orders screen — Tomikro, desktop
 * 1.4.119, 30/09/2026: efood orders arrive through our server-side plugin, the
 * POS pulls them into its local cache about ten seconds later, and the alert
 * used to live only in OrderDashboard. OrderDashboard is mounted on the Orders
 * screen alone, so two efood orders that arrived while staff were on another
 * page (efood «Live παραγγελίες», tables, menu…) got no modal and no sound and
 * waited 11 and 2 minutes until someone went back to the Orders screen. The
 * /new-order page (where every dine-in order is taken) renders without the
 * main layout, so the alert cannot live in the layout either.
 *
 * It must never be missed: it plays on every page, and a watchdog escalates
 * (sound again, the dialog above every other dialog, a logged entry) whenever
 * an order waits without its approval panel actually on screen. It rings
 * independently of the efood page's own sound switch: that switch mutes only
 * efood's webview.
 *
 * Exactly one owner plays the alert loop: services/incomingOrderAlertLoop.ts,
 * a module a render error cannot stop. The Orders screen keeps the approval
 * itself (OrderApprovalPanel + its approve / decline handlers) and marks that
 * panel in the DOM so the alert can see it is showing.
 */
import { getActiveUiBlockers } from './uiBlockerRegistry';
import { isBoxDecisionClosed } from '../../../../shared/box-order-contract';

/**
 * True for an order that may look like it waits for accept / decline but
 * must not ring the incoming-order alert: a BOX order whose decision the
 * server closed (BOX expired or refused it, or the outcome is unknown and
 * staff check it with BOX; see shared/box-order-contract.ts). It takes no
 * accept / decline any more, even while it is still pending (the manual-check
 * case), so the alert would ask staff for a decision nobody can take. Meant
 * for the alert queue (services/incomingOrderAlertLoop.ts) to leave such
 * orders out; the order itself stays visible on the Orders screen.
 */
export function isIncomingOrderAlertExempt(order: unknown): boolean {
  return isBoxDecisionClosed(order);
}

/** The alert repeats this often while an order waits. */
export const INCOMING_ORDER_ALERT_REPEAT_MS = 30_000;

/** An order waiting this long with no approval panel on screen escalates. */
export const INCOMING_ORDER_WATCHDOG_MS = 30_000;

/** How often the watchdog looks for the approval panel on screen. */
export const INCOMING_ORDER_WATCHDOG_TICK_MS = 1_000;

/**
 * Safety-net re-read of the local order cache, at most this often, after a
 * Rust sync tick (`sync:status`, emitted after each pull). The store normally
 * hears about a pulled order through the `order-created` event and the
 * realtime refresh; this bounds how long a missed event can hide an order
 * without adding a renderer polling loop.
 */
export const INCOMING_ORDER_SAFETY_REFRESH_MS = 30_000;

/**
 * On the Orders screen the approval panel opens by itself, so the dialog
 * waits for it this long: counted from when the order started waiting
 * unanswered, and again from when staff reached that Orders view. When no
 * queued order's panel is on screen by then, the dialog shows there too — the
 * retail product catalog's Orders screen offers only product orders, and a
 * panel can be covered by another dialog or fail to render.
 */
export const INCOMING_ORDER_PANEL_GRACE_MS = 2_000;

/** How long «Open the order» hides the alert while the Orders screen opens it. */
export const INCOMING_ORDER_HANDOFF_MS = 5_000;

/**
 * The dialog's buttons (and Escape) do nothing this long after it appears, so
 * a tap or key already in flight when it pops up is never taken as a choice.
 */
export const INCOMING_ORDER_ALERT_TAP_GUARD_MS = 300;

/**
 * Above every POS dialog layer (glass modals 20000, nested overlays 20050-
 * 20060, the loyalty / preview layers at 2147483000-2147483001) and below the
 * custom title bar (2147483600) and the toasts (2147483647).
 */
export const INCOMING_ORDER_ALERT_Z_INDEX = 2_147_483_100;

/**
 * Carried by the approval UI of an incoming order (the panel header and its
 * decline dialog), valued with the order id.
 */
export const INCOMING_ORDER_APPROVAL_MARKER_ATTR = 'data-incoming-order-approval';

// ---------------------------------------------------------------------------
// «Open the order»: the alert asks the Orders screen to show its approval panel
// for one order. The request is kept briefly so a screen that mounts right
// after the navigation still receives it.
// ---------------------------------------------------------------------------

const FOCUS_REQUEST_TTL_MS = 10_000;

type FocusListener = (orderId: string) => void;

const focusListeners = new Set<FocusListener>();
let pendingFocusRequest: { orderId: string; at: number } | null = null;

export function requestIncomingOrderApprovalFocus(orderId: string): void {
  if (!orderId) return;
  pendingFocusRequest = { orderId, at: Date.now() };
  if (focusListeners.size === 0) return;
  pendingFocusRequest = null;
  for (const listener of [...focusListeners]) {
    try {
      listener(orderId);
    } catch (error) {
      console.error('[IncomingOrderAlert] approval focus listener failed', error);
    }
  }
}

export function subscribeIncomingOrderApprovalFocus(listener: FocusListener): () => void {
  focusListeners.add(listener);
  const pending = pendingFocusRequest;
  if (pending && Date.now() - pending.at <= FOCUS_REQUEST_TTL_MS) {
    pendingFocusRequest = null;
    listener(pending.orderId);
  }
  return () => {
    focusListeners.delete(listener);
  };
}

/** Test-only reset of the module state above. */
export function __resetIncomingOrderAlertForTests(): void {
  focusListeners.clear();
  pendingFocusRequest = null;
}

// ---------------------------------------------------------------------------
// Is the approval UI of one of these orders really on screen?
// ---------------------------------------------------------------------------

function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function markerOrderId(element: Element | null): string | null {
  const marker = element?.closest(`[${INCOMING_ORDER_APPROVAL_MARKER_ATTR}]`);
  return marker?.getAttribute(INCOMING_ORDER_APPROVAL_MARKER_ATTR) ?? null;
}

/**
 * True when the approval panel of one of `orderIds` is rendered AND is the
 * top-most thing at its own position: present in the DOM is not enough, a
 * settings dialog or a wizard opened over it hides it just as well.
 *
 * `ignore` is the alert's own overlay, which may sit above the panel while it
 * hands over. Without a layout engine (jsdom) presence is the best signal.
 */
export function isIncomingOrderApprovalOnScreen(
  orderIds: readonly string[],
  options: { ignore?: Element | null } = {},
): boolean {
  if (typeof document === 'undefined' || orderIds.length === 0) return false;
  const wanted = new Set(orderIds);
  const markers = Array.from(
    document.querySelectorAll<HTMLElement>(`[${INCOMING_ORDER_APPROVAL_MARKER_ATTR}]`),
  ).filter((marker) => wanted.has(marker.getAttribute(INCOMING_ORDER_APPROVAL_MARKER_ATTR) ?? ''));
  if (markers.length === 0) return false;

  const hitTest = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint.bind(document)
    : null;
  if (!hitTest) return true;

  const { ignore } = options;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  for (const marker of markers) {
    const rect = marker.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const y = rect.top + rect.height / 2;
    // Three points across the marker: a toast over one of them is not a
    // hidden panel.
    for (const fraction of [0.5, 0.25, 0.75]) {
      const x = rect.left + rect.width * fraction;
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
      const topMost = hitTest(x, y).find((element) => !(ignore && ignore.contains(element)));
      const hitOrderId = markerOrderId(topMost ?? null);
      if (hitOrderId && wanted.has(hitOrderId)) return true;
    }
  }
  return false;
}

/** Whether some approval marker for these orders exists at all (diagnostics). */
export function isIncomingOrderApprovalInDom(orderIds: readonly string[]): boolean {
  if (typeof document === 'undefined') return false;
  return orderIds.some((orderId) =>
    document.querySelector(`[${INCOMING_ORDER_APPROVAL_MARKER_ATTR}="${cssAttrValue(orderId)}"]`) !== null,
  );
}

// ---------------------------------------------------------------------------
// Alert log: what the next incident will need to be diagnosed. Every event
// goes to the console (tag «[IncomingOrderAlert]») and to a bounded log in
// this register's local storage that survives a restart:
//   JSON.parse(localStorage.getItem('pos-incoming-order-alert-log'))
// The watchdog and render-failure entries also reach support: the Health
// view's diagnostics export carries them in health_view.json
// (`incomingOrderAlerts`, see buildIncomingOrderAlertSupportEvidence).
// ---------------------------------------------------------------------------

export const INCOMING_ORDER_ALERT_LOG_KEY = 'pos-incoming-order-alert-log';
export const INCOMING_ORDER_ALERT_LOG_LIMIT = 100;

export type IncomingOrderAlertEvent =
  /** The order entered the alert queue. */
  | 'alerting'
  /**
   * The watchdog fired and staff never had it in front of them: neither the
   * approval panel nor the alert dialog was on screen while it waited.
   */
  | 'missed'
  /**
   * The watchdog fired although the alert dialog had been on screen while it
   * waited (staff chose «Later», or left it unanswered): no approval yet.
   */
  | 'escalated'
  /** The alert dialog failed to render; it retries by itself. */
  | 'render_error'
  /** The order left the queue (accepted, declined or no longer pending). */
  | 'resolved';

export interface IncomingOrderAlertLogEntry {
  at: string;
  event: IncomingOrderAlertEvent;
  orderId: string;
  orderNumber: string | null;
  platform: string | null;
  view: string;
  /** Time since this register first saw the order waiting. */
  waitedMs: number;
  pendingCount: number;
  audioEnabled: boolean;
  /** For «missed» / «escalated»: whether the approval panel existed at all (hidden) or not. */
  approvalInDom?: boolean;
  /**
   * For «missed» / «escalated»: whether the alert dialog was on screen at any
   * time while the order waited unanswered.
   */
  overlayShown?: boolean;
  /** For «missed» / «escalated» / «resolved»: whether the watchdog had fired for it. */
  escalated?: boolean;
  /** For «missed» / «escalated»: the dialogs registered as open (modal titles). */
  openDialogs?: string[];
  /** For «render_error»: the error message. */
  error?: string;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readIncomingOrderAlertLog(): IncomingOrderAlertLogEntry[] {
  try {
    const raw = safeStorage()?.getItem(INCOMING_ORDER_ALERT_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IncomingOrderAlertLogEntry[]) : [];
  } catch {
    return [];
  }
}

function appendToLog(entry: IncomingOrderAlertLogEntry): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    const next = [...readIncomingOrderAlertLog(), entry].slice(-INCOMING_ORDER_ALERT_LOG_LIMIT);
    storage.setItem(INCOMING_ORDER_ALERT_LOG_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage never stops the alert itself.
  }
}

/** The dialogs the UI blocker registry knows to be open, by label. */
export function describeOpenDialogs(): string[] {
  try {
    return getActiveUiBlockers().map((blocker) => blocker.label);
  } catch {
    return [];
  }
}

export function recordIncomingOrderAlertEvent(entry: IncomingOrderAlertLogEntry): void {
  const message = `[IncomingOrderAlert] ${entry.event} order=${entry.orderNumber ?? entry.orderId}`
    + ` platform=${entry.platform ?? '-'} view=${entry.view} waited=${Math.round(entry.waitedMs / 1000)}s`;
  try {
    if (entry.event === 'missed') {
      console.error(`${message} — MISSED ALERT: neither the approval panel nor the alert was on screen`, entry);
    } else if (entry.event === 'render_error') {
      console.error(`${message} — the alert dialog failed to render and retries by itself`, entry);
    } else if (entry.event === 'escalated') {
      console.warn(`${message} — ESCALATED: the alert was shown but the order is still unanswered`, entry);
    } else {
      console.info(message, entry);
    }
  } catch {
    // A console that throws never stops the alert.
  }
  appendToLog(entry);
}

// ---------------------------------------------------------------------------
// Support evidence: the entries support needs, for the diagnostics export.
// ---------------------------------------------------------------------------

export const INCOMING_ORDER_ALERT_EVIDENCE_FORMAT = 'pos-incoming-order-alert-log-v1';
const SUPPORT_EVENTS: ReadonlySet<IncomingOrderAlertEvent> = new Set(['missed', 'escalated', 'render_error']);
const SUPPORT_ENTRY_LIMIT = 20;

export interface IncomingOrderAlertSupportEvidence {
  format: typeof INCOMING_ORDER_ALERT_EVIDENCE_FORMAT;
  /** Counts over the whole local log (last INCOMING_ORDER_ALERT_LOG_LIMIT events). */
  counts: Record<'missed' | 'escalated' | 'render_error', number>;
  /** The latest watchdog and render-failure entries, oldest first. */
  entries: IncomingOrderAlertLogEntry[];
}

/**
 * The watchdog («missed», «escalated») and render-failure entries of this
 * register's alert log, bounded, for the Health view's diagnostics export
 * (health_view.json `incomingOrderAlerts`; the exporter redacts the file).
 */
export function buildIncomingOrderAlertSupportEvidence(): IncomingOrderAlertSupportEvidence {
  const relevant = readIncomingOrderAlertLog().filter(
    (entry): entry is IncomingOrderAlertLogEntry =>
      Boolean(entry) && typeof entry === 'object' && SUPPORT_EVENTS.has(entry.event),
  );
  const count = (event: IncomingOrderAlertEvent) => relevant.filter((entry) => entry.event === event).length;
  return {
    format: INCOMING_ORDER_ALERT_EVIDENCE_FORMAT,
    counts: {
      missed: count('missed'),
      escalated: count('escalated'),
      render_error: count('render_error'),
    },
    entries: relevant.slice(-SUPPORT_ENTRY_LIMIT),
  };
}

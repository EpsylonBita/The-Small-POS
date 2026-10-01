/**
 * The dialog of the incoming-order alert, for orders waiting at this register
 * for accept / decline.
 *
 * Rendered once at the App level by IncomingOrderAlertManager (outside every
 * route, so no navigation unmounts it — /new-order included) inside its own
 * self-resetting error boundary. The sound is not played here: the loop
 * lives in services/incomingOrderAlertLoop.ts, which a render error in this
 * dialog cannot stop, and this dialog shows the loop's queue.
 *
 * It shows a blocking «Νέα παραγγελία <platform>» dialog at once on every page
 * but the Orders screen. On the Orders screen OrderDashboard's own approval
 * panel opens by itself, so the dialog shows there only when no queued
 * order's panel is on screen INCOMING_ORDER_PANEL_GRACE_MS after the order
 * started waiting and after staff reached that view (the retail product
 * catalog's Orders screen offers only product orders; a panel can be covered
 * or fail to render). A panel already on screen never gets the dialog over it.
 * Its primary button takes staff to the Orders screen and asks that panel to
 * open for the order. The approval (OrderApprovalPanel and its approve /
 * decline handlers) stays in OrderDashboard. The dialog never switches pages
 * by itself: it takes focus on its container, never on a button, and ignores
 * its buttons and Escape for INCOMING_ORDER_ALERT_TAP_GUARD_MS after it
 * appears, so a tap or key already in flight (typing, a barcode scanner,
 * Enter in a payment dialog) cannot answer it; staff choose «Open the order»
 * or «Later», and focus goes back where it was when the dialog closes.
 *
 * A watchdog escalates when an order waits INCOMING_ORDER_WATCHDOG_MS without
 * its approval panel really on screen — even on the Orders screen, even
 * under another dialog: the sound restarts, this dialog rises above every
 * other one, and the entry is logged («missed» when staff never had the
 * dialog or the panel in front of them, «escalated» otherwise). Incident,
 * rules and log format: services/incomingOrderAlert.ts.
 *
 * Scope: exactly the orders the Orders screen would ask this register to
 * approve (the loop applies the dashboard's order filter; nothing on a waiter
 * terminal). The dashboard has no shift gate on approvals and neither does
 * this. The sound follows the app's audio setting; the dialog shows either way.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BellRing } from 'lucide-react';

import type { Order } from '../../types/orders';
import { MODAL_VIEWPORT_ATTR, useBackgroundAccessibilityIsolation } from '../ui/pos-glass-components';
import { liquidGlassModalButton } from '../../styles/designSystem';
import {
  INCOMING_ORDER_ALERT_TAP_GUARD_MS,
  INCOMING_ORDER_ALERT_Z_INDEX,
  INCOMING_ORDER_HANDOFF_MS,
  INCOMING_ORDER_PANEL_GRACE_MS,
  INCOMING_ORDER_WATCHDOG_MS,
  INCOMING_ORDER_WATCHDOG_TICK_MS,
  describeOpenDialogs,
  isIncomingOrderApprovalInDom,
  isIncomingOrderApprovalOnScreen,
  requestIncomingOrderApprovalFocus,
} from '../../services/incomingOrderAlert';
import {
  incomingOrderHeadlineNumber,
  logIncomingOrderAlertEvent,
  markIncomingOrdersEscalated,
  ringIncomingOrderAlertAgain,
  useIncomingOrderAlertQueue,
} from '../../services/incomingOrderAlertLoop';
import { getPluginColor, getPluginName } from '../../utils/plugin-icons';
import { formatTime } from '../../utils/format';
import { getOrderPluginId, isExternalPlatformOrder } from '../../../../../shared/order-approval';

export interface IncomingOrderAlertHostProps {
  /** Where staff are, for the log: the layout's view, or the route outside it. */
  currentView: string;
  /** The Orders screen (OrderDashboard, which opens the approval panel by itself) is showing. */
  onOrdersScreen: boolean;
  /** Show the Orders screen; its approval panel opens there for the order. */
  onOpenOrders: () => void;
  /**
   * Orders whose details failed to render in this dialog. The next order is
   * shown instead, or, when none is left, the dialog without order details.
   */
  skipOrderIds?: ReadonlySet<string>;
}

interface WatchState {
  /** The approval panel of a queued order is the top-most thing on screen. */
  approvalOnScreen: boolean;
  /** Since when no queued order has had its approval panel on screen. */
  unansweredSince: number | null;
  /**
   * On the Orders screen: no approval panel has shown within
   * INCOMING_ORDER_PANEL_GRACE_MS, so the dialog shows there too.
   */
  panelOverdue: boolean;
  /** The watchdog fired for the current unanswered stretch. */
  escalated: boolean;
}

const IDLE_WATCH: WatchState = {
  approvalOnScreen: false,
  unansweredSince: null,
  panelOverdue: false,
  escalated: false,
};
const NO_SKIPPED_ORDERS: ReadonlySet<string> = new Set();

function platformIdOf(order: Order): string | null {
  return isExternalPlatformOrder(order) ? getOrderPluginId(order) : null;
}

/** The first queued order this dialog can show details for. */
export function selectIncomingOrderToShow(
  queue: readonly Order[],
  skipOrderIds: ReadonlySet<string> = NO_SKIPPED_ORDERS,
): Order | null {
  return queue.find((order) => !skipOrderIds.has(order.id)) ?? null;
}

export const IncomingOrderAlertHost: React.FC<IncomingOrderAlertHostProps> = ({
  currentView,
  onOrdersScreen,
  onOpenOrders,
  skipOrderIds = NO_SKIPPED_ORDERS,
}) => {
  const { t } = useTranslation();
  const queue = useIncomingOrderAlertQueue();
  const head = queue[0] ?? null;
  const shownOrder = useMemo(() => selectIncomingOrderToShow(queue, skipOrderIds), [queue, skipOrderIds]);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const viewRef = useRef(currentView);
  viewRef.current = currentView;

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The dialog was on screen during the current unanswered stretch. */
  const overlaySeenRef = useRef(false);

  const [watch, setWatch] = useState<WatchState>(IDLE_WATCH);
  const [hidden, setHidden] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const titleId = useId();
  const descriptionId = useId();

  // --- Hiding the dialog («Later», and while «Open the order» hands over). --
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideFor = useCallback((durationMs: number) => {
    clearHideTimer();
    setHidden(true);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHidden(false);
    }, durationMs);
  }, [clearHideTimer]);

  const showAgain = useCallback(() => {
    clearHideTimer();
    setHidden(false);
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  // --- A new order is news even after «Later». ----------------------------
  const knownIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = new Set(queue.map((order) => order.id));
    const arrived = Array.from(ids).some((id) => !knownIdsRef.current.has(id));
    knownIdsRef.current = ids;
    if (arrived) showAgain();
  }, [queue, showAgain]);

  // --- Watchdog: is an approval panel really on screen? ---------------------
  // When staff reached the Orders-screen view they are on (null elsewhere):
  // that view's panel gets the full grace from then. Set before the first
  // check below (layout effects run in order).
  const ordersScreenSinceRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    ordersScreenSinceRef.current = onOrdersScreen ? Date.now() : null;
  }, [onOrdersScreen, currentView]);

  const evaluate = useCallback(() => {
    const current = queueRef.current;
    if (current.length === 0) {
      setWatch((previous) => (previous === IDLE_WATCH ? previous : IDLE_WATCH));
      return;
    }
    const now = Date.now();
    const ordersScreenSince = ordersScreenSinceRef.current;
    let onScreen = false;
    try {
      onScreen = isIncomingOrderApprovalOnScreen(
        current.map((order) => order.id),
        { ignore: overlayRef.current },
      );
    } catch (error) {
      console.warn('[IncomingOrderAlert] could not check the approval panel', error);
    }
    setWatch((previous) => {
      const unansweredSince = onScreen ? null : previous.unansweredSince ?? now;
      const escalated = unansweredSince !== null && now - unansweredSince >= INCOMING_ORDER_WATCHDOG_MS;
      const graceFrom = unansweredSince === null
        ? null
        : Math.max(unansweredSince, ordersScreenSince ?? unansweredSince);
      const panelOverdue = graceFrom !== null && now - graceFrom >= INCOMING_ORDER_PANEL_GRACE_MS;
      if (
        previous.approvalOnScreen === onScreen &&
        previous.unansweredSince === unansweredSince &&
        previous.panelOverdue === panelOverdue &&
        previous.escalated === escalated
      ) {
        return previous;
      }
      return { approvalOnScreen: onScreen, unansweredSince, panelOverdue, escalated };
    });
  }, []);

  // The first check runs before paint, so a panel already on screen never
  // gets the dialog flashed over it; it runs again whenever staff change page.
  useLayoutEffect(() => {
    evaluate();
  }, [evaluate, queue, onOrdersScreen, currentView]);

  const hasQueue = queue.length > 0;
  useEffect(() => {
    if (!hasQueue) return undefined;
    const timer = window.setInterval(evaluate, INCOMING_ORDER_WATCHDOG_TICK_MS);
    return () => window.clearInterval(timer);
  }, [evaluate, hasQueue]);

  // --- Escalation: log it and ring again right away. -----------------------
  // Declared before the effect that records whether the dialog was seen, so
  // the entry reflects the stretch before the watchdog fired.
  useEffect(() => {
    if (!watch.escalated) return;
    const current = queueRef.current;
    const first = current[0];
    if (!first) return;
    const orderIds = current.map((order) => order.id);
    markIncomingOrdersEscalated(orderIds);
    const overlaySeen = overlaySeenRef.current;
    logIncomingOrderAlertEvent(overlaySeen ? 'escalated' : 'missed', first, {
      view: viewRef.current,
      approvalInDom: isIncomingOrderApprovalInDom(orderIds),
      overlayShown: overlaySeen,
      escalated: true,
      openDialogs: describeOpenDialogs(),
    });
    // «Later» and the hand-off are bounded, so the dialog comes back by itself;
    // the sound does not wait for it.
    ringIncomingOrderAlertAgain();
  }, [watch.escalated]);

  // --- The dialog. ---------------------------------------------------------
  // At once off the Orders screen; on it, once its own panel is overdue.
  const overlayVisible =
    head !== null &&
    !watch.approvalOnScreen &&
    !hidden &&
    (!onOrdersScreen || watch.panelOverdue || watch.escalated);

  useEffect(() => {
    if (watch.unansweredSince === null) {
      overlaySeenRef.current = false;
    } else if (overlayVisible) {
      overlaySeenRef.current = true;
    }
  }, [overlayVisible, watch.unansweredSince]);

  // Focus: the dialog container, never a button, so an Enter or Space already
  // in flight (typing, a barcode scanner, a payment dialog's Enter) cannot
  // answer it. Taken before paint; the element that had it is remembered, and
  // the moment it appeared (see isTapInFlight below).
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const shownAtRef = useRef(0);
  useLayoutEffect(() => {
    if (!overlayVisible || typeof document === 'undefined') return;
    shownAtRef.current = Date.now();
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body && !overlayRef.current?.contains(active)
        ? active
        : null;
    try {
      dialogRef.current?.focus({ preventScroll: true });
    } catch {
      // Focus is a courtesy; the dialog still shows.
    }
  }, [overlayVisible]);

  // A modal: hide the page behind it from assistive tech while it shows.
  useBackgroundAccessibilityIsolation(overlayVisible);

  // Focus goes back where it was when the dialog closes. A passive cleanup
  // declared after the isolation above, so the page is focusable again by
  // then; skipped when something else (the approval panel) took focus.
  useEffect(() => {
    if (!overlayVisible || typeof document === 'undefined') return undefined;
    return () => {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const now = document.activeElement;
      const focusLost =
        !now || now === document.body || !now.isConnected || Boolean(overlayRef.current?.contains(now));
      if (focusLost && previous && previous.isConnected) {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          // The element can no longer take focus.
        }
      }
    };
  }, [overlayVisible]);

  // A tap or key that lands on the dialog as it appears was meant for the
  // page under it: the buttons and Escape wait INCOMING_ORDER_ALERT_TAP_GUARD_MS.
  const isTapInFlight = useCallback(() => {
    const elapsed = Date.now() - shownAtRef.current;
    return elapsed >= 0 && elapsed < INCOMING_ORDER_ALERT_TAP_GUARD_MS;
  }, []);

  const handleOpen = useCallback(() => {
    if (isTapInFlight()) return;
    const current = queueRef.current;
    const target = selectIncomingOrderToShow(current, skipOrderIds) ?? current[0];
    if (!target) return;
    hideFor(INCOMING_ORDER_HANDOFF_MS);
    onOpenOrders();
    requestIncomingOrderApprovalFocus(target.id);
  }, [hideFor, isTapInFlight, onOpenOrders, skipOrderIds]);

  const handleLater = useCallback(() => {
    if (isTapInFlight()) return;
    // Only the dialog steps aside: the sound keeps its rhythm and the dialog
    // comes back after one watchdog period (or at once for a new order).
    hideFor(INCOMING_ORDER_WATCHDOG_MS);
  }, [hideFor, isTapInFlight]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleLater();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (active === event.currentTarget) {
      // From the container itself (where the dialog starts): stay inside.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, [handleLater]);

  if (!overlayVisible || !head || typeof document === 'undefined') {
    return null;
  }

  const platformId = shownOrder ? platformIdOf(shownOrder) : null;
  const platformName = platformId ? getPluginName(platformId) : null;
  const accentColor = platformId ? getPluginColor(platformId) : '#F59E0B';
  const title = platformName
    ? t('incomingOrderAlert.title', { platform: platformName, defaultValue: 'New {{platform}} order' })
    : t('incomingOrderAlert.titleCustomer', { defaultValue: 'New order to accept' });
  const createdAtRaw = shownOrder ? shownOrder.created_at || shownOrder.createdAt : null;
  const receivedAt = createdAtRaw
    ? t('orderApprovalPanel.receivedAt', {
        time: formatTime(createdAtRaw, { hour: '2-digit', minute: '2-digit' }),
        defaultValue: 'Received {{time}}',
      })
    : null;
  const moreWaiting = queue.length - 1;

  return createPortal(
    <div
      ref={overlayRef}
      {...{ [MODAL_VIEWPORT_ATTR]: '' }}
      className="liquid-glass-modal-viewport"
      style={{ zIndex: INCOMING_ORDER_ALERT_Z_INDEX }}
      data-testid="incoming-order-alert-viewport"
    >
      <div className="liquid-glass-modal-backdrop" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        data-testid="incoming-order-alert"
        data-order-id={(shownOrder ?? head).id}
        data-escalated={watch.escalated ? 'true' : 'false'}
        className="liquid-glass-modal-shell flex max-w-md flex-col focus:outline-none"
        onKeyDown={handleKeyDown}
      >
        <div role="alert" className="flex items-start gap-4 px-6 pt-6">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 motion-safe:animate-pulse items-center justify-center rounded-2xl text-white shadow-lg"
            style={{ backgroundColor: accentColor }}
          >
            <BellRing className="h-7 w-7" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-600 dark:text-amber-300">
              {t('orderApprovalPanel.pendingApproval', { defaultValue: 'Pending Approval' })}
            </p>
            <h2 id={titleId} className="mt-1 text-2xl font-black leading-tight liquid-glass-modal-text">
              {title}
            </h2>
            {shownOrder ? (
              <p className="mt-1 text-base font-semibold liquid-glass-modal-text">
                {t('orderApprovalPanel.orderNumber', {
                  number: incomingOrderHeadlineNumber(shownOrder),
                  defaultValue: 'Order #{{number}}',
                })}
                {receivedAt ? (
                  <span className="font-normal liquid-glass-modal-text-muted">{` · ${receivedAt}`}</span>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>

        <div id={descriptionId} className="space-y-2 px-6 pt-4 text-sm liquid-glass-modal-text">
          <p>
            {t('incomingOrderAlert.explain', { defaultValue: 'Open it to accept or decline.' })}
          </p>
          {watch.escalated && (
            <p className="font-semibold text-amber-700 dark:text-amber-300" data-testid="incoming-order-alert-escalated">
              {t('incomingOrderAlert.waitingOver', {
                seconds: Math.round(INCOMING_ORDER_WATCHDOG_MS / 1000),
                defaultValue: 'Waiting over {{seconds}} seconds without an answer',
              })}
            </p>
          )}
          {moreWaiting > 0 && (
            <p className="font-semibold" data-testid="incoming-order-alert-more">
              {t('incomingOrderAlert.moreWaiting', {
                count: moreWaiting,
                defaultValue: '+{{count}} more orders waiting',
              })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 px-6 pb-6 pt-5 sm:flex-row-reverse">
          <button
            type="button"
            onClick={handleOpen}
            data-testid="incoming-order-alert-open"
            className={`${liquidGlassModalButton('primary', 'lg')} min-h-[56px] flex-1 text-lg font-bold`}
          >
            {t('incomingOrderAlert.open', { defaultValue: 'Open the order' })}
          </button>
          <button
            type="button"
            onClick={handleLater}
            data-testid="incoming-order-alert-later"
            className={`${liquidGlassModalButton('secondary', 'lg')} min-h-[56px] sm:w-40`}
          >
            {t('incomingOrderAlert.later', { defaultValue: 'Later' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

IncomingOrderAlertHost.displayName = 'IncomingOrderAlertHost';

export default IncomingOrderAlertHost;

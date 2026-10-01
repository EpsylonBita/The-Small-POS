/**
 * App-level owner of the incoming-order alert (orders waiting at this
 * register for accept / decline). Background: services/incomingOrderAlert.ts.
 *
 * Mounted once by App.tsx inside the HashRouter, beside the routes and never
 * inside one, while a user is logged in: no navigation unmounts it. That
 * includes /new-order, which renders NewOrderPage without the main layout
 * (TablesPage sends every dine-in order there).
 *
 * - Starts the alert loop (services/incomingOrderAlertLoop.ts) and gives it
 *   its scope: the Orders screen's own order filter, and nothing at all on a
 *   waiter terminal (mobile_waiter), as Android's PendingOrderApprovalHost.
 * - Works out where staff are: the route, and on the layout's routes the
 *   layout's current view (services/posLayoutView.ts). The Orders screen is
 *   where OrderDashboard opens the approval panel by itself.
 * - «Open the order» goes to the Orders screen: navigate('/') plus the
 *   layout's `pos:navigate-view` event; the dialog then asks the approval
 *   panel to open for that order.
 * - Renders the dialog (IncomingOrderAlertHost) inside its own error
 *   boundary, which logs what it catches and resets by itself: at once when
 *   the order it would show changes (an order whose details cannot render is
 *   skipped for the next one, or shown without details), else on a timer.
 *   The loop, outside the boundary, keeps ringing meanwhile.
 */
import React, {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Order } from '../../types/orders';
import { useModules } from '../../contexts/module-context';
import { useFeatures } from '../../hooks/useFeatures';
import { getBusinessCategory, getDashboardOrderFilter } from '../dashboards/dashboardOrderScope';
import { usePosLayoutView } from '../../services/posLayoutView';
import {
  configureIncomingOrderAlertLoop,
  logIncomingOrderAlertEvent,
  startIncomingOrderAlertLoop,
  useIncomingOrderAlertQueue,
} from '../../services/incomingOrderAlertLoop';
import { IncomingOrderAlertHost, selectIncomingOrderToShow } from './IncomingOrderAlertHost';

/**
 * Layout views that render the Orders screen (OrderDashboard and its
 * approval panel): the business dashboard, 'settings' (it shows the
 * dashboard while the settings modal opens) and the retail product catalog.
 * On these the dialog waits briefly for the panel instead of showing at once
 * (INCOMING_ORDER_PANEL_GRACE_MS): the product catalog's OrderDashboard
 * offers only retail product orders, so a food order, or one without product
 * lines, gets no panel there and the dialog shows after that grace.
 */
export const ORDERS_SCREEN_VIEWS: ReadonlySet<string> = new Set(['dashboard', 'settings', 'product_catalog']);

/** App routes rendered without the main layout (App.tsx / AppRoutes.tsx). */
export const ROUTES_WITHOUT_LAYOUT: ReadonlySet<string> = new Set(['/new-order']);

export interface IncomingOrderAlertLocation {
  /** For the log: the layout view, or the route outside the layout. */
  view: string;
  onOrdersScreen: boolean;
}

export function resolveIncomingOrderAlertLocation(
  pathname: string,
  layoutView: string | null,
): IncomingOrderAlertLocation {
  const route = pathname.replace(/\/+$/, '') || '/';
  if (ROUTES_WITHOUT_LAYOUT.has(route)) {
    return { view: route.replace(/^\/+/, ''), onOrdersScreen: false };
  }
  // The layout sets its view before paint; until it has (still loading),
  // nothing is known to be on screen, so the dialog shows.
  if (!layoutView) {
    return { view: 'layout-loading', onOrdersScreen: false };
  }
  return { view: layoutView, onOrdersScreen: ORDERS_SCREEN_VIEWS.has(layoutView) };
}

/** First retry of a dialog that failed to render; doubles up to the max. */
export const INCOMING_ORDER_ALERT_RETRY_MS = 5_000;
const INCOMING_ORDER_ALERT_RETRY_MAX_MS = 60_000;

interface IncomingOrderAlertBoundaryProps {
  /** A change (another order to show) resets a failed boundary at once. */
  resetKey: string;
  onError: (error: Error) => void;
  children: ReactNode;
}

interface IncomingOrderAlertBoundaryState {
  failed: boolean;
}

/**
 * The dialog's boundary: renders nothing while failed, logs every catch, and
 * resets by itself — when `resetKey` changes, or after a timer (5 s, then
 * doubling to 60 s while it keeps failing).
 */
export class IncomingOrderAlertBoundary extends Component<
  IncomingOrderAlertBoundaryProps,
  IncomingOrderAlertBoundaryState
> {
  state: IncomingOrderAlertBoundaryState = { failed: false };

  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private consecutiveFailures = 0;

  static getDerivedStateFromError(): IncomingOrderAlertBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.consecutiveFailures += 1;
    const delay = Math.min(
      INCOMING_ORDER_ALERT_RETRY_MAX_MS,
      INCOMING_ORDER_ALERT_RETRY_MS * 2 ** (this.consecutiveFailures - 1),
    );
    console.error(
      `[IncomingOrderAlert] the alert dialog failed to render; it retries in ${Math.round(delay / 1000)} s (the sound keeps ringing)`,
      error,
      info?.componentStack,
    );
    try {
      this.props.onError(error);
    } catch (callbackError) {
      console.error('[IncomingOrderAlert] render-error handler failed', callbackError);
    }
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ failed: false });
    }, delay);
  }

  componentDidUpdate(
    previousProps: IncomingOrderAlertBoundaryProps,
    previousState: IncomingOrderAlertBoundaryState,
  ): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.clearRetry();
      this.setState({ failed: false });
      return;
    }
    if (previousState.failed && !this.state.failed) {
      // The retry rendered: a later failure starts from the short delay.
      this.consecutiveFailures = 0;
    }
  }

  componentWillUnmount(): void {
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const NO_FAILED_ORDERS: ReadonlySet<string> = new Set();

export interface IncomingOrderAlertManagerProps {
  /** A user is logged in. */
  enabled: boolean;
}

export const IncomingOrderAlertManager: React.FC<IncomingOrderAlertManagerProps> = ({ enabled }) => {
  const { businessType } = useModules();
  const { isMobileWaiter } = useFeatures();
  const location = useLocation();
  const navigate = useNavigate();
  const layoutView = usePosLayoutView();
  const { view, onOrdersScreen } = resolveIncomingOrderAlertLocation(location.pathname, layoutView);

  const orderFilter = useMemo(
    () => getDashboardOrderFilter(getBusinessCategory(businessType)),
    [businessType],
  );
  // Waiter phones never ring or show it: the main register accepts.
  const alerting = enabled && !isMobileWaiter;

  // Scope first, then start, so the loop's first read is already scoped.
  useLayoutEffect(() => {
    configureIncomingOrderAlertLoop({ enabled: alerting, orderFilter, view });
  }, [alerting, orderFilter, view]);

  useEffect(() => (enabled ? startIncomingOrderAlertLoop() : undefined), [enabled]);

  // --- Orders whose details cannot render are skipped by the dialog. -------
  const queue = useIncomingOrderAlertQueue();
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(NO_FAILED_ORDERS);
  const skipOrderIds = useMemo(() => {
    if (failedIds.size === 0) return NO_FAILED_ORDERS;
    const queued = new Set(queue.map((order) => order.id));
    const kept = Array.from(failedIds).filter((id) => queued.has(id));
    return kept.length === failedIds.size ? failedIds : new Set(kept);
  }, [failedIds, queue]);
  const shownOrder = selectIncomingOrderToShow(queue, skipOrderIds);
  const resetKey = shownOrder ? `order:${shownOrder.id}` : queue.length > 0 ? 'without-details' : 'idle';

  const attemptRef = useRef<{ shown: Order | null; head: Order | null; view: string }>({
    shown: null,
    head: null,
    view,
  });
  attemptRef.current = { shown: shownOrder, head: queue[0] ?? null, view };

  const handleRenderError = useCallback((error: Error) => {
    const { shown, head, view: failedView } = attemptRef.current;
    const order = shown ?? head;
    if (order) {
      logIncomingOrderAlertEvent('render_error', order, {
        view: failedView,
        error: String(error?.message ?? error).slice(0, 300),
      });
    }
    if (shown) {
      const failedId = shown.id;
      setFailedIds((previous) => {
        const next = new Set(previous);
        next.add(failedId);
        return next;
      });
    }
  }, []);

  // --- «Open the order»: the Orders screen, wherever staff are. ------------
  const pathname = location.pathname;
  const handleOpenOrders = useCallback(() => {
    if (pathname !== '/') {
      navigate('/');
    }
    try {
      window.dispatchEvent(new CustomEvent('pos:navigate-view', { detail: { view: 'dashboard' } }));
    } catch (error) {
      console.warn('[IncomingOrderAlert] could not ask the layout for the Orders screen', error);
    }
  }, [navigate, pathname]);

  if (!enabled) {
    return null;
  }

  return (
    <IncomingOrderAlertBoundary resetKey={resetKey} onError={handleRenderError}>
      <IncomingOrderAlertHost
        currentView={view}
        onOrdersScreen={onOrdersScreen}
        onOpenOrders={handleOpenOrders}
        skipOrderIds={skipOrderIds}
      />
    </IncomingOrderAlertBoundary>
  );
};

IncomingOrderAlertManager.displayName = 'IncomingOrderAlertManager';

export default IncomingOrderAlertManager;

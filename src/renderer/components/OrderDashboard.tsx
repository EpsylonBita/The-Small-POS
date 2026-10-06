import React, {
  lazy,
  memo,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { commitMenuOrderEdit, menuEditRefundAction, previewMenuOrderEdit, type MenuOrderEditData, type MenuOrderEditLifecycle, type MenuEditHeaders } from '../services/MenuOrderEdit';
import {
  adoptGiftCardPaymentIds,
  claimOrdinaryCollectionOwner,
  classifyOrdinaryWrite,
  isSetAsideOrdinaryWrite,
  ledgerHasOriginalOrdinaryPayment,
  noteOrdinaryWriteFacts,
  probeOrdinaryOwner,
  readOrdinaryWriteReply,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
  runOrdinaryCollection,
  useOrderStore,
  type OrdinaryCollectionFacts,
  type OrdinaryCollectionOwner,
  type OrdinaryCollectionRun,
  type OrdinaryCollectionVerdict,
} from "../hooks/useOrderStore";
import { giftCardsApiService, type GiftCardScope } from "../services/GiftCardsApiService";
import type { GiftCardTenderEvent } from "../services/GiftCardCheckoutService";
import type { PaymentModalExistingOrder } from "./modals/PaymentModal";
import { useShift } from "../contexts/shift-context";
import { useOperationalShift } from "../contexts/cashier-gate-context";
import type { OrderItem } from "../types/orders";
import type { Customer, CustomerInfo } from "../types/customer";
import { mergeCustomerInfoModalSave } from "../utils/customerInfoModalMerge";
import OrderGrid from "./OrderGrid";
import OrderTabsBar, { type TabId } from "./OrderTabsBar";
import { TableWorkspaceToolbar, TableWorkspaceCard } from "./tables/TableWorkspace";
import BulkActionsBar from "./BulkActionsBar";
import DriverAssignmentModal from "./modals/DriverAssignmentModal";
import OrderCancellationModal, { type CancellationReturnChannel } from "./modals/OrderCancellationModal";
import { prepareManualOrderCancellation, commitManualOrderCancellation, type ManualCancellationPlan, manualCancellationFailureKey } from "../services/ManualOrderCancellation";
import EditOptionsModal from "./modals/EditOptionsModal";
import EditPaymentMethodModal, {
  type EditablePaymentRow,
} from "./modals/EditPaymentMethodModal";
import {
  EditCustomerInfoModal,
  type EditCustomerInfoFormData,
} from "./modals/EditCustomerInfoModal";
import EditOrderItemsModal from "./modals/EditOrderItemsModal";
import { CustomerSearchModal } from "./modals/CustomerSearchModal";
import { CustomerInfoModal } from "./modals/CustomerInfoModal";
import { AddCustomerModal } from "./modals/AddCustomerModal";
import { MenuModal } from "./modals/MenuModal";
import { EditOrderRefundSettlementModal } from "./modals/EditOrderRefundSettlementModal";
import {
  EditSettlementDeltaModal,
  type EditSettlementDeltaMethod,
} from "./modals/EditSettlementDeltaModal";
import { SplitPaymentModal } from "./modals/SplitPaymentModal";
import {
  OutstandingPaymentMethodModal,
  type OutstandingPaymentSelection,
} from "./modals/OutstandingPaymentMethodModal";
import {
  SinglePaymentCollectionModal,
  type SinglePaymentCollectionResult,
} from "./modals/SinglePaymentCollectionModal";
import OrderDetailsModal from "./modals/OrderDetailsModal";
import type {
  SplitPaymentCollectionMode,
  SplitPaymentResult,
} from "./modals/SplitPaymentModal";
import { OrderApprovalPanel } from "./order/OrderApprovalPanel";
import { OrderConflictBanner } from "./OrderConflictBanner";
import { LiquidGlassModal } from "./ui/pos-glass-components";
import {
  RoomStaySelectorModal,
  RoomCheckinModal,
  RoomReservationModal,
  RoomFloorChips,
  deriveRoomFloors,
} from "./modals/RoomStayWorkflowModals";
import { TableSelector, TableActionModal, TableCheckManagerModal, ReservationForm, TableFloorPlanView, TableFloorPlanModal } from "./tables";
import type { CreateReservationDto } from "./tables";
import {
  AlertTriangle,
  Banknote,
  BedDouble,
  CalendarClock,
  CalendarPlus,
  Clock3,
  DoorOpen,
  Layers,
  LayoutGrid,
  Map as MapIcon,
  Pencil,
  Plus,
  ReceiptText,
  ShoppingCart,
  UserCheck,
  Users,
  UtensilsCrossed,
  WalletCards,
  Wrench,
  Zap,
} from "lucide-react";
import TableOrderIcon from "./icons/TableOrderIcon";
import PickupOrderIcon from "./icons/PickupOrderIcon";
import { submitTableReservation } from "../utils/table-reservation-submit";
import { debugLog } from "../utils/debugLog";
import {
  reservationsService,
  type Reservation,
} from "../services/ReservationsService";
import { PrintPreviewModal } from "./modals/PrintPreviewModal";
import { FloatingActionButton } from "./ui/FloatingActionButton";
import { useTheme } from "../contexts/theme-context";
import { useI18n } from "../contexts/i18n-context";
import { isBoxOrder, runBoxApprovalDecision } from './order/box-order-decision';
import { usePaymentPrintPrompt, type PaymentPrintPromptContext } from "../hooks/usePaymentPrintPrompt";
import { MODULE_IDS, useAcquiredModules } from "../hooks/useAcquiredModules";
import { useTables } from "../hooks/useTables";
import { useRooms } from "../hooks/useRooms";
import { getRoomEffectiveStatus, type Room } from "../services/RoomsService";
import type { RoomChargeContext } from "./modals/PaymentModal";
import { useModules } from "../contexts/module-context";
import toast from "react-hot-toast";
import { OrderDashboardSkeleton } from "./skeletons";
import { ErrorDisplay } from "./error";
import type { Order } from "../types/orders";
import type { RestaurantTable, TableStatus } from "../types/tables";
import type {
  PaymentIntegrityErrorPayload,
  UnsettledPaymentBlocker,
} from "../../lib/ipc-contracts";
import type { DeliveryBoundaryValidationResponse } from "../../shared/types/delivery-validation";
import { normalizePosOrderItems } from "../../shared/utils/pos-order-items";
import { useDeliveryValidation } from "../hooks/useDeliveryValidation";
import { useResolvedPosIdentity } from "../hooks/useResolvedPosIdentity";
import { useTerminalSettings } from "../hooks/useTerminalSettings";
import { useKioskOrderAutoPrint, isKioskOrder } from "../hooks/useKioskOrderAutoPrint";
import { subscribeIncomingOrderApprovalFocus } from "../services/incomingOrderAlert";
import { noticeShortenedPreparationTime } from "../services/platformAcceptNotice";
import {
  resolveCallerIdOrderSelection,
  subscribeToCallerIdOrderIntents,
  type CallerIdOrderIntent,
  type CallerIdRequestedOrderType,
} from "../services/caller-id-order-flow";
import { openExternalUrl } from "../utils/external-url";
import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from "../utils/orderNumberUtils";
import { resolveTauriPrimaryActions } from "../primary-actions";
import {
  hasLaunchableNewWork,
  resolveDirectNewWorkCard,
  resolveNewWorkCards,
  type NewWorkCardId,
} from "../new-work-cards";
import { repairStore, useRepairStore } from "../features/repairs/store";
import { getSecureSessionSync } from "../lib/secure-session-cache";
import { formatTableDisplayNumber } from "../utils/table-display";
import {
  buildSingleDeliveryRouteStop,
  createTerminalSettingGetter,
  requestOptimizedDeliveryRoute,
  resolveSyncedBranchOriginFallback,
  resolveStoreMapOrigin,
} from "../utils/delivery-routing";
import {
  createUncheckedDeliveryZoneResult,
  resolveDeliveryFee,
} from "../utils/delivery-fee";
import { toValidLatLng } from "../utils/coordinates";
import { customerInfoEditUpdate, orderCustomerEditSnapshot, orderCreateDeliveryLocation } from "../utils/orderCustomerEdit";
import {
  MODAL_ZONE_VALIDATION_FIELD,
  MODAL_DESTINATION_UNCHANGED_FIELD,
  canKeepDeliveryZoneForCustomerEdit,
  decidePickupToDeliveryZone,
  planDeliveryAddressRepick,
  planDeliveryZoneHandoff,
  resolveHandoffCustomer,
  withoutRepickTarget,
} from "../utils/delivery-zone-handoff";
import {
  persistGeocodedSavedAddressCoordinates,
  resolveSavedAddressCoordinates,
} from "../utils/saved-address-geolocation";
import { parseSpecialAddressInput } from "../utils/specialAddress";
import { pickMeaningfulOrderCustomerName } from "../utils/orderDisplay";
import { resolveAdjustmentAttribution } from "../utils/staffAttribution";
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from "../services/terminal-credentials";
import { couponRedemptionService } from "../services/CouponRedemptionService";
import { getBridge, offEvent, onEvent } from "../../lib";
import {
  announceUnsavedCheckoutChanged,
  notifyPaymentNotSaved,
  useUnsavedCheckoutPayments,
} from "../utils/unsavedPayments";
import { UnsavedChargedPaymentBanner } from "./ui/UnsavedChargedPaymentBanner";
import { usePrivilegedActionConfirmation } from "../hooks/usePrivilegedActionConfirmation";
import { useTableReleaseGuard } from "../hooks/useTableReleaseGuard";
import {
  findCancelRefusals,
  ORDER_HAS_PAYMENTS,
  ORDER_PAYMENT_NOT_RECORDED,
} from "../utils/orderCancelGuard";
import {
  announcePlatformReadyOutcome,
  markPlatformOrdersReady,
} from "../utils/platformReadyAction";
import { useCheckoutRequestId } from "../hooks/useCheckoutRequestId";
import { getCheckoutDraftStore } from "../services/CheckoutDraftStore";
import { TableAttemptRecoveryNotice } from "./recovery/TableAttemptRecoveryNotice";
import { isCheckoutOutcomeUnknown, notifyCheckoutOutcomeUnknown } from "../utils/checkoutOutcome";
import {
  notifyMoneySettingsUnavailable,
  resolveCheckoutTaxRate,
} from "../utils/checkoutMoneySettings";
import { PAYMENT_SET_ASIDE_TOAST_MS } from "../utils/paymentSetAside";
import { formatSetAsidePaymentMessage } from "../../lib/payment-integrity";
import { isExternalPlatform } from "../utils/plugin-icons";
import type {
  EditSettlementOrderUpdates,
  OrderFinancialsUpdateParams,
  OrderEditSettlementPreview,
  OrderEditSettlementRefund,
  PickupToDeliveryConversionParams,
} from "../../lib/ipc-adapter";
import { buildSplitPaymentItems } from "../utils/splitPaymentItems";
import { resolveOrderCompletionOutcome } from "../utils/orderCompletionOutcome";
import {
  loadPersistedSplitDismissal,
  reconcileOutstandingPaymentAttempt,
  type OutstandingPaymentAttemptReconciliation,
  type PersistedSplitDismissalResolution,
} from "../utils/splitCheckoutRecovery";
import { loadPaymentEditRoute } from "../utils/paymentEditRouting";
import { repairMissingPayment } from "../utils/repairMissingPayment";
import {
  deriveEditSettlementFinancials,
  resolveEditSettlementRefundAmount,
} from "../utils/editSettlementFinancials";
import {
  calculatePickupToDeliveryTotal,
  getPickupToDeliveryValidationAmount,
  resolvePickupToDeliveryAddress,
} from "../utils/pickup-to-delivery";
import {
  isLegacyFallbackAddress,
  resolveCanonicalCustomerAddress,
  withMaterializedCustomerAddresses,
} from "../utils/customer-addresses";
import { resolvePersistedCustomerId } from "../utils/persisted-customer-id";
import { posApiPost } from "../utils/api-helpers";
import { formatCurrency } from "../utils/format";
import {
  buildOptimisticOccupiedTable,
  buildTableOrderCreateFields,
  buildTableSessionOpenPayload,
  getTableNumberForTableServiceOrder,
  isTableServiceOrder,
  isUnsettledOrderPaymentStatus,
  normalizeTableNumberForMatch,
  resolveTableDisplayStatus,
  shouldShowInCompletedOrderLane,
  shouldShowInStandardOrderLane,
  tableHasOpenCheckReference,
} from "../utils/tableOrderFlow";
import {
  enqueueTableSessionOpen,
} from "../utils/tableSessionOfflineQueue";

const RoomsView = lazy(() => import('../pages/verticals/hotel/RoomsView').then(m => ({ default: m.RoomsView })));
const AppointmentsView = lazy(() => import('../pages/verticals/salon/AppointmentsView').then(m => ({ default: m.AppointmentsView })));

interface OrderDashboardProps {
  className?: string;
  orderFilter?: (order: Order) => boolean;
}

type EditableOrderType = "pickup" | "delivery" | "dine-in";

const extractOrderDashboardErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    const candidate = error as { error?: unknown; message?: unknown };
    if (typeof candidate.error === "string" && candidate.error.trim()) {
      return candidate.error;
    }
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message;
    }
  }
  return null;
};

interface EditSettlementRequest {
  orderId: string;
  orderNumber?: string;
  items: OrderItem[];
  orderNotes?: string;
  financials?: Partial<OrderFinancialsUpdateParams>;
  orderUpdates?: Partial<EditSettlementOrderUpdates>;
}

interface PendingEditRefundSettlement {
  preview: OrderEditSettlementPreview;
  request: EditSettlementRequest;
}

type OrderFlowCustomer = Customer & {
  selected_address_id?: string | null;
  editAddressId?: string;
  city?: string | null;
  postal_code?: string | null;
  floor_number?: string | null;
  notes?: string | null;
};

interface PickupToDeliveryContext {
  orderId: string;
  orderNumber: string;
  /**
   * Controls what happens after the customer-search + address-pick flow
   * succeeds:
   *   - `'finalize'` (default, bulk-action path): calls
   *     `convertPickupOrderToDelivery` to commit the type change +
   *     delivery fee + zone validation and close the flow.
   *   - `'edit'` (Change Order Type button in EditOptionsModal): attaches
   *     the new customer + address, then reopens the menu-edit session in
   *     delivery mode so the operator can add/remove items with delivery
   *     tier pricing before saving.
   */
  mode?: 'finalize' | 'edit';
}

type StatusTransitionTarget = Extract<Order["status"], "completed" | "delivered">;

const isCancelledOrderStatus = (status: unknown): boolean => {
  const normalized = String(status || "").toLowerCase();
  return normalized === "cancelled" || normalized === "canceled";
};

interface PendingStatusPaymentCollection {
  orderId: string;
  orderNumber?: string;
  targetStatus: StatusTransitionTarget;
  method: "cash" | "card";
  blocker: UnsettledPaymentBlocker;
}

const buildCustomerInfoFromOrderFlowCustomer = (
  customer: OrderFlowCustomer,
): CustomerInfo => {
  const resolvedAddress = resolveCanonicalCustomerAddress(customer);
  // Strict: an address without coordinates has none (never (0,0)). The
  // customer-level pair only stands in when there is no saved address row.
  const coordinates =
    (resolvedAddress
      ? toValidLatLng(
          resolvedAddress.coordinates,
          resolvedAddress.latitude,
          resolvedAddress.longitude,
        )
      : toValidLatLng(customer.coordinates, customer.latitude, customer.longitude)) ??
    undefined;

  return {
    name: customer.name,
    phone: customer.phone,
    email: customer.email || "",
    address: {
      street: resolvedAddress?.street_address || customer.address || "",
      street_address: resolvedAddress?.street_address || customer.address || "",
      city: resolvedAddress?.city || customer.city || "",
      postalCode: resolvedAddress?.postal_code || customer.postal_code || "",
      postal_code: resolvedAddress?.postal_code || customer.postal_code || "",
      floor_number: resolvedAddress?.floor_number || customer.floor_number || "",
      notes: resolvedAddress?.notes || customer.notes || "",
      name_on_ringer:
        resolvedAddress?.name_on_ringer || customer.name_on_ringer || "",
      coordinates,
      latitude: coordinates?.lat ?? null,
      longitude: coordinates?.lng ?? null,
    },
    notes: resolvedAddress?.notes || customer.notes || "",
  };
};

const resolveEditableOrderType = (order: Pick<Order, "orderType" | "order_type">): EditableOrderType => {
  const rawValue = String(order.orderType || order.order_type || "pickup").trim().toLowerCase();
  if (rawValue === "delivery") {
    return "delivery";
  }
  if (rawValue === "dine-in" || rawValue === "dine_in") {
    return "dine-in";
  }
  return "pickup";
};

// Clean accessible name for an order-type chooser card: the localized title plus its
// description, but never the title twice when a locale leaves them identical (which
// produced screen-reader names like "button Παράδοση Παράδοση").
const composeOrderTypeAriaLabel = (title: string, description: string): string => {
  const cleanTitle = (title || "").trim();
  const cleanDescription = (description || "").trim();
  if (!cleanDescription || cleanDescription.toLowerCase() === cleanTitle.toLowerCase()) {
    return cleanTitle;
  }
  return `${cleanTitle}. ${cleanDescription}`;
};

const parseDateMs = (value: unknown): number | null => {
  if (!value) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const formatOccupiedSince = (value: unknown, nowMs: number): string | null => {
  const startedMs = parseDateMs(value);
  if (!startedMs) return null;

  const elapsedMinutes = Math.max(0, Math.floor((nowMs - startedMs) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const time = new Date(startedMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${time} · ${duration}`;
};

const getTableFloorValue = (table: RestaurantTable): string => {
  const raw = table.floorLevel ?? (table as any).floor_level ?? 1;
  return raw === null || raw === undefined || raw === "" ? "1" : String(raw);
};

const readTableBalance = (table: RestaurantTable) => {
  const balance = table.balance || {};
  const total = Math.max(0, Number(balance.order_total ?? 0) || 0);
  const due = Math.max(
    0,
    Number(table.unpaidBalance ?? balance.outstanding_balance ?? 0) || 0,
  );
  const paid = Math.max(
    0,
    Number(balance.paid_total ?? (total > 0 ? total - due : 0)) || 0,
  );
  const tips = Math.max(0, Number(balance.tip_total ?? 0) || 0);
  return { total, paid, due, tips };
};

/** The order type each sale card starts, as its button in the picker does. */
const NEW_WORK_ORDER_TYPES: Record<
  Extract<NewWorkCardId, "delivery" | "pickup" | "table">,
  "delivery" | "pickup" | "dine-in"
> = {
  delivery: "delivery",
  pickup: "pickup",
  table: "dine-in",
};

interface OrderPrimaryActionLauncherProps {
  /** Whether anything can be started right now (shift-aware, module-aware). */
  canOpen: boolean;
  onOpen: () => void;
}

/**
 * The (+) button. It opens ONE picker — the "new work" cards below — that
 * shows every kind of work this business can start (delivery, pickup,
 * table, room, appointment, repair, quick service), filtered by acquired
 * modules. There is deliberately no intermediate «Νέο» chooser: the picker
 * IS the choice (founder, 05/09/2026).
 */
export function OrderPrimaryActionLauncher({
  canOpen,
  onOpen,
}: OrderPrimaryActionLauncherProps) {
  const { t } = useI18n();
  return (
    <FloatingActionButton
      onClick={onOpen}
      disabled={!canOpen}
      movable
      positionStorageKey="pos-orders-new-order-fab-position"
      data-testid="tauri-primary-action-trigger"
      aria-label={t("primaryActions.trigger")}
    />
  );
}

export const OrderDashboard = memo<OrderDashboardProps>(
  ({ className = "", orderFilter }) => {
    const bridge = getBridge();
    const { t } = useI18n();
    const { askForPaymentPrint, shouldAskPaymentPrint, paymentPrintPromptModal } =
      usePaymentPrintPrompt();
    const { resolvedTheme } = useTheme();
    const {
      getSetting,
      refresh: refreshTerminalSettings,
      loaded: terminalSettingsLoaded,
      reload: reloadTerminalSettings,
    } = useTerminalSettings();
    const {
      orders,
      pendingExternalOrders,
      filter,
      setFilter,
      isLoading,
      updateOrderStatusDetailed,
      loadOrders,
      silentRefresh,
      getLastError,
      clearError,
      approveOrder,
      declineOrder,
      assignDriver,
      conflicts,
      resolveConflict,
      createOrder,
    } = useOrderStore();

    // Item E (30/09/2026): a card charged at new-order checkout whose order
    // this till could not save yet. Read from its durable record, so it is
    // back after a restart; "Save payment again" writes the order and its
    // payment with the same keys (no new charge).
    const unsavedCheckout = useUnsavedCheckoutPayments(
      true,
      t,
      formatCurrency,
      silentRefresh,
    );

    const scopedPendingExternalOrders = React.useMemo(
      () =>
        orderFilter
          ? pendingExternalOrders.filter(orderFilter)
          : pendingExternalOrders,
      [pendingExternalOrders, orderFilter],
    );

    // Module-based feature flags
    const {
      modules,
      hasDeliveryModule,
      hasTablesModule,
      hasRoomsModule,
      hasAppointmentsModule,
      hasServiceCatalogModule,
      hasModule,
    } = useAcquiredModules();
    const repairSettings = useRepairStore((state) => state.settings);
    const repairSettingsScopeBoundRef = useRef(false);
    // The scoped settings request for this session has finished, answered or
    // not: a failed load keeps Quick Service hidden but still counts as known,
    // as on Android, so a lone option can open by itself.
    const [repairSettingsLoadSettled, setRepairSettingsLoadSettled] = useState(false);
    const repairSessionId = getSecureSessionSync()?.sessionId ?? null;
    const hasRepairsModule = modules.some(
      (module) => module.isActive && module.moduleId === 'repairs',
    );
    useEffect(() => {
      if (!hasRepairsModule || !repairSessionId) {
        repairStore.getState().clearSession();
        repairSettingsScopeBoundRef.current = false;
        setRepairSettingsLoadSettled(false);
        return;
      }
      if (repairSettingsScopeBoundRef.current) return;
      repairStore.getState().clearSession();
      repairSettingsScopeBoundRef.current = true;
      setRepairSettingsLoadSettled(false);
      let cancelled = false;
      void repairStore.getState().loadSettings().catch(() => {
        // Fail closed: Quick Service remains hidden until a scoped native
        // settings projection is available.
      }).finally(() => {
        if (!cancelled) setRepairSettingsLoadSettled(true);
      });
      return () => {
        cancelled = true;
        repairSettingsScopeBoundRef.current = false;
        repairStore.getState().clearSession();
      };
    }, [hasRepairsModule, repairSessionId]);
    const primaryActions = useMemo(
      () => resolveTauriPrimaryActions(
        modules.filter((module) => module.isActive).map((module) => module.moduleId),
        repairSettingsScopeBoundRef.current
          && repairSessionId !== null
          && repairSettings?.settings.quickServiceEnabled === true,
      ),
      [modules, repairSessionId, repairSettings?.settings.quickServiceEnabled],
    );
    // Services hub is available when either the appointments or the service-catalog module is owned.
    // Round 285 (deliberately kept as OR, not tightened): the Services card opens the embedded
    // AppointmentsView booking flow, but appointment CREATION is independently guarded by the backend
    // availability/eligibility validation in handleCreateAppointment (preserved) -- so a service-catalog
    // org that lacks the appointments backend cannot actually persist a booking. Tightening this card to
    // require the appointments module specifically would hide the Services surface from service-catalog
    // orgs without backend certainty about the module taxonomy, so the gate stays OR and the real guard
    // is the booking-time validation. (Room-flow gates below stay strict per their action.)
    const hasServicesModule = hasAppointmentsModule || hasServiceCatalogModule;
    // Source-of-truth gates for the New Order -> Room workflow actions: Room Order needs Orders,
    // Create Reservation needs Reservations. Check-in stays under the Rooms module (the card gate).
    const hasOrdersModule = hasModule(MODULE_IDS.ORDERS);
    const hasReservationsModule = hasModule(MODULE_IDS.RESERVATIONS);
    // New Order modal sizing — pickup is always present; the modal must stay roomy for 4-5 cards.
    // The "what can this business start" card set is resolved once the shift
    // state is known (after useShift below) — resolveNewWorkCards is the
    // single authority for which cards exist and which are launchable.
    const hasLoyaltyModule = hasModule(MODULE_IDS.LOYALTY);

    // Delivery validation hook
    const {
      validateAddress: validateDeliveryAddress,
      requestOverride: requestDeliveryOverride,
    } = useDeliveryValidation();

    // Get organizationId from module context (with terminal cache fallback)
    const { organizationId: moduleOrgId } = useModules();
    const {
      branchId: resolvedIdentityBranchId,
      organizationId: resolvedIdentityOrganizationId,
      terminalId: resolvedTerminalId,
    } = useResolvedPosIdentity("branch+organization");

    // Announce incoming kiosk orders assigned to this terminal, and hand back
    // the printer for `handleApproveOrder` to call once the operator approves.
    // Only active when the terminal identity is resolved.
    const { printApprovedKioskOrder } = useKioskOrderAutoPrint(resolvedTerminalId);

    // Get branchId and organizationId from terminal credential cache / IPC
    const [branchId, setBranchId] = useState<string | null>(null);
    const [localOrgId, setLocalOrgId] = useState<string | null>(null);

    useEffect(() => {
      let disposed = false;

      const hydrateTerminalIdentity = async () => {
        const cached = getCachedTerminalCredentials();
        if (!disposed) {
          setBranchId(cached.branchId || null);
          setLocalOrgId(cached.organizationId || null);
        }

        const refreshed = await refreshTerminalCredentialCache();
        if (!disposed) {
          setBranchId(refreshed.branchId || null);
          setLocalOrgId(refreshed.organizationId || null);
        }
      };

      const handleConfigUpdate = (data: {
        branch_id?: string;
        organization_id?: string;
      }) => {
        if (disposed) return;
        if (typeof data?.branch_id === "string" && data.branch_id.trim()) {
          setBranchId(data.branch_id.trim());
        }
        if (
          typeof data?.organization_id === "string" &&
          data.organization_id.trim()
        ) {
          setLocalOrgId(data.organization_id.trim());
        }
      };

      hydrateTerminalIdentity();
      onEvent("terminal-config-updated", handleConfigUpdate);

      return () => {
        disposed = true;
        offEvent("terminal-config-updated", handleConfigUpdate);
      };
    }, []);

    // Use module context organizationId if available, otherwise fall back to cache
    const organizationId =
      resolvedIdentityOrganizationId || moduleOrgId || localOrgId;
    const effectiveBranchId = resolvedIdentityBranchId || branchId;

    // Fetch tables for the Tables tab - use actual IDs
    // Only enable fetching when both IDs are available
    const { tables, refetch: refetchTables, updateTableStatus } = useTables({
      branchId: effectiveBranchId || "",
      organizationId: organizationId || "",
      enabled: Boolean(effectiveBranchId && organizationId),
    });

    // Round 236: rooms data backs the Rooms hub tab count and the Room Order selector.
    // Realtime is left to the embedded RoomsView (active tab); here we only need a light,
    // stable snapshot. branchId is blanked when the module is absent so non-hotel orgs
    // never fetch rooms. Empty identity -> empty list -> count 0 (stable).
    const roomsHubEnabled = hasRoomsModule && Boolean(effectiveBranchId && organizationId);
    const {
      allRooms: hubRooms,
      stats: hubRoomStats,
      refetch: refetchHubRooms,
      updateStatus: updateHubRoomStatus,
    } = useRooms({
      branchId: roomsHubEnabled ? effectiveBranchId || "" : "",
      organizationId: roomsHubEnabled ? organizationId || "" : "",
      enableRealtime: false,
    });
    // Occupied + reserved is the operationally useful "rooms needing attention" count.
    const roomsHubCount = hubRoomStats.occupiedRooms + hubRoomStats.reservedRooms;
    // Occupied rooms that actually have an active folio can take a room-charge order.
    const roomOrderRooms = useMemo(
      () => hubRooms.filter((room) => getRoomEffectiveStatus(room) === "occupied"),
      [hubRooms],
    );
    // Floor chips for the Room Order picker filter the displayed occupied-room cards.
    // (The check-in / reservation pickers own their own floor state inside the module.)
    const [roomOrderFloor, setRoomOrderFloor] = useState<number | "all">("all");
    const roomOrderFloors = useMemo(() => deriveRoomFloors(roomOrderRooms), [roomOrderRooms]);
    const visibleRoomOrderRooms = useMemo(
      () =>
        roomOrderFloor === "all"
          ? roomOrderRooms
          : roomOrderRooms.filter((room) => room.floor === roomOrderFloor),
      [roomOrderRooms, roomOrderFloor],
    );
    // Round 238: the focused New Order -> Room check-in / reservation selectors list only the
    // eligible rooms (reserved -> check-in, available -> reservation), by effective status so the
    // candidate set matches the Rooms grid cards.
    const reservedRoomsForCheckin = useMemo(
      () => hubRooms.filter((room) => getRoomEffectiveStatus(room) === "reserved"),
      [hubRooms],
    );
    const availableRoomsForReservation = useMemo(
      () => hubRooms.filter((room) => getRoomEffectiveStatus(room) === "available"),
      [hubRooms],
    );
    const activeTableOrdersByNumber = useMemo(() => {
      const map = new Map<string, Order>();
      const activeStatuses = new Set(["pending", "confirmed", "preparing", "ready"]);

      for (const order of orders) {
        const status = String(order.status || "").toLowerCase();
        if (
          !activeStatuses.has(status) ||
          !isTableServiceOrder(order as any) ||
          !isUnsettledOrderPaymentStatus(order as any)
        ) {
          continue;
        }

        const tableNumber = getTableNumberForTableServiceOrder(order as any);
        if (tableNumber && !map.has(tableNumber)) {
          map.set(tableNumber, order);
        }
      }

      return map;
    }, [orders]);

    const displayTables = useMemo(
      () =>
        tables.map((table) => {
          const tableKey =
            normalizeTableNumberForMatch(table.tableNumber) ||
            normalizeTableNumberForMatch((table as any).number) ||
            String(table.tableNumber);
          const tableOrder = activeTableOrdersByNumber.get(tableKey);
          if (!tableOrder) {
            return table;
          }

          const optimisticTable = buildOptimisticOccupiedTable(table, {
            orderId: table.currentOrderId || tableOrder.id,
            tableSessionId:
              table.tableSessionId ||
              (tableOrder as any).tableSessionId ||
              (tableOrder as any).table_session_id ||
              null,
            guestCount:
              table.guestCount ||
              (tableOrder as any).guestCount ||
              (tableOrder as any).guest_count ||
              table.capacity ||
              1,
            occupiedSince:
              table.occupiedSince ||
              (tableOrder as any).created_at ||
              (tableOrder as any).createdAt ||
              new Date().toISOString(),
          });

          const orderTotal = Math.max(
            0,
            Number(
              (tableOrder as any).totalAmount ??
                (tableOrder as any).total_amount ??
                0,
            ) || 0,
          );
          const existingBalance = optimisticTable.balance || null;
          if (orderTotal > 0 && !existingBalance?.order_total) {
            return {
              ...optimisticTable,
              unpaidBalance: optimisticTable.unpaidBalance || orderTotal,
              balance: {
                ...(existingBalance || {}),
                order_total: orderTotal,
                paid_total: existingBalance?.paid_total ?? 0,
                tip_total: existingBalance?.tip_total ?? 0,
                outstanding_balance:
                  optimisticTable.unpaidBalance ||
                  existingBalance?.outstanding_balance ||
                  orderTotal,
                payment_status:
                  existingBalance?.payment_status ||
                  (tableOrder as any).paymentStatus ||
                  (tableOrder as any).payment_status ||
                  null,
              },
            };
          }

          return optimisticTable;
        }),
      [activeTableOrdersByNumber, tables],
    );

    // State for computed values
    const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
    const [orderCounts, setOrderCounts] = useState({
      orders: 0,
      delivered: 0,
      canceled: 0,
      tables: 0,
    });

    // State for selected orders and active tab
    const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
    const [selectionType, setSelectionType] = useState<
      "pickup" | "delivery" | null
    >(null);
    const [activeTab, setActiveTab] = useState<TabId>("orders");
    const [tableClockMs, setTableClockMs] = useState(() => Date.now());
    const [tableFloorFilter, setTableFloorFilter] = useState("all");
    const [tableStatusFilter, setTableStatusFilter] = useState<TableStatus | "all">(
      "all",
    );
    const [tableViewMode, setTableViewMode] = useState<"list" | "floorplan">(
      "list",
    );
    // Full-screen 2D plan (founder 30/08): the 2D toggle opens a modal instead
    // of squeezing the plan into the inline grid area.
    const [tableFloorPlanModalOpen, setTableFloorPlanModalOpen] = useState(false);

    // State for table order flow
    const [showTableSelector, setShowTableSelector] = useState(false);
    const [showTableActionModal, setShowTableActionModal] = useState(false);
    const [showTableCheckManager, setShowTableCheckManager] = useState(false);
    const [showReservationForm, setShowReservationForm] = useState(false);
    const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(
      null,
    );
    const [editingReservation, setEditingReservation] =
      useState<Reservation | null>(null);
    const [tableGuestCount, setTableGuestCount] = useState(1);
    const [isOrderTypeTransitioning, setIsOrderTypeTransitioning] =
      useState(false);

    const tableFloorOptions = useMemo(() => {
      const floors = Array.from(
        new Set(displayTables.map((table) => getTableFloorValue(table))),
      );
      return floors.sort((left, right) => {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
          return leftNumber - rightNumber;
        }
        return left.localeCompare(right);
      });
    }, [displayTables]);

    const effectiveTableFloorFilter =
      tableFloorFilter === "all" || tableFloorOptions.includes(tableFloorFilter)
        ? tableFloorFilter
        : "all";

    const getTableFloorLabel = useCallback(
      (floor: string) =>
        floor === "all"
          ? t("tablesDashboard.allFloors", "All floors")
          : t("tablesDashboard.floorNumber", {
              defaultValue: "Floor {{floor}}",
              floor,
            }),
      [t],
    );

    const tableStatusConfig = useMemo(() => ({
      available: { label: t("tablesDashboard.tableStatus.available", "Available") },
      occupied: { label: t("tablesDashboard.tableStatus.occupied", "Occupied") },
      reserved: { label: t("tablesDashboard.tableStatus.reserved", "Reserved") },
      cleaning: { label: t("tablesDashboard.tableStatus.cleaning", "Cleaning") },
      maintenance: { label: t("tablesDashboard.tableStatus.maintenance", "Maintenance") },
      unavailable: { label: t("tablesDashboard.tableStatus.unavailable", "Unavailable") },
    }), [t]);

    const floorScopedTables = useMemo(
      () =>
        effectiveTableFloorFilter === "all"
          ? displayTables
          : displayTables.filter(
              (table) => getTableFloorValue(table) === effectiveTableFloorFilter,
            ),
      [displayTables, effectiveTableFloorFilter],
    );

    const tableGridStats = useMemo(() => {
      const total = floorScopedTables.length;
      const occupied = floorScopedTables.filter(
        (table) => resolveTableDisplayStatus(table) === "occupied",
      ).length;
      const available = floorScopedTables.filter(
        (table) => resolveTableDisplayStatus(table) === "available",
      ).length;
      const reserved = floorScopedTables.filter(
        (table) => resolveTableDisplayStatus(table) === "reserved",
      ).length;
      const cleaning = floorScopedTables.filter(
        (table) => resolveTableDisplayStatus(table) === "cleaning",
      ).length;
      const due = floorScopedTables.reduce(
        (sum, table) => sum + readTableBalance(table).due,
        0,
      );
      return {
        total,
        occupied,
        available,
        reserved,
        cleaning,
        due,
        occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0,
      };
    }, [floorScopedTables]);

    const visibleTableCards = useMemo(
      () =>
        tableStatusFilter === "all"
          ? floorScopedTables
          : floorScopedTables.filter(
              (table) => resolveTableDisplayStatus(table) === tableStatusFilter,
            ),
      [floorScopedTables, tableStatusFilter],
    );

    // State for modals
    const [showDriverModal, setShowDriverModal] = useState(false);
    const [pendingDeliveryOrders, setPendingDeliveryOrders] = useState<
      string[]
    >([]);
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [manualCancelPlans, setManualCancelPlans] = useState<Record<string, ManualCancellationPlan>>({});
    const [pendingCancelOrders, setPendingCancelOrders] = useState<string[]>(
      [],
    );
    const [showApprovalPanel, setShowApprovalPanel] = useState(false);
    const [selectedOrderForApproval, setSelectedOrderForApproval] =
      useState<Order | null>(null);
    const [isViewOnlyMode, setIsViewOnlyMode] = useState(true); // View-only mode for order details (no approve/decline)
    // Bumped when the app-shell incoming-order alert asks for the approval
    // panel: remounting it re-appends its portal, so it lands above a dialog
    // (settings, a wizard) that had covered it.
    const [approvalPanelInstance, setApprovalPanelInstance] = useState(0);

    // State for edit modals
    const [showEditOptionsModal, setShowEditOptionsModal] = useState(false);
    const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
    const [showEditOrderModal, setShowEditOrderModal] = useState(false);
    const [showEditMenuModal, setShowEditMenuModal] = useState(false); // New: Menu-based edit modal
    const [showEditPaymentModal, setShowEditPaymentModal] = useState(false);
    const [isUpdatingPaymentMethod, setIsUpdatingPaymentMethod] =
      useState(false);
    const [isCheckingPaymentMethodEdit, setIsCheckingPaymentMethodEdit] =
      useState(false);
    const paymentMethodEditRequestRef = useRef(false);
    const [editPaymentTarget, setEditPaymentTarget] = useState<{
      orderId: string;
      orderNumber?: string;
      currentMethod: "cash" | "card";
      paymentStatus: string;
      payments: EditablePaymentRow[];
    } | null>(null);
    const [missingPaymentRepairTarget, setMissingPaymentRepairTarget] = useState<{
      orderId: string;
      orderNumber?: string;
      amount: number;
      settlementGeneration: string;
      orderType: "pickup" | "delivery" | "dine-in";
    } | null>(null);
    const [isRepairingMissingPayment, setIsRepairingMissingPayment] =
      useState(false);
    const missingPaymentRepairRef = useRef(false);
    const [pendingEditOrders, setPendingEditOrders] = useState<string[]>([]);
    const [editingSingleOrder, setEditingSingleOrder] = useState<string | null>(
      null,
    );
    const [editingOrderType, setEditingOrderType] =
      useState<EditableOrderType>("pickup"); // Track order type for editing
    // Snapshot of customer info captured when "Edit Customer Info" is clicked
    // (avoids depending on pendingEditOrders surviving the modal transition)
    const [editCustomerSnapshot, setEditCustomerSnapshot] =
      useState<EditCustomerInfoFormData | null>(null);
    const [editCustomerOrderIds, setEditCustomerOrderIds] = useState<string[]>(
      [],
    );
    const editCustomerOriginals = useRef<Record<string, EditCustomerInfoFormData>>({});

    // Store edit order details separately to persist while modal is open
    const [currentEditOrderId, setCurrentEditOrderId] = useState<
      string | undefined
    >(undefined);
    const [currentEditOrderNumber, setCurrentEditOrderNumber] = useState<
      string | undefined
    >(undefined);
    const [currentEditSupabaseId, setCurrentEditSupabaseId] = useState<
      string | undefined
    >(undefined);
    // The order type the edited order's line prices currently reflect.
    // For a plain edit this equals the order's stored type; for the
    // pickup->delivery conversion flow it is the PRE-conversion type
    // (the conversion stamps order_type before the modal reopens, so the
    // stored row can no longer tell MenuModal whether items need a retier).
    const [currentEditSourceOrderType, setCurrentEditSourceOrderType] =
      useState<string | undefined>(undefined);

    const [editHeaders, setEditHeaders] = useState<MenuEditHeaders | undefined>(undefined);

    // State for new order flow
    const [showOrderTypeModal, setShowOrderTypeModal] = useState(false);
    const [showMenuModal, setShowMenuModal] = useState(false);
    // A fresh order is a fresh draft. Remount MenuModal for every New Order
    // session so its internal cart and pickup-customer fields cannot leak
    // from the previous order.
    const [menuSessionKey, setMenuSessionKey] = useState(0);
    // The dashboard skeleton may replace the tree only until the first order
    // load has finished; afterwards refreshes render in place (see the early
    // return below) so an open MenuModal never loses its cart. The store
    // starts idle and the parent dashboard kicks off the first load from its
    // own effect (which runs after ours), so the ref arms on a loading ->
    // idle transition, never on the idle mount render.
    const hasCompletedInitialLoadRef = React.useRef(false);
    const wasLoadingRef = React.useRef(false);
    useEffect(() => {
      if (wasLoadingRef.current && !isLoading) {
        hasCompletedInitialLoadRef.current = true;
      }
      wasLoadingRef.current = isLoading;
    }, [isLoading]);
    // Round 236 (Orders hub IA migration) — Room/Service flow state.
    // roomChargeContext, when set, flows into MenuModal/PaymentModal so a dine-in order can be
    // charged to the room folio (reuses the existing room-charge payment path; no second cart).
    const [roomChargeContext, setRoomChargeContext] = useState<RoomChargeContext | null>(null);
    const [showRoomFlowModal, setShowRoomFlowModal] = useState(false);
    const [showRoomOrderSelector, setShowRoomOrderSelector] = useState(false);
    // Round 238: Check-in / Create Reservation run through focused, purpose-built selector + form
    // modules (NOT an embedded RoomsView / hubPreset). The selector lists only the eligible rooms;
    // tapping one mounts the matching check-in / reservation form for that room.
    const [showRoomCheckinSelector, setShowRoomCheckinSelector] = useState(false);
    const [showRoomReservationSelector, setShowRoomReservationSelector] = useState(false);
    const [checkinRoom, setCheckinRoom] = useState<Room | null>(null);
    const [reservationRoom, setReservationRoom] = useState<Room | null>(null);
    // Bumped to open the embedded AppointmentsView Create modal from New Order -> Services.
    const [servicesOpenCreateSignal, setServicesOpenCreateSignal] = useState(0);
    const [selectedOrderType, setSelectedOrderType] = useState<
      "pickup" | "delivery" | "dine-in" | null
    >(null);
    const [pendingCallerIdOrderType, setPendingCallerIdOrderType] =
      useState<CallerIdRequestedOrderType | null>(null);

    // State for split payment flow (rendered independently of MenuModal)
    const [splitPaymentData, setSplitPaymentData] = useState<{
      kind: "new-order" | "edit-settlement" | "status-blocker";
      orderId: string;
      orderTotal: number;
      existingPayments?: any[];
      items: Array<{
        name: string;
        quantity: number;
        price: number;
        totalPrice: number;
        itemIndex: number;
      }>;
      isGhostOrder: boolean;
      initialMode?: "by-amount" | "by-items";
      collectionMode?: SplitPaymentCollectionMode;
      statusAfterCollection?: StatusTransitionTarget;
      orderNumber?: string;
      orderType?: "pickup" | "delivery" | "dine-in";
      tipAmount?: number;
      tipRecipientRole?: "waiter" | "cashier" | "driver";
      tipRecipientStaffId?: string;
      tipRecipientStaffShiftId?: string;
      recoverySession?: number;
      settlementGeneration?: string;
    } | null>(null);
    const [outstandingPaymentData, setOutstandingPaymentData] = useState<{
      orderId: string;
      orderTotal: number;
      outstandingAmount: number;
      existingPayments: any[];
      items: Array<{
        name: string;
        quantity: number;
        price: number;
        totalPrice: number;
        itemIndex: number;
      }>;
      isGhostOrder: boolean;
      orderNumber?: string;
      orderType: "pickup" | "delivery" | "dine-in";
      tipAmount?: number;
      tipRecipientRole?: "waiter" | "cashier" | "driver";
      tipRecipientStaffId?: string;
      tipRecipientStaffShiftId?: string;
      recoverySession?: number;
      settlementGeneration: string;
    } | null>(null);
    const [isProcessingOutstandingPayment, setIsProcessingOutstandingPayment] =
      useState(false);
    const [isReconcilingSplitClose, setIsReconcilingSplitClose] =
      useState(false);
    const [singlePaymentCollectionData, setSinglePaymentCollectionData] =
      useState<PendingStatusPaymentCollection | null>(null);

    // Ordinary cash/card collection and the gift tender share one scope: the
    // resolved organization and this terminal's public id. A missing value
    // fails closed in the shared collection controller.
    const collectionScope = useMemo<GiftCardScope>(
      () => ({
        organizationId: resolvedIdentityOrganizationId ?? null,
        terminalId: resolvedTerminalId ?? null,
      }),
      [resolvedIdentityOrganizationId, resolvedTerminalId],
    );
    const ordinaryRefusalText = useCallback(
      (code: string) =>
        code === "GIFT_CARD_TERMINAL_SCOPE_REQUIRED"
          ? t(
              "giftCardCheckout.refusal.scope",
              "This terminal has no confirmed organization or terminal identity. Pair the POS again.",
            )
          : t(
              "giftCardCheckout.refusal.admission",
              "Earlier gift card attempts must be checked first.",
            ),
      [t],
    );
    // Verdict of one outstanding write from its raw reply facts; a lost or
    // ambiguous reply completes only on the original's own ledger row.
    const judgeOrdinaryAttempt = useCallback(
      (
        owner: OrdinaryCollectionOwner,
        attempt: OutstandingPaymentAttemptReconciliation,
      ): OrdinaryCollectionVerdict => {
        const facts: OrdinaryCollectionFacts = {
          replyLost: attempt.attempt.replyLost,
          success: attempt.attempt.success,
          paymentApproved: attempt.attempt.paymentApproved,
          paymentPersisted: attempt.attempt.paymentPersisted,
          requiresReconciliation: attempt.attempt.requiresReconciliation,
          paymentId: attempt.attempt.paymentId,
          code: attempt.attempt.code,
        };
        noteOrdinaryWriteFacts(owner, facts);
        const verdict = classifyOrdinaryWrite(facts);
        if (
          verdict === "unknown" &&
          "settlement" in attempt &&
          ledgerHasOriginalOrdinaryPayment(owner, attempt.settlement.completedPayments)
        ) {
          return "completed";
        }
        return verdict;
      },
      [],
    );

    // Browser and native connectivity, as the gift card surfaces read it.
    const [browserOnline, setBrowserOnline] = useState(
      () => typeof navigator === "undefined" || navigator.onLine !== false,
    );
    const [nativeOnline, setNativeOnline] = useState(true);
    useEffect(() => {
      let disposed = false;
      const goOnline = () => setBrowserOnline(true);
      const goOffline = () => setBrowserOnline(false);
      const applyNativeStatus = (status: unknown) => {
        const flag =
          status && typeof status === "object"
            ? (status as { isOnline?: unknown }).isOnline
            : undefined;
        if (!disposed && typeof flag === "boolean") setNativeOnline(flag);
      };
      window.addEventListener("online", goOnline);
      window.addEventListener("offline", goOffline);
      onEvent("network:status", applyNativeStatus);
      void Promise.resolve()
        .then(() => getBridge().sync.getNetworkStatus())
        .then(applyNativeStatus)
        .catch(() => undefined);
      return () => {
        disposed = true;
        window.removeEventListener("online", goOnline);
        window.removeEventListener("offline", goOffline);
        offEvent("network:status", applyNativeStatus);
      };
    }, []);

    // Epoch of the outstanding-payment target: bumped when its order or the
    // collection scope changes and on unmount, so a late continuation never
    // touches a newer target's UI.
    const outstandingEpochRef = useRef(0);
    const outstandingTargetOrderId = outstandingPaymentData?.orderId ?? null;
    const [outstandingGiftCurrency, setOutstandingGiftCurrency] = useState<{
      orderId: string;
      currency: string | null;
    } | null>(null);
    const [giftSettledOrderId, setGiftSettledOrderId] = useState<string | null>(null);
    const giftEventQueueRef = useRef<Promise<void>>(Promise.resolve());
    // Gift-paid orders whose receipt may still need the Tender's finalize,
    // reconcile or recheck after the payment modal closed: nonsecret order
    // context only, in memory. After a restart the native journal governs.
    const [giftReceiptRecoveries, setGiftReceiptRecoveries] = useState<
      Array<NonNullable<typeof outstandingPaymentData>>
    >([]);
    const [giftReceiptReentryOrderId, setGiftReceiptReentryOrderId] = useState<string | null>(null);
    const giftFiscalNextRef = useRef<{ orderId: string; nextAction: string } | null>(null);
    // Order whose ordinary write landed before its ledger could be read.
    const ordinaryLandedRef = useRef<string | null>(null);

    useEffect(() => {
      const epoch = outstandingEpochRef.current;
      setOutstandingGiftCurrency(null);
      setGiftSettledOrderId(null);
      // A new target or scope never inherits an older target's processing state.
      setIsProcessingOutstandingPayment(false);
      if (outstandingTargetOrderId) {
        // Read fresh for every opened target; a failed read leaves no currency.
        void giftCardsApiService
          .getStatus()
          .then((status) => (status.ok ? status.data.currency : null))
          .catch(() => null)
          .then((currency) => {
            if (outstandingEpochRef.current !== epoch) return;
            setOutstandingGiftCurrency({ orderId: outstandingTargetOrderId, currency });
          });
      }
      return () => {
        outstandingEpochRef.current += 1;
      };
    }, [collectionScope, outstandingTargetOrderId]);

    const outstandingOrderSynced = useMemo(() => {
      if (!outstandingTargetOrderId) return false;
      const order = orders.find((candidate) => candidate.id === outstandingTargetOrderId);
      const remoteId = String(order?.supabase_id ?? order?.supabaseId ?? "").trim();
      return Boolean(remoteId) && (order?.sync_status ?? order?.syncStatus) === "synced";
    }, [orders, outstandingTargetOrderId]);
    const [pendingEditRefundSettlement, setPendingEditRefundSettlement] =
      useState<PendingEditRefundSettlement | null>(null);
    // Drives the new small "cash or card?" modal shown after a paid-order
    // edit produces a non-zero delta. Positive delta → mode 'collect'
    // (extra to collect from the customer). Negative delta → mode 'refund'
    // (money owed back to the customer). Zero-delta edits skip this modal
    // entirely and commit directly. This supersedes the previous routing
    // through SplitPaymentModal (kind 'edit-settlement') and
    // EditOrderRefundSettlementModal for edit-settlement cases; those
    // components remain mounted for safety but are no longer the primary
    // UX path. See plan at
    // D:/The-Small-002/planning/claude/rustling-chasing-puzzle.md.
    const [editSettlementDeltaPrompt, setEditSettlementDeltaPrompt] = useState<{
      mode: "collect" | "refund";
      amount: number;
      orderNumber?: string | null;
      preview: OrderEditSettlementPreview;
      request: EditSettlementRequest;
      menuCommit?: {
        data: MenuOrderEditData;
        lifecycle: MenuOrderEditLifecycle;
        resolve(): void;
        reject(error: Error): void;
      };
    } | null>(null);

    // State for delivery flow
    const [showPhoneLookupModal, setShowPhoneLookupModal] = useState(false);
    const [showCustomerInfoModal, setShowCustomerInfoModal] = useState(false);
    const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
    const [customerModalMode, setCustomerModalMode] = useState<
      "new" | "edit" | "addAddress" | "editAddress"
    >("new");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [isLookingUp, setIsLookingUp] = useState(false);
    const [existingCustomer, setExistingCustomer] = useState<Customer | null>(
      null,
    );
    const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
    const [orderType, setOrderType] = useState<
      "dine-in" | "pickup" | "delivery"
    >("pickup");
    const [tableNumber, setTableNumber] = useState("");
    const [specialInstructions, setSpecialInstructions] = useState("");
    const [isValidatingAddress, setIsValidatingAddress] = useState(false);
    const [addressValid, setAddressValid] = useState(false);
    const [deliveryZoneInfo, setDeliveryZoneInfo] =
      useState<DeliveryBoundaryValidationResponse | null>(null);

    // Receipt preview state
    const [receiptPreviewHtml, setReceiptPreviewHtml] = useState<string | null>(
      null,
    );
    const [showReceiptPreview, setShowReceiptPreview] = useState(false);
    const [receiptPreviewOrderId, setReceiptPreviewOrderId] = useState<
      string | null
    >(null);
    const [receiptPreviewPrinting, setReceiptPreviewPrinting] = useState(false);
    const [pickupToDeliveryContext, setPickupToDeliveryContext] =
      useState<PickupToDeliveryContext | null>(null);

    // Bulk action loading state
    const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);

    // Refs for click-outside detection to auto-close bulk actions bar
    const bulkActionsBarRef = useRef<HTMLDivElement>(null);
    const orderGridRef = useRef<HTMLDivElement>(null);
    const tableGridScrollRef = useRef<HTMLDivElement>(null);
    const shiftRefreshArmedRef = useRef(false);
    const splitPaymentCompletedRef = useRef<SplitPaymentResult | null>(null);
    const splitCloseRecoveryRef = useRef(false);
    const callerIdOrderIntentRef = useRef<CallerIdOrderIntent | null>(null);

    useEffect(() => subscribeToCallerIdOrderIntents((intent) => {
      const callerCustomer = intent.customer
        ? withMaterializedCustomerAddresses(
            intent.customer as unknown as OrderFlowCustomer,
          ) as OrderFlowCustomer
        : null;

      callerIdOrderIntentRef.current = intent;
      setMenuSessionKey((session) => session + 1);
      setExistingCustomer(callerCustomer);
      setCustomerInfo(
        callerCustomer
          ? buildCustomerInfoFromOrderFlowCustomer(callerCustomer)
          : null,
      );
      setPhoneNumber(intent.canonicalPhone);
      setSpecialInstructions(
        callerCustomer
          ? buildCustomerInfoFromOrderFlowCustomer(callerCustomer).notes || ""
          : "",
      );
      setSelectedOrderType(null);
      setOrderType("pickup");
      setDeliveryZoneInfo(null);
      setRoomChargeContext(null);
      setShowPhoneLookupModal(false);
      setShowAddCustomerModal(false);
      setShowMenuModal(false);
      setShowRoomFlowModal(false);
      setShowTableSelector(false);
      setActiveTab("orders");
      setPendingCallerIdOrderType(intent.requestedOrderType ?? null);
      setShowOrderTypeModal(!intent.requestedOrderType);
    }), []);

    const handleTableGridWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      const scrollTarget = tableGridScrollRef.current;
      if (!scrollTarget) {
        return;
      }

      const maxScrollTop = scrollTarget.scrollHeight - scrollTarget.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }

      const deltaY =
        event.deltaMode === 1
          ? event.deltaY * 40
          : event.deltaMode === 2
            ? event.deltaY * scrollTarget.clientHeight
            : event.deltaY;
      const nextScrollTop = Math.max(
        0,
        Math.min(scrollTarget.scrollTop + deltaY, maxScrollTop),
      );

      event.preventDefault();
      event.stopPropagation();
      scrollTarget.scrollTop = nextScrollTop;
    }, []);

    // Reset the table-card scroll region to the top whenever the active status
    // filter, floor filter, or view mode changes. Without this, switching to a
    // narrow filter (e.g. "cleaning" with a single result) keeps the previous
    // scrollTop, so the filtered card renders clipped under the fixed status/
    // floor controls. Keyed on the filter/view inputs rather than the visible
    // card set so live table updates don't yank the scroll position mid-scroll.
    useEffect(() => {
      const scrollTarget = tableGridScrollRef.current;
      if (scrollTarget) {
        scrollTarget.scrollTop = 0;
      }
    }, [tableStatusFilter, effectiveTableFloorFilter, tableViewMode]);

    const singlePaymentReasonCodes = useMemo(
      () =>
        new Set([
          "missing_cash_payment",
          "missing_card_payment",
          "missing_local_payment_row",
          "partial_cash_payment",
          "partial_card_payment",
        ]),
      [],
    );

    // Ref to track if menu modals are open (used in interval callback to avoid re-creating interval)
    const isMenuModalOpenRef = React.useRef(false);
    useEffect(() => {
      isMenuModalOpenRef.current = showMenuModal || showEditMenuModal;
    }, [showMenuModal, showEditMenuModal]);

    const getSelectionTypeForOrders = useCallback(
      (
        orderIds: string[],
        orderList: Order[],
      ): "pickup" | "delivery" | null => {
        if (orderIds.length === 0) {
          return null;
        }

        const selectedOrderMap = new Map(
          orderList.map((order) => [order.id, order]),
        );
        const selectedOrderTypes = orderIds
          .map((id) => selectedOrderMap.get(id))
          .filter((order): order is Order => Boolean(order))
          .map((order) =>
            order.orderType === "delivery" ? "delivery" : "pickup",
          );

        if (selectedOrderTypes.length === 0) {
          return null;
        }

        return selectedOrderTypes.includes("delivery") ? "delivery" : "pickup";
      },
      [],
    );

    const clearBulkSelection = useCallback(() => {
      setSelectedOrders([]);
      setSelectionType(null);
    }, []);

    const selectedOrderObjects = React.useMemo(
      () => orders.filter((order) => selectedOrders.includes(order.id)),
      [orders, selectedOrders],
    );

    const selectedSinglePickupOrder = React.useMemo(() => {
      if (selectedOrderObjects.length !== 1) {
        return null;
      }
      const [selectedOrder] = selectedOrderObjects;
      const orderTypeValue =
        selectedOrder?.orderType || selectedOrder?.order_type;
      return orderTypeValue === "pickup" ? selectedOrder : null;
    }, [selectedOrderObjects]);

    const selectedDeliveryOrders = React.useMemo(
      () =>
        selectedOrderObjects.filter((order) => order.orderType === "delivery"),
      [selectedOrderObjects],
    );

    const storeMapOrigin = React.useMemo(
      () => resolveStoreMapOrigin(getSetting),
      [getSetting],
    );
    const syncedBranchOriginFallback = React.useMemo(
      () => resolveSyncedBranchOriginFallback(getSetting, effectiveBranchId),
      [effectiveBranchId, getSetting],
    );

    const deliverySelectionCanBeCompleted = React.useMemo(
      () =>
        selectedDeliveryOrders.length > 0 &&
        selectedDeliveryOrders.every((order) => {
          const status = String(order.status || "").toLowerCase();
          return status === "out_for_delivery";
        }),
      [selectedDeliveryOrders],
    );

    // «Έτοιμη» (THE-435): visible only when every selected order is a platform
    // order still able to advance to 'ready' — pressing it relays the
    // platform's prepared/ready call, which is what summons their rider.
    const platformReadySelectionEligible = React.useMemo(
      () =>
        selectedOrderObjects.length > 0 &&
        selectedOrderObjects.every((order) => {
          if (isBoxOrder(order)) return false;
          const plugin =
            order.plugin ||
            order.order_plugin ||
            order.platform ||
            order.order_platform;
          const externalId =
            order.external_plugin_order_id || order.external_platform_order_id;
          if (!plugin || !externalId || !isExternalPlatform(String(plugin))) {
            return false;
          }
          const status = String(order.status || "").toLowerCase();
          return ["pending", "confirmed", "preparing"].includes(status);
        }),
      [selectedOrderObjects],
    );

    const resetPickupToDeliveryFlow = useCallback(() => {
      setPickupToDeliveryContext(null);
      setExistingCustomer(null);
      setCustomerInfo(null);
      setPhoneNumber("");
      setCustomerModalMode("new");
      setShowPhoneLookupModal(false);
      setShowAddCustomerModal(false);
      setDeliveryZoneInfo(null);
      setSpecialInstructions("");
    }, []);

    const closeCustomerSearchModal = useCallback(() => {
      if (pickupToDeliveryContext) {
        const wasEditMode = pickupToDeliveryContext.mode === "edit";
        resetPickupToDeliveryFlow();
        // If the flow was opened from the EditOptionsModal "Change Order
        // Type → Delivery" entry point, bounce back to that modal so the
        // operator can pick a different action instead of landing on the
        // bare dashboard.
        if (wasEditMode) {
          setShowEditOptionsModal(true);
        }
        return;
      }
      setShowPhoneLookupModal(false);
    }, [pickupToDeliveryContext, resetPickupToDeliveryFlow]);

    // Opened from the menu's "delivery zone not checked" notice: closing it
    // without saving must keep the order's customer and cart as they were.
    const menuAddressRepickRef = useRef(false);

    const handleRepickDeliveryAddress = useCallback(() => {
      const customer = existingCustomer as OrderFlowCustomer | null;
      const repick = planDeliveryAddressRepick(
        customer,
        customer ? resolveCanonicalCustomerAddress(customer) : null,
      );
      if (repick.kind === "edit_address") {
        menuAddressRepickRef.current = true;
        setExistingCustomer(repick.customer as OrderFlowCustomer);
        setCustomerModalMode("editAddress");
        setShowAddCustomerModal(true);
        return;
      }
      // A walk-in delivery without a saved address row: the order's own
      // address form picks the street again.
      setShowCustomerInfoModal(true);
    }, [existingCustomer]);

    const closeAddCustomerModal = useCallback(() => {
      if (menuAddressRepickRef.current) {
        // Closed without saving: keep the order's customer and cart.
        menuAddressRepickRef.current = false;
        setShowAddCustomerModal(false);
        setExistingCustomer((current) =>
          withoutRepickTarget(current as OrderFlowCustomer | null) as typeof current,
        );
        setCustomerModalMode("new");
        return;
      }
      if (pickupToDeliveryContext) {
        const wasEditMode = pickupToDeliveryContext.mode === "edit";
        resetPickupToDeliveryFlow();
        if (wasEditMode) {
          setShowEditOptionsModal(true);
        }
        return;
      }
      setShowAddCustomerModal(false);
      setExistingCustomer(null);
      setCustomerModalMode("new");
    }, [pickupToDeliveryContext, resetPickupToDeliveryFlow]);

    // Click-outside handler to auto-close bulk actions bar
    useEffect(() => {
      // Only add listener when there are selected orders
      if (selectedOrders.length === 0) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node;

        // Check if click is inside the bulk actions bar
        if (bulkActionsBarRef.current?.contains(target)) {
          return;
        }

        // Check if click is inside the order grid (allows selecting other orders)
        if (orderGridRef.current?.contains(target)) {
          return;
        }

        // Check if click is inside any modal (don't close while modals are open)
        const isInsideModal = (target as Element).closest?.(
          '[role="dialog"], .modal, [data-modal]',
        );
        if (isInsideModal) {
          return;
        }

        // Check if click is on the FAB (new order button)
        const isOnFab = (target as Element).closest?.("button.fixed");
        if (isOnFab) {
          return;
        }

        // Clear selection when clicking outside
        clearBulkSelection();
      };

      // Use mousedown for immediate response (before any other click handlers)
      document.addEventListener("mousedown", handleClickOutside);

      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }, [clearBulkSelection, selectedOrders.length]);

    useEffect(() => {
      if (activeTab === "tables") {
        if (selectedOrders.length > 0 || selectionType !== null) {
          clearBulkSelection();
        }
        return;
      }

      const visibleOrderIds = new Set(filteredOrders.map((order) => order.id));
      const nextSelectedOrders = selectedOrders.filter((orderId) =>
        visibleOrderIds.has(orderId),
      );

      if (nextSelectedOrders.length !== selectedOrders.length) {
        setSelectedOrders(nextSelectedOrders);
        setSelectionType(
          getSelectionTypeForOrders(nextSelectedOrders, filteredOrders),
        );
        return;
      }

      const nextSelectionType = getSelectionTypeForOrders(
        nextSelectedOrders,
        filteredOrders,
      );
      if (nextSelectionType !== selectionType) {
        setSelectionType(nextSelectionType);
      }
    }, [
      activeTab,
      clearBulkSelection,
      filteredOrders,
      getSelectionTypeForOrders,
      selectedOrders,
      selectionType,
    ]);

    // Shift activation refresh (event-driven steady state)
    // We avoid continuous polling and perform a single silent refresh when a
    // shift becomes active (or when blocked modals close after activation).
    const { isShiftActive, staff, activeShift } = useShift();
    const isOperationalShiftActive = useOperationalShift(isShiftActive);
    // One picker for every kind of work this business can start (founder,
    // 05/09/2026): the cards below are the whole story — delivery, pickup,
    // table, room, appointment, repair, quick service — filtered by acquired
    // modules and gated by the cash shift where money moves.
    const newWorkCards = resolveNewWorkCards({
      hasOrdersModule,
      hasDeliveryModule,
      hasTablesModule,
      hasRoomsModule,
      hasServicesModule,
      primaryActions,
      isShiftActive: isOperationalShiftActive,
    });
    const newWorkCard = (id: NewWorkCardId) => newWorkCards.find((card) => card.id === id);
    const canLaunchNewWork = hasLaunchableNewWork(newWorkCards);
    // Every option is known once the scoped repair settings request finished
    // (Quick Service may add a card); only then may a lone option open by itself.
    const newWorkOptionsSettled = !hasRepairsModule || repairSettingsLoadSettled;
    const visibleOrderTypeCardCount = newWorkCards.length;
    const orderTypeModalWidthClass =
      visibleOrderTypeCardCount >= 5
        ? "!max-w-5xl"
        : visibleOrderTypeCardCount === 4
          ? "!max-w-4xl"
          : visibleOrderTypeCardCount === 3
            ? "!max-w-3xl"
            : visibleOrderTypeCardCount === 2
              ? "!max-w-xl"
              : "!max-w-lg";
    // Round 322 layout, extended to seven cards: from five cards up the lg
    // track has six columns and every card spans two, so rows read as 3+2
    // (fifth card starts at column 2), 3+3, or 3+3+1 (seventh card centred at
    // column 3) — never a 3+1 / 4+1 orphan in the bottom-right hole.
    const orderTypeGridColsClass =
      visibleOrderTypeCardCount >= 5
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-6"
        : visibleOrderTypeCardCount === 4
          ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
          : visibleOrderTypeCardCount === 3
            ? "grid-cols-1 sm:grid-cols-3"
            : visibleOrderTypeCardCount === 2
              ? "grid-cols-2"
              : "grid-cols-1";
    const orderTypeCardSpanClass = (visibleIndex: number): string =>
      visibleOrderTypeCardCount >= 5
        ? visibleIndex === 4 && visibleOrderTypeCardCount === 5
          ? "lg:col-span-2 lg:col-start-2"
          : visibleIndex === 6
            ? "lg:col-span-2 lg:col-start-3"
            : "lg:col-span-2"
        : "";
    // Visible indices come from the resolver's live card order (delivery,
    // pickup, table, room, service, repair, quick service), so the span
    // helper is correct for any module combination without card-name math.
    const deliveryCardVisibleIndex = newWorkCard("delivery")?.visibleIndex ?? 0;
    const pickupCardVisibleIndex = newWorkCard("pickup")?.visibleIndex ?? 0;
    const tableCardVisibleIndex = newWorkCard("table")?.visibleIndex ?? 0;
    const roomCardVisibleIndex = newWorkCard("room")?.visibleIndex ?? 0;
    const serviceCardVisibleIndex = newWorkCard("service")?.visibleIndex ?? 0;
    const repairCardVisibleIndex = newWorkCard("repair")?.visibleIndex ?? 0;
    const quickServiceCardVisibleIndex = newWorkCard("quick_service")?.visibleIndex ?? 0;
    const newWorkCardStateClass = (id: NewWorkCardId): string =>
      newWorkCard(id)?.enabled === false ? " opacity-55 cursor-not-allowed" : "";
    useEffect(() => {
      if (!isShiftActive) {
        shiftRefreshArmedRef.current = false;
        return;
      }

      if (isMenuModalOpenRef.current) {
        return;
      }

      if (shiftRefreshArmedRef.current) {
        return;
      }

      shiftRefreshArmedRef.current = true;
      void silentRefresh();
    }, [isShiftActive, showMenuModal, showEditMenuModal, silentRefresh]);

    useEffect(() => {
      const processCouponQueue = () => {
        couponRedemptionService.processQueue().catch((error) => {
          console.warn(
            "[OrderDashboard] Coupon redemption retry failed:",
            error,
          );
        });
      };

      processCouponQueue();
      const intervalId = window.setInterval(processCouponQueue, 30000);
      window.addEventListener("online", processCouponQueue);

      return () => {
        window.clearInterval(intervalId);
        window.removeEventListener("online", processCouponQueue);
      };
    }, []);

    // Auto-open the approval panel for pending platform / customer orders
    // (queue head first). The sound is NOT played here: the App-level alert
    // loop (services/incomingOrderAlertLoop.ts) owns it on every page, this
    // screen included, and its dialog watches for this panel (its header carries
    // INCOMING_ORDER_APPROVAL_MARKER_ATTR) to know the order is on screen.
    // See services/incomingOrderAlert.ts (Tomikro, 30/09/2026).
    useEffect(() => {
      if (
        !scopedPendingExternalOrders ||
        scopedPendingExternalOrders.length === 0
      ) {
        return;
      }

      const nextOrder = scopedPendingExternalOrders[0];
      if (!nextOrder) return;

      if (
        !showApprovalPanel ||
        (isViewOnlyMode && selectedOrderForApproval?.id !== nextOrder.id)
      ) {
        setSelectedOrderForApproval(nextOrder);
        setIsViewOnlyMode(false);
        setShowApprovalPanel(true);
      }
    }, [
      scopedPendingExternalOrders,
      showApprovalPanel,
      isViewOnlyMode,
      selectedOrderForApproval,
    ]);

    // «Open the order» on the app-shell alert: show this order's approval
    // panel now, on top, even if a details view or another dialog is open.
    const scopedPendingExternalOrdersRef = useRef(scopedPendingExternalOrders);
    scopedPendingExternalOrdersRef.current = scopedPendingExternalOrders;
    useEffect(
      () =>
        subscribeIncomingOrderApprovalFocus((orderId) => {
          const queue = scopedPendingExternalOrdersRef.current;
          const target =
            queue.find((order) => order.id === orderId) ?? queue[0];
          if (!target) return;
          setSelectedOrderForApproval(target);
          setIsViewOnlyMode(false);
          setShowApprovalPanel(true);
          setApprovalPanelInstance((instance) => instance + 1);
        }),
      [],
    );

    useEffect(() => {
      if (!displayTables.some((table) => tableHasOpenCheckReference(table) && table.occupiedSince)) {
        return;
      }

      const timer = window.setInterval(() => setTableClockMs(Date.now()), 60000);
      return () => window.clearInterval(timer);
    }, [displayTables]);

    // Update computed values when dependencies change
    useEffect(() => {
      if (!orders) return;

      const baseOrders = orderFilter ? orders.filter(orderFilter) : orders;

      // Filter orders based on active tab and global filters
      let filtered = baseOrders;

      // Apply global filters first
      if (filter.status && filter.status !== "all") {
        filtered = filtered.filter((order) => {
          if (filter.status === "cancelled" || filter.status === "canceled") {
            return isCancelledOrderStatus(order.status);
          }

          return order.status === filter.status;
        });
      }

      if (filter.orderType && filter.orderType !== "all") {
        filtered = filtered.filter(
          (order) => order.orderType === filter.orderType,
        );
      }

      if (filter.searchTerm) {
        const searchTerm = filter.searchTerm.toLowerCase();
        filtered = filtered.filter(
          (order) =>
            order.orderNumber.toLowerCase().includes(searchTerm) ||
            order.customerName?.toLowerCase().includes(searchTerm) ||
            order.customerPhone?.includes(searchTerm),
        );
      }

      // Live table checks use the Tables tab while its module is available.
      // Completion history always includes every fulfillment type.
      const laneOptions = { tablesModuleAvailable: hasTablesModule };

      switch (activeTab) {
        case "orders":
          filtered = filtered.filter((order) =>
            shouldShowInStandardOrderLane(order as any, laneOptions),
          );
          break;
        case "delivered":
          filtered = filtered.filter((order) =>
            shouldShowInCompletedOrderLane(order as any),
          );
          break;
        case "canceled":
          filtered = filtered.filter((order) => isCancelledOrderStatus(order.status));
          break;
      }

      setFilteredOrders(filtered);

      // Calculate order counts for tabs
      const openTableCount = displayTables.filter(tableHasOpenCheckReference).length;
      const counts = {
        orders: 0,
        delivered: 0,
        canceled: 0,
        tables: openTableCount,
      };

      // Counters call the same lane predicates as the lists above, so a tab's
      // badge can never disagree with what that tab renders.
      baseOrders.forEach((order) => {
        if (shouldShowInStandardOrderLane(order as any, laneOptions)) {
          counts.orders++;
          return;
        }

        if (shouldShowInCompletedOrderLane(order as any)) {
          counts.delivered++;
          return;
        }

        if (isCancelledOrderStatus(order.status)) {
          counts.canceled++;
        }
      });

      setOrderCounts(counts);
      // hasTablesModule is a dependency: acquiring or losing the module has to
      // move the orders between the lanes and the Tables tab immediately, with
      // no restart.
    }, [orders, filter, activeTab, orderFilter, displayTables, hasTablesModule]);

    // Handle tab change
    const handleTabChange = useCallback(
      (tab: TabId) => {
        // Source-of-truth gate: ignore taps on module tabs whose module is not acquired, so a stale
        // or out-of-band tab id can never surface a disabled vertical's content.
        if (tab === "tables" && !hasTablesModule) return;
        if (tab === "rooms" && !hasRoomsModule) return;
        if (tab === "services" && !hasServicesModule) return;
        setActiveTab(tab);
        clearBulkSelection();
        // Ensure global status filter doesn't hide tab contents
        try {
          setFilter({ status: "all" });
        } catch {}
      },
      [clearBulkSelection, setFilter, hasTablesModule, hasRoomsModule, hasServicesModule],
    );

    // If the active vertical tab's module becomes unavailable while selected (e.g. a module is
    // revoked mid-session), fall back to the always-available Orders tab so no dead/disabled
    // vertical content stays mounted.
    useEffect(() => {
      if (
        (activeTab === "tables" && !hasTablesModule) ||
        (activeTab === "rooms" && !hasRoomsModule) ||
        (activeTab === "services" && !hasServicesModule)
      ) {
        setActiveTab("orders");
      }
    }, [activeTab, hasTablesModule, hasRoomsModule, hasServicesModule]);

    // Update tables count when tables data changes
    useEffect(() => {
      if (displayTables) {
        const openTableCount = displayTables.filter(tableHasOpenCheckReference).length;
        setOrderCounts((prev) => ({
          ...prev,
          tables: openTableCount,
        }));
      }
    }, [displayTables]);

    // Handle order selection
    const handleToggleOrderSelection = (orderId: string) => {
      const order =
        filteredOrders.find((o) => o.id === orderId) ||
        orders.find((o) => o.id === orderId);
      if (!order) return;

      const type: "pickup" | "delivery" =
        order.orderType === "delivery" ? "delivery" : "pickup";
      const visibleOrderIds = new Set(
        filteredOrders.map((visibleOrder) => visibleOrder.id),
      );

      setSelectedOrders((prev) => {
        const visibleSelection = prev.filter((id) => visibleOrderIds.has(id));
        const isSelected = visibleSelection.includes(orderId);
        const currentSelectionType = getSelectionTypeForOrders(
          visibleSelection,
          filteredOrders,
        );

        if (isSelected) {
          const next = visibleSelection.filter((id) => id !== orderId);
          setSelectionType(getSelectionTypeForOrders(next, filteredOrders));
          return next;
        }

        // Enforce mutually exclusive selection by order type
        if (!currentSelectionType) {
          setSelectionType(type);
          return [...visibleSelection, orderId];
        }

        if (currentSelectionType !== type) {
          toast.error(
            currentSelectionType === "delivery"
              ? t("orderDashboard.bulkPickupDisabled") ||
                  "Pickup orders cannot be selected while Delivery selection is active."
              : t("orderDashboard.bulkDeliveryDisabled") ||
                  "Delivery orders cannot be selected while Pickup selection is active.",
          );
          return visibleSelection; // ignore selection of other type
        }

        return [...visibleSelection, orderId];
      });
    };

    // Handle order double-click for editing
    const handleOrderDoubleClick = (orderId: string) => {
      setPendingEditOrders([orderId]);
      setEditingSingleOrder(orderId);
      setShowEditOptionsModal(true);
    };

    // Handle order approval. False: not approved (it failed); the approval
    // panel then stays open, says nothing of a success and the cashier may
    // try again (round 3 item DR4: on a failure the panel still said
    // "Approved" and closed, and a success was announced twice, here and by
    // the panel). The panel announces a success itself, once; a failure is
    // announced here.
    const handleApproveOrder = async (
      orderId: string,
      estimatedTime?: number,
    ): Promise<boolean> => {
      if (isBoxOrder(selectedOrderForApproval?.id === orderId ? selectedOrderForApproval : [...orders, ...pendingExternalOrders].find(order => order.id === orderId))) {
        // OrderApprovalPanel owns BOX feedback and closes only on resolution.
        await runBoxApprovalDecision(() => approveOrder(orderId, estimatedTime), async () => {
          await loadOrders();
          setShowApprovalPanel(false);
          setSelectedOrderForApproval(null);
          setIsViewOnlyMode(true);
        });
        return true;
      }
      // The order's platform may take a shorter preparation time than the
      // one chosen: the server's answer to this accept says so, and the
      // cashier is told. Listening starts before the accept goes out.
      const stopAcceptAnswer = noticeShortenedPreparationTime(orderId, t);
      // The store does not toast (it used to say "Order approved" in
      // hardcoded English on top of this screen's localized messages).
      const ok = await approveOrder(orderId, estimatedTime).catch((error: unknown) => {
        console.warn("[OrderDashboard] Approving the order failed:", error);
        return false;
      });
      if (!ok) {
        stopAcceptAnswer();
        toast.error(t("orderDashboard.approveOrderFailed"));
        return false;
      }
      // Kiosk orders print here, not on arrival: the slip used to come out
      // while this panel was still asking for a prep time, for an order the
      // operator had not accepted yet. No-ops for every other source, so the
      // efood/Wolt, phone and counter approval paths are unchanged.
      if (selectedOrderForApproval && isKioskOrder(selectedOrderForApproval)) {
        void printApprovedKioskOrder({
          ...selectedOrderForApproval,
          estimatedTime,
        } as Partial<Order>);
      }
      try {
        await loadOrders();
      } catch (error) {
        console.warn("[OrderDashboard] Reloading orders after an approval failed:", error);
      }
      setShowApprovalPanel(false);
      setSelectedOrderForApproval(null);
      setIsViewOnlyMode(true);
      return true;
    };

    // A decline cancels the order: refused when money was taken on it (fix
    // review 30/09/2026), or when it is labelled paid with no payment record
    // here (01/10/2026). A platform order the platform holds is never
    // refused. True: the decline may go on. The cashier is told why not.
    const declineRefusalAnnounced = async (orderId: string): Promise<boolean> => {
      const refusals = await findCancelRefusals([orderId]);
      if (refusals.hasPayments.length > 0) {
        announceCancelRefusedPaid(refusals.hasPayments);
        return true;
      }
      if (refusals.notRecorded.length > 0) {
        announceCancelRefusedNotRecorded(refusals.notRecorded);
        return true;
      }
      return false;
    };

    // Asked when Decline is pressed, before the reason (founder rule 30/09
    // and 01/10/2026: a refusal comes before any reason or PIN).
    const handleBeforeDeclineOrder = async (orderId: string): Promise<boolean> =>
      !(await declineRefusalAnnounced(orderId));

    // Handle order decline. False: not declined (refused, or it failed); the
    // approval panel then stays open and reports no success. The panel
    // announces a success itself.
    const handleDeclineOrder = async (orderId: string, reason: string): Promise<boolean> => {
      if (isBoxOrder(selectedOrderForApproval?.id === orderId ? selectedOrderForApproval : [...orders, ...pendingExternalOrders].find(order => order.id === orderId))) {
        if (await declineRefusalAnnounced(orderId)) return false;
        await runBoxApprovalDecision(() => declineOrder(orderId, reason), async () => {
          await loadOrders();
          setShowApprovalPanel(false);
          setSelectedOrderForApproval(null);
          setIsViewOnlyMode(true);
        });
        return true;
      }
      try {
        // Asked again: money may have been taken while the reason was typed.
        // The till refuses it again at decline.
        if (await declineRefusalAnnounced(orderId)) {
          return false;
        }
        const ok = await declineOrder(orderId, reason);
        if (!ok) {
          toast.error(t("orderDashboard.declineOrderFailed"));
          return false;
        }
        await loadOrders();
        setShowApprovalPanel(false);
        setSelectedOrderForApproval(null);
        setIsViewOnlyMode(true);
        return true;
      } catch (error) {
        toast.error(t("orderDashboard.declineOrderFailed"));
        return false;
      }
    };

    // Handle driver assignment
    const handleDriverAssignment = async (driver: any) => {
      if (pendingDeliveryOrders.length === 0) return;

      try {
        const results: boolean[] = [];
        for (const orderId of pendingDeliveryOrders) {
          const ok = await assignDriver(orderId, driver.id);
          results.push(Boolean(ok));
        }
        const successCount = results.filter(Boolean).length;
        const failureCount = results.length - successCount;
        if (successCount > 0) {
          toast.success(
            t("orderDashboard.driverAssigned", { count: successCount }),
          );
        }
        if (failureCount > 0) {
          toast.error(t("orderDashboard.driverAssignFailed"));
        }
        setPendingDeliveryOrders([]);
        setShowDriverModal(false);
        await loadOrders();
      } catch (error) {
        toast.error(t("orderDashboard.driverAssignFailed"));
      }
    };

    // Handle new order FAB click
    const handleNewOrderClick = () => {
      callerIdOrderIntentRef.current = null;
      setPendingCallerIdOrderType(null);
      setMenuSessionKey((session) => session + 1);
      setExistingCustomer(null);
      setCustomerInfo(null);
      setPhoneNumber("");
      setSelectedOrderType(null);
      setOrderType("pickup");
      setDeliveryZoneInfo(null);
      setRoomChargeContext(null);
      // One kind of work only: (+) opens it straight away instead of a
      // one-card picker (founder, 24/09/2026), as the Android POS does.
      const directCard = resolveDirectNewWorkCard(newWorkCards, newWorkOptionsSettled);
      if (directCard) {
        launchNewWorkCard(directCard.id);
        return;
      }
      setShowOrderTypeModal(true);
    };

    // --- Round 236: New Order -> Room / Service flows ---------------------------------------

    // New Order -> Room opens a small chooser (Room Order / Check-in / Create Reservation).
    const handleSelectRoomFlow = () => {
      callerIdOrderIntentRef.current = null;
      setShowOrderTypeModal(false);
      setShowRoomFlowModal(true);
    };

    // New Order -> Service switches to the Services hub tab and opens the existing Create
    // Appointment modal. Its staff/service/day/time availability check is preserved untouched.
    const handleSelectServiceFlow = () => {
      callerIdOrderIntentRef.current = null;
      setShowOrderTypeModal(false);
      setActiveTab("services");
      setServicesOpenCreateSignal((n) => n + 1);
    };

    // New Order -> Repair / Quick service opens the repairs view on that intake.
    const handleSelectRepairFlow = (repairIntent: "new_repair" | "quick_service") => {
      setShowOrderTypeModal(false);
      window.dispatchEvent(new CustomEvent('pos:navigate-view', {
        detail: { view: 'repairs', repairIntent },
      }));
    };

    // Starts one card's flow exactly as tapping it in the picker does.
    const launchNewWorkCard = (id: NewWorkCardId) => {
      switch (id) {
        case "room":
          handleSelectRoomFlow();
          return;
        case "service":
          handleSelectServiceFlow();
          return;
        case "repair":
          handleSelectRepairFlow("new_repair");
          return;
        case "quick_service":
          handleSelectRepairFlow("quick_service");
          return;
        default:
          void handleOrderTypeSelect(NEW_WORK_ORDER_TYPES[id]);
      }
    };

    // Room flow option 1 — Room Order: choose an occupied room that has an active folio.
    const handleRoomFlowOrder = () => {
      setShowRoomFlowModal(false);
      setRoomOrderFloor("all");
      setShowRoomOrderSelector(true);
    };

    // Room flow option 2 — Check-in: open a FOCUSED selector of RESERVED rooms only (no RoomsView
    // shell, no stats/search/filter/floor hub). Round 238: the rejected behaviour was hosting an
    // embedded RoomsView/hubPreset in the modal; instead a compact selector picks the room, then the
    // focused check-in form opens for it. Staff never leave the order-taking view.
    const handleRoomFlowCheckin = () => {
      setShowRoomFlowModal(false);
      setShowRoomCheckinSelector(true);
    };

    // Room flow option 3 — Create Reservation: focused selector of AVAILABLE rooms only (no RoomsView
    // shell). Tapping an available room opens the focused reservation form for it.
    const handleRoomFlowReservation = () => {
      setShowRoomFlowModal(false);
      setShowRoomReservationSelector(true);
    };

    // A valid occupied room (with an active folio) was chosen for a room-charge order: set up a
    // dine-in cart (so menu pricing follows the table/dine-in branch) whose payment can be charged
    // to the room folio, then open the normal menu. Reuses the existing roomChargeContext path —
    // no second cart/payment stack. Rooms without an active folio are disabled in the selector.
    const handleRoomOrderRoomSelect = (room: Room) => {
      const activeFolioId = room.activeFolio?.id || null;
      if (!activeFolioId) return;
      const guestName = room.activeFolio?.guestName || null;
      setShowRoomOrderSelector(false);
      // Clear any stale table flow state so a prior table order can't leak its
      // table_number / table_id / table_session into this room-charge order.
      setSelectedTable(null);
      setTableNumber("");
      setTableGuestCount(1);
      setSelectedOrderType("dine-in");
      setOrderType("dine-in");
      setRoomChargeContext({
        roomId: room.id,
        roomNumber: room.roomNumber,
        guestName,
        activeFolioId,
        currency: room.activeFolio?.currency ?? null,
      });
      setCustomerInfo({
        name: guestName
          ? t("orderFlow.roomGuestCustomer", {
              room: room.roomNumber,
              guest: guestName,
              defaultValue: "Room {{room}} — {{guest}}",
            })
          : t("orderFlow.roomCustomer", {
              room: room.roomNumber,
              defaultValue: "Room {{room}}",
            }),
        phone: "",
        email: "",
        address: { street: "", city: "", postalCode: "" },
        notes: "",
      });
      setShowMenuModal(true);
    };

    const tableHasOpenCheck = useCallback(
      (table: RestaurantTable) => tableHasOpenCheckReference(table),
      [],
    );

    const openTableCheckManager = useCallback((table: RestaurantTable) => {
      setSelectedTable(table);
      setShowTableActionModal(false);
      setShowTableSelector(false);
      setShowTableCheckManager(true);
    }, []);

    // Item D1 (fix review 30/09/2026): releasing a table whose order still
    // owes money asks first (collect, cancel with approval, or keep it as an
    // open tab) instead of leaving the order to linger as an orphan.
    const {
      runWithPrivilegedConfirmation: runTableReleaseApproval,
      confirmationModal: tableReleaseApprovalModal,
    } = usePrivilegedActionConfirmation();
    const { guardRelease: guardTableRelease, modal: tableReleaseModal } =
      useTableReleaseGuard({
        runWithPrivilegedConfirmation: runTableReleaseApproval,
        onCollect: openTableCheckManager,
      });

    // Handle table selection from TableSelector
    const handleTableSelectorSelect = useCallback((table: RestaurantTable) => {
      setEditingReservation(null);
      setSelectedTable(table);
      setShowTableSelector(false);
      if (tableHasOpenCheck(table)) {
        openTableCheckManager(table);
        return;
      }
      setShowTableActionModal(true);
    }, [openTableCheckManager, tableHasOpenCheck]);

    // Handle New Order action from TableActionModal
    const handleTableNewOrder = useCallback((guestCount = 1) => {
      if (selectedTable) {
        setSelectedOrderType("dine-in");
        setOrderType("dine-in");
        setTableGuestCount(Math.max(1, Math.min(99, Math.trunc(Number(guestCount) || 1))));
        // Raw table number stays in state for payload / session matching.
        setTableNumber(selectedTable.tableNumber.toString());
        setCustomerInfo({
          // Visible dine-in label only: use the shared display helper so the
          // MenuModal header chip reads "Table #TB01" like the grid/action modal,
          // instead of the raw "P01". The locale string adds no "#" of its own.
          name:
            t("orderFlow.tableCustomer", {
              table: formatTableDisplayNumber(selectedTable.tableNumber),
            }) || `Table ${formatTableDisplayNumber(selectedTable.tableNumber)}`,
          phone: "",
          email: "",
          address: {
            street: "",
            city: "",
            postalCode: "",
          },
          notes: "",
        });
        setShowTableActionModal(false);
        setShowMenuModal(true);
      }
    }, [selectedTable, t]);

    // Handle New Reservation action from TableActionModal
    const handleTableNewReservation = useCallback(() => {
      if (selectedTable) {
        setEditingReservation(null);
        setShowTableActionModal(false);
        setShowReservationForm(true);
      }
    }, [selectedTable]);

    // Recover a stale reserved table: when a reserved-table action discovers there
    // is no active reservation, the table's "reserved" status is wrong. Release it
    // to available, refetch, close the action modal and clear the selection so
    // staff are not left with management actions that can never succeed.
    const releaseStaleReservedTable = useCallback(async () => {
      if (!selectedTable) {
        return;
      }

      try {
        // Durable release: the __release flag keeps the optimistic "available"
        // projection alive through the immediate (possibly stale) refetch — which
        // may still report the table reserved — until the server reflects the
        // released status. Without it useTables deletes the override and the stale
        // reserved row reappears.
        const table = selectedTable;
        await guardTableRelease(table, async () => {
          const released = await updateTableStatus(table.id, "available", {
            __release: true,
          });
          await refetchTables();
          if (released) {
            toast.success(
              t("tableActionModal.reservationReleased", {
                defaultValue: "Reservation no longer active; table released",
              }),
            );
          } else {
            toast.error(
              t("tableActionModal.reservationLoadFailed", {
                defaultValue: "Failed to load reservation",
              }),
            );
          }
        });
      } catch (error) {
        console.error("Failed to release stale reserved table:", error);
        toast.error(
          t("tableActionModal.reservationLoadFailed", {
            defaultValue: "Failed to load reservation",
          }),
        );
      } finally {
        setShowTableActionModal(false);
        setSelectedTable(null);
      }
    }, [guardTableRelease, refetchTables, selectedTable, t, updateTableStatus]);

    const handleTableEditReservation = useCallback(async () => {
      const reservationBranchId = effectiveBranchId || branchId;
      if (!selectedTable || !reservationBranchId || !organizationId) {
        toast.error(
          t("reservationForm.toasts.missingContext", {
            defaultValue: "Missing branch or organization context",
          }),
        );
        return;
      }

      try {
        reservationsService.setContext(reservationBranchId, organizationId);
        const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
        if (!reservation) {
          // Stale reserved table with no active reservation: recover the table
          // state instead of leaving dead reserved actions on screen.
          await releaseStaleReservedTable();
          return;
        }

        setEditingReservation(reservation);
        setShowTableActionModal(false);
        setShowReservationForm(true);
      } catch (error) {
        console.error("Failed to load reservation for editing:", error);
        toast.error(
          t("tableActionModal.reservationLoadFailed", {
            defaultValue: "Failed to load reservation",
          }),
        );
      }
    }, [branchId, effectiveBranchId, organizationId, releaseStaleReservedTable, selectedTable, t]);

    const handleTableNoShowReservation = useCallback(async () => {
      const reservationBranchId = effectiveBranchId || branchId;
      if (!selectedTable || !reservationBranchId || !organizationId) {
        toast.error(
          t("reservationForm.toasts.missingContext", {
            defaultValue: "Missing branch or organization context",
          }),
        );
        return;
      }

      try {
        reservationsService.setContext(reservationBranchId, organizationId);
        const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
        if (!reservation) {
          // Stale reserved table with no active reservation: recover the table
          // state instead of leaving dead reserved actions on screen.
          await releaseStaleReservedTable();
          return;
        }

        await reservationsService.updateStatus(reservation.id, "no_show");
        const noShowTable = selectedTable;
        await guardTableRelease(noShowTable, async () => {
          await updateTableStatus(noShowTable.id, "available", { __release: true });
          await refetchTables();
        });
        toast.success(
          t("tableActionModal.noShowSuccess", {
            defaultValue: "Reservation marked as no-show",
          }),
        );
        setShowTableActionModal(false);
        setSelectedTable(null);
      } catch (error) {
        console.error("Failed to mark reservation no-show:", error);
        toast.error(
          t("tableActionModal.noShowFailed", {
            defaultValue: "Failed to mark reservation as no-show",
          }),
        );
      }
    }, [branchId, effectiveBranchId, guardTableRelease, organizationId, refetchTables, releaseStaleReservedTable, selectedTable, t, updateTableStatus]);

    const handleTableCancelReservation = useCallback(async () => {
      const reservationBranchId = effectiveBranchId || branchId;
      if (!selectedTable || !reservationBranchId || !organizationId) {
        toast.error(
          t("reservationForm.toasts.missingContext", {
            defaultValue: "Missing branch or organization context",
          }),
        );
        return;
      }

      try {
        reservationsService.setContext(reservationBranchId, organizationId);
        const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
        if (!reservation) {
          // Stale reserved table with no active reservation: recover the table
          // state instead of leaving dead reserved actions on screen.
          await releaseStaleReservedTable();
          return;
        }

        await reservationsService.cancelReservation(reservation.id,
          t("tableActionModal.cancelReason", {
            defaultValue: "Cancelled from POS table actions",
          }),
        );
        const cancelledReservationTable = selectedTable;
        await guardTableRelease(cancelledReservationTable, async () => {
          await updateTableStatus(cancelledReservationTable.id, "available", { __release: true });
          await refetchTables();
        });
        toast.success(
          t("tableActionModal.cancelSuccess", {
            defaultValue: "Reservation cancelled",
          }),
        );
        setShowTableActionModal(false);
        setSelectedTable(null);
      } catch (error) {
        console.error("Failed to cancel reservation:", error);
        toast.error(
          t("tableActionModal.cancelFailed", {
            defaultValue: "Failed to cancel reservation",
          }),
        );
      }
    }, [branchId, effectiveBranchId, guardTableRelease, organizationId, refetchTables, releaseStaleReservedTable, selectedTable, t, updateTableStatus]);

    const handleTableSetAvailable = useCallback(async () => {
      if (!selectedTable) {
        return;
      }

      const table = selectedTable;
      await guardTableRelease(table, async () => {
        const success = await updateTableStatus(table.id, "available");
        if (success) {
          toast.success(
            t("tableActionModal.setAvailableSuccess", {
              defaultValue: "Table marked available",
            }),
          );
          setShowTableActionModal(false);
          setSelectedTable(null);
          return;
        }

        toast.error(
          t("tableActionModal.setAvailableFailed", {
            defaultValue: "Failed to mark table available",
          }),
        );
      });
    }, [guardTableRelease, selectedTable, t, updateTableStatus]);

    // Handle reservation form submission, through the helper the Tables page shares.
    const handleReservationSubmit = useCallback(
      async (data: CreateReservationDto) => {
        try {
          const result = await submitTableReservation({
            data,
            editingReservation,
            branchId: effectiveBranchId || branchId,
            organizationId,
          });
          if (result === "missing-context") {
            toast.error(
              t("reservationForm.toasts.missingContext", {
                defaultValue: "Missing branch or organization context",
              }),
            );
            return;
          }

          toast.success(
            result === "updated"
              ? t("reservationForm.toasts.updated", {
                  defaultValue: "Reservation updated successfully",
                })
              : t("reservationForm.toasts.created", {
                  defaultValue: "Reservation created successfully",
                }),
          );
          setShowReservationForm(false);
          setEditingReservation(null);
          setSelectedTable(null);
          await refetchTables();
        } catch (error) {
          console.error("Failed to save reservation:", error);
          const reservationUpdateError = extractOrderDashboardErrorMessage(error);
          toast.error(
            editingReservation
              ? reservationUpdateError ||
                t("reservationForm.toasts.updateFailed", {
                  defaultValue: "Failed to update reservation",
                })
              : t("reservationForm.toasts.createFailed", {
                  defaultValue: "Failed to create reservation",
                }),
          );
        }
      },
      [t, branchId, effectiveBranchId, organizationId, editingReservation, refetchTables],
    );

    // Handle reservation form cancel
    const handleReservationCancel = useCallback(() => {
      setShowReservationForm(false);
      setEditingReservation(null);
      setSelectedTable(null);
    }, []);

    // Handle table selection from Tables tab grid
    const handleTableSelect = useCallback((table: RestaurantTable) => {
      setEditingReservation(null);
      setSelectedTable(table);
      if (tableHasOpenCheck(table)) {
        openTableCheckManager(table);
        return;
      }
      setShowTableActionModal(true);
    }, [openTableCheckManager, tableHasOpenCheck]);

    // Open a new reservation directly for an available table card. The card's
    // secondary button previously advertised "Assign" but a waiter is session-
    // scoped (no session = nothing to assign), so the honest available-table action
    // is to start a reservation. Opens the portalled/blurred ReservationForm.

    const handleTableCheckAddItems = useCallback((table: RestaurantTable, guestCount: number, session: any) => {
      const activeOrderId = session?.active_order_id || table.currentOrderId;
      const targetOrder = activeOrderId
        ? orders.find(order =>
            order.id === activeOrderId ||
            order.supabase_id === activeOrderId ||
            order.order_number === activeOrderId ||
            order.orderNumber === activeOrderId,
          )
        : null;

      setTableGuestCount(Math.max(1, Math.min(99, Math.trunc(Number(guestCount) || 1))));
      setSelectedTable({
        ...table,
        tableSessionId: session?.id || table.tableSessionId || null,
        currentOrderId: activeOrderId || table.currentOrderId,
      });
      setShowTableCheckManager(false);

      if (targetOrder) {
        setCurrentEditOrderId(targetOrder.id);
        setCurrentEditSupabaseId(targetOrder.supabase_id || targetOrder.id);
        setCurrentEditOrderNumber(targetOrder.order_number || targetOrder.orderNumber);
        setEditingOrderType("dine-in");
        setCurrentEditSourceOrderType(resolveEditableOrderType(targetOrder));
        setShowEditMenuModal(true);
        return;
      }

      if (activeOrderId) {
        toast.error(
          t("orderDashboard.tableOrderNotLoaded", {
            defaultValue: "This table check is open, but the linked order is not loaded locally yet. Refresh orders and try again.",
          }),
        );
        void silentRefresh();
        return;
      }

      handleTableNewOrder(guestCount);
    }, [handleTableNewOrder, orders, silentRefresh, t]);

    // Handle menu modal close
    const handleMenuModalClose = () => {
      dismissCheckoutRequestId();
      setShowMenuModal(false);
      setSelectedOrderType(null);
      setPickupToDeliveryContext(null);
      // Round 236: clear any room-charge context so a later non-room order can't inherit it.
      setRoomChargeContext(null);
      // Reset all state
      setPhoneNumber("");
      setCustomerInfo(null);
      setExistingCustomer(null);
      setSpecialInstructions("");
      setTableNumber("");
      setTableGuestCount(1);
      setAddressValid(false);
      setDeliveryZoneInfo(null);
      setShowPhoneLookupModal(false);
      setShowCustomerInfoModal(false);
    };

    const convertPickupOrderToDelivery = useCallback(
      async (customer: OrderFlowCustomer) => {
        if (!pickupToDeliveryContext) {
          return false;
        }

        const targetOrder = orders.find(
          (order) => order.id === pickupToDeliveryContext.orderId,
        );
        if (!targetOrder) {
          toast.error(
            t("orderDashboard.orderNotFound", {
              defaultValue: "The selected order could not be found.",
            }),
          );
          return false;
        }

        const resolvedAddress = resolvePickupToDeliveryAddress(customer);
        if (!resolvedAddress) {
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          return false;
        }

        let addressCoordinates =
          toValidLatLng(
            resolvedAddress.coordinates,
            resolvedAddress.latitude,
            resolvedAddress.longitude,
          ) ?? undefined;
        const addressString = [
          resolvedAddress.streetAddress,
          resolvedAddress.city,
          resolvedAddress.postalCode,
        ]
          .filter(Boolean)
          .join(", ");
        const validationTarget = addressCoordinates || addressString;

        if (!validationTarget) {
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          return false;
        }

        setIsBulkActionLoading(true);
        try {
          // An address without a point: automatic geolocation, accepted only
          // when its municipality or postal code matches the saved address.
          if (
            !addressCoordinates &&
            !parseSpecialAddressInput(resolvedAddress.streetAddress).shouldSkipZoneValidation
          ) {
            const savedAddress = {
              id: resolvedAddress.addressId || undefined,
              street_address: resolvedAddress.streetAddress,
              city: resolvedAddress.city,
              postal_code: resolvedAddress.postalCode,
            };
            try {
              const geolocated = await resolveSavedAddressCoordinates(
                savedAddress,
                effectiveBranchId || undefined,
              );
              if (geolocated) {
                addressCoordinates = geolocated.coordinates;
                await persistGeocodedSavedAddressCoordinates({
                  address: savedAddress,
                  customerId: resolvePersistedCustomerId(
                    resolvedAddress.customerId,
                    customer.id,
                  ),
                  resolved: geolocated,
                  isLegacyFallback: isLegacyFallbackAddress({
                    id: resolvedAddress.addressId,
                  }),
                  updateAddress: (addressId, updates, expectedVersion) =>
                    bridge.customers.updateAddress(
                      addressId,
                      updates,
                      expectedVersion,
                    ),
                }).catch((persistError: unknown) => {
                  console.warn(
                    "[OrderDashboard] Failed to persist geolocated address coordinates:",
                    persistError,
                  );
                });
              }
            } catch (geolocationError) {
              console.warn(
                "[OrderDashboard] Address geolocation failed:",
                geolocationError,
              );
            }
          }

          const validationAmount =
            getPickupToDeliveryValidationAmount(targetOrder);
          // Still no point (and not a "#label" address): the zone was not
          // checked. A text-only request could only answer
          // requires_selection, so it is answered locally.
          let validationResult =
            !addressCoordinates &&
            !parseSpecialAddressInput(resolvedAddress.streetAddress)
              .shouldSkipZoneValidation
              ? createUncheckedDeliveryZoneResult()
              : await validateDeliveryAddress(
                  addressCoordinates || validationTarget,
                  validationAmount,
                );
          // Founder rule (2026-09-29): a zone that was not checked (no usable
          // point) never blocks and never needs an out-of-zone override.
          const { zoneNotChecked, canProceed, canAttemptOverride } =
            decidePickupToDeliveryZone(validationResult);

          if (!canProceed) {
            if (!canAttemptOverride) {
              toast.error(
                validationResult?.message ||
                  t("orderDashboard.deliveryValidationFailed", {
                    defaultValue:
                      "The selected address cannot be used for delivery.",
                  }),
              );
              return false;
            }

            const overrideResponse = await requestDeliveryOverride(
              t("orderDashboard.pickupToDeliveryOverrideReason", {
                orderNumber: pickupToDeliveryContext.orderNumber,
                defaultValue: `Pickup order ${pickupToDeliveryContext.orderNumber} converted to delivery`,
              }),
            );

            if (!overrideResponse.success || !overrideResponse.approved) {
              toast.error(
                overrideResponse.message ||
                  t("orderDashboard.deliveryOverrideDenied", {
                    defaultValue:
                      "Manager approval is required to convert this order to delivery.",
                  }),
              );
              return false;
            }

            validationResult = {
              ...validationResult,
              override: {
                ...(validationResult?.override || {}),
                ...overrideResponse,
                applied: true,
              },
            };
          }

          if (zoneNotChecked) {
            toast(
              t("orderDashboard.deliveryZoneNotCheckedNotice", {
                defaultValue:
                  "The delivery zone was not checked. Pick the address again.",
              }),
              { icon: "📍", duration: 6000 },
            );
          }

          const deliveryFee = resolveDeliveryFee(validationResult);
          const validatedCoordinates =
            toValidLatLng(validationResult?.coordinates) ?? addressCoordinates;
          const deliveryZoneId =
            validationResult?.selectedZone?.id ||
            validationResult?.zone?.id ||
            validationResult?.zoneId ||
            resolvedAddress.deliveryZoneId ||
            undefined;
          const totalAmount = calculatePickupToDeliveryTotal(
            targetOrder,
            deliveryFee,
          );
          const conversionPayload: PickupToDeliveryConversionParams = {
            orderId: targetOrder.id,
            customerId: resolvePersistedCustomerId(resolvedAddress.customerId, customer.id),
            customerName: customer.name,
            customerPhone: customer.phone,
            customerEmail: customer.email || undefined,
            deliveryAddress: resolvedAddress.streetAddress,
            deliveryAddressId: resolvedAddress.addressId || undefined,
            deliveryCity: resolvedAddress.city || undefined,
            deliveryPostalCode: resolvedAddress.postalCode || undefined,
            deliveryFloor: resolvedAddress.floor || undefined,
            deliveryNotes: resolvedAddress.notes || undefined,
            nameOnRinger: resolvedAddress.nameOnRinger || undefined,
            deliveryLatitude: validatedCoordinates?.lat ?? undefined,
            deliveryLongitude: validatedCoordinates?.lng ?? undefined,
            deliveryAddressFingerprint:
              resolvedAddress.addressFingerprint || undefined,
            deliveryZoneId,
            deliveryFee,
            totalAmount,
          };

          if (pickupToDeliveryContext.mode === "edit" || ["paid", "partially_paid", "partial", "completed"].includes(String(targetOrder.payment_status ?? targetOrder.paymentStatus))) {
            const { orderId: _, totalAmount: __, deliveryFee: stagedFee, ...headers } = conversionPayload;
            setEditHeaders({ orderUpdates: { ...headers, orderType: "delivery" }, deliveryFee: stagedFee });
            setCurrentEditOrderId(targetOrder.id);
            setCurrentEditSupabaseId(targetOrder.supabase_id);
            setCurrentEditOrderNumber(targetOrder.order_number || targetOrder.orderNumber);
            setCurrentEditSourceOrderType(resolveEditableOrderType(targetOrder));
            setEditingOrderType("delivery");
            resetPickupToDeliveryFlow();
            setShowEditMenuModal(true);
            return true;
          }

          const result =
            await bridge.orders.convertPickupToDelivery(conversionPayload);
          if (!result?.success) {
            throw new Error(
              extractOrderDashboardErrorMessage(result) ||
                t("orderDashboard.convertToDeliveryFailed", {
                  defaultValue: "Failed to convert order to delivery.",
                }),
            );
          }

          setSelectedOrders([targetOrder.id]);
          setSelectionType("delivery");

          // Capture mode before resetPickupToDeliveryFlow clears context.


          try {
            await silentRefresh();
          } catch (refreshError) {
            console.debug(
              "[OrderDashboard] Silent refresh after pickup-to-delivery failed:",
              refreshError,
            );
            await loadOrders();
          }

          resetPickupToDeliveryFlow();
          toast.success(
            t("orderDashboard.convertedToDelivery", {
              orderNumber:
                targetOrder.orderNumber ||
                targetOrder.order_number ||
                pickupToDeliveryContext.orderNumber,
              defaultValue: "Order converted to delivery.",
            }),
          );
          return true;
        } catch (error) {
          console.error(
            "[OrderDashboard] Failed to convert pickup order to delivery:",
            error,
          );
          toast.error(
            extractOrderDashboardErrorMessage(error) ||
              t("orderDashboard.convertToDeliveryFailed", {
                defaultValue: "Failed to convert order to delivery.",
              }),
          );
          return false;
        } finally {
          setIsBulkActionLoading(false);
        }
      },
      [
        bridge.customers,
        bridge.orders,
        effectiveBranchId,
        loadOrders,
        orders,
        pickupToDeliveryContext,
        requestDeliveryOverride,
        resetPickupToDeliveryFlow,
        silentRefresh,
        t,
        validateDeliveryAddress,
      ],
    );

    // Handler for clicking on customer card - select and proceed directly to menu
    const handleCustomerSelectedDirect = async (
      customer: any,
      targetOrderType = orderType,
    ) => {
      const orderFlowCustomer = customer as OrderFlowCustomer;

      if (pickupToDeliveryContext) {
        const resolvedAddress =
          resolvePickupToDeliveryAddress(orderFlowCustomer);
        if (!resolvedAddress) {
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          setExistingCustomer(orderFlowCustomer as any);
          setCustomerModalMode("addAddress");
          setShowPhoneLookupModal(false);
          setShowAddCustomerModal(true);
          return;
        }

        await convertPickupOrderToDelivery(orderFlowCustomer);
        return;
      }

      debugLog(
        "[handleCustomerSelectedDirect] Called with customer:",
        JSON.stringify(
          {
            id: customer?.id,
            name: customer?.name,
            address: customer?.address,
            addresses: customer?.addresses,
          },
          null,
          2,
        ),
      );
      debugLog(
        "[handleCustomerSelectedDirect] Current orderType:",
        orderType,
      );

      const normalizedCustomer = withMaterializedCustomerAddresses(
        customer as OrderFlowCustomer,
      ) as OrderFlowCustomer;
      const resolvedAddress = resolveCanonicalCustomerAddress(
        normalizedCustomer,
      );
      debugLog(
        "[handleCustomerSelectedDirect] resolvedAddress:",
        JSON.stringify(resolvedAddress, null, 2),
      );

      // For delivery orders, validate that customer has an address
      if (targetOrderType === "delivery") {
        setDeliveryZoneInfo(null);
        const hasAddress =
          resolvedAddress?.street_address || normalizedCustomer.address;
        debugLog(
          "[handleCustomerSelectedDirect] Delivery check - hasAddress:",
          hasAddress,
        );
        if (!hasAddress) {
          debugLog(
            "[handleCustomerSelectedDirect] No address - opening addAddress modal",
          );
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          // Keep the modal open and prompt to add address
          setExistingCustomer(normalizedCustomer);
          setCustomerModalMode("addAddress");
          setShowPhoneLookupModal(false);
          setShowAddCustomerModal(true);
          return;
        }

        // Check the zone only with the address's real point. An address
        // without one is left to the menu, which geolocates it (accepted only
        // when its area matches) or shows "zone not checked" — never the
        // (0,0) "out of zone" of 1.4.118.
        try {
          const zonePlan = planDeliveryZoneHandoff({ address: resolvedAddress });
          if (zonePlan.kind === "check_point") {
            const validationResult = await validateDeliveryAddress(
              zonePlan.point,
              0,
            );
            if (validationResult) {
              setDeliveryZoneInfo(validationResult);
            }
          }
        } catch (error) {
          console.error(
            "[OrderDashboard] Error validating delivery zone:",
            error,
          );
          // Continue without zone info - validation will happen in PaymentModal
        }
      } else {
        // Clear delivery zone info for non-delivery orders
        setDeliveryZoneInfo(null);
      }

      setExistingCustomer(normalizedCustomer);

      const customerInfoData =
        buildCustomerInfoFromOrderFlowCustomer(normalizedCustomer);
      setCustomerInfo(customerInfoData);

      setSpecialInstructions(customerInfoData.notes || "");

      // Close search modal and go directly to menu
      setShowPhoneLookupModal(false);
      setShowMenuModal(true);
    };

    // The standard flow chooses an order type first. Caller ID intentionally
    // reverses that sequence: lookup first, then this same module-aware chooser.
    const handleOrderTypeSelect = async (
      type: "pickup" | "delivery" | "dine-in",
    ) => {
      setIsOrderTypeTransitioning(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      setShowOrderTypeModal(false);
      setIsOrderTypeTransitioning(false);

      const callerIntent = callerIdOrderIntentRef.current;

      if (type === "pickup") {
        setSelectedOrderType("pickup");
        setOrderType("pickup");

        if (!existingCustomer) {
          setCustomerInfo({
            name: "",
            phone: callerIntent?.canonicalPhone || "",
            email: "",
            address: {
              street: "",
              city: "",
              postalCode: "",
            },
            notes: "",
          });
        }
        callerIdOrderIntentRef.current = null;
        setShowMenuModal(true);
        return;
      }

      if (type === "delivery") {
        setSelectedOrderType("delivery");
        setOrderType("delivery");

        if (callerIntent) {
          const action = resolveCallerIdOrderSelection(
            "delivery",
            callerIntent,
          );
          callerIdOrderIntentRef.current = null;

          if (action === "use-existing-customer" && existingCustomer) {
            await handleCustomerSelectedDirect(existingCustomer, "delivery");
            return;
          }

          setExistingCustomer(null);
          setCustomerInfo(null);
          setCustomerModalMode("new");
          setPhoneNumber(callerIntent.canonicalPhone);
          setShowAddCustomerModal(true);
          return;
        }

        setShowPhoneLookupModal(true);
        return;
      }

      callerIdOrderIntentRef.current = null;
      setShowTableSelector(true);
    };

    useEffect(() => {
      const requestedOrderType = pendingCallerIdOrderType;
      if (!requestedOrderType) return;

      setPendingCallerIdOrderType(null);
      if (requestedOrderType === "room") {
        handleSelectRoomFlow();
        return;
      }
      if (requestedOrderType === "service") {
        handleSelectServiceFlow();
        return;
      }

      void handleOrderTypeSelect(requestedOrderType);
      // The selected action is a one-shot in-memory handoff. The handler is
      // intentionally consumed only when that handoff value changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingCallerIdOrderType]);

    // Handler for "Add Address" button - open modal to add new address only
    const handleAddNewAddress = (customer: any) => {
      setExistingCustomer(customer);
      setCustomerModalMode("addAddress");
      setShowPhoneLookupModal(false);
      setShowAddCustomerModal(true);
    };

    // Handler for "Edit Customer" button - open modal for full edit
    const handleEditCustomer = (customer: any) => {
      setExistingCustomer(customer);
      // The address-row pencil passes editAddressId -> open address-only edit mode
      // so the title/action reflect editing that one address. The full "Edit
      // Customer" button passes no editAddressId and keeps the full edit mode.
      setCustomerModalMode(customer?.editAddressId ? "editAddress" : "edit");
      setShowPhoneLookupModal(false);
      setShowAddCustomerModal(true);
    };

    // Handler for adding new customer from search modal
    const handleAddNewCustomer = (phone: string) => {
      setExistingCustomer(null);
      setCustomerModalMode("new");
      setPhoneNumber(phone); // Keep track of phone
      setShowPhoneLookupModal(false);
      setShowAddCustomerModal(true);
    };

    const handleNewCustomerAdded = async (customer: any) => {
      const orderFlowCustomer = customer as OrderFlowCustomer;
      // The order goes to the address the modal just saved or edited
      // (selected_address_id / editAddressId), not the customer's default.
      const handoff = resolveHandoffCustomer(orderFlowCustomer, {
        customerId: existingCustomer?.id ?? null,
        selectedAddressId:
          (existingCustomer as OrderFlowCustomer | null)?.selected_address_id ??
          null,
      });

      if (pickupToDeliveryContext) {
        const conversionCustomer = handoff.customer as OrderFlowCustomer;
        const resolvedAddress =
          resolvePickupToDeliveryAddress(conversionCustomer);
        if (!resolvedAddress) {
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          setExistingCustomer(orderFlowCustomer as any);
          setCustomerModalMode("addAddress");
          return;
        }

        await convertPickupOrderToDelivery(conversionCustomer);
        return;
      }

      debugLog(
        "[handleNewCustomerAdded] Called with customer:",
        JSON.stringify(
          {
            id: customer?.id,
            name: customer?.name,
            address: customer?.address,
            addresses: customer?.addresses,
            selected_address_id: customer?.selected_address_id,
          },
          null,
          2,
        ),
      );
      debugLog("[handleNewCustomerAdded] Current orderType:", orderType);

      const normalizedCustomer = handoff.customer as OrderFlowCustomer;
      const resolvedAddress = resolveCanonicalCustomerAddress(
        normalizedCustomer,
      );
      const keepDeliveryZone = canKeepDeliveryZoneForCustomerEdit({
        customerId: normalizedCustomer.id,
        previousCustomerId: existingCustomer?.id,
        address: resolvedAddress,
        previousAddress: existingCustomer ? resolveCanonicalCustomerAddress(existingCustomer) : null,
        unchangedDestination: customer?.[MODAL_DESTINATION_UNCHANGED_FIELD],
        zoneInfo: deliveryZoneInfo,
      });
      menuAddressRepickRef.current = false;
      debugLog(
        "[handleNewCustomerAdded] resolvedAddress:",
        JSON.stringify(resolvedAddress, null, 2),
      );

      // For delivery orders, validate that customer has an address
      if (orderType === "delivery") {
        if (!keepDeliveryZone) setDeliveryZoneInfo(null);
        const hasAddress =
          resolvedAddress?.street_address || normalizedCustomer.address;
        debugLog(
          "[handleNewCustomerAdded] Delivery check - hasAddress:",
          hasAddress,
        );
        if (!hasAddress) {
          debugLog(
            "[handleNewCustomerAdded] No address found - keeping addAddress modal open",
          );
          toast.error(
            t("orderDashboard.customerNoAddress") ||
              "This customer has no delivery address. Please add an address first.",
          );
          // Keep the add customer modal open in addAddress mode
          setExistingCustomer(normalizedCustomer);
          setCustomerModalMode("addAddress");
          return;
        }

        // Reuse the zone check the modal just ran for this address; otherwise
        // check only this address's real point. Never re-check another
        // address (the default) and never a missing point as (0,0).
        try {
          if (!keepDeliveryZone) {
            const zonePlan = planDeliveryZoneHandoff({
              address: resolvedAddress,
              modalValidation: (customer as Record<string, unknown> | null)?.[
                MODAL_ZONE_VALIDATION_FIELD
              ],
              addressFromModal: handoff.addressFromModal,
            });
            if (zonePlan.kind === "reuse") {
              setDeliveryZoneInfo(zonePlan.zoneInfo);
            } else if (zonePlan.kind === "check_point") {
              const validationResult = await validateDeliveryAddress(
                zonePlan.point,
                0,
              );
              if (validationResult) {
                setDeliveryZoneInfo(validationResult);
              }
            }
          }
        } catch (error) {
          console.error(
            "[OrderDashboard] Error validating delivery zone:",
            error,
          );
          // Continue without zone info - validation will happen in PaymentModal
        }
      } else {
        // Clear delivery zone info for non-delivery orders
        setDeliveryZoneInfo(null);
      }

      // Store the customer info and proceed to menu
      debugLog(
        "[handleNewCustomerAdded] Setting existingCustomer to:",
        normalizedCustomer?.name,
      );
      setExistingCustomer(normalizedCustomer);
      // A saved address edit supersedes the restored display snapshot, while
      // the mounted menu retains the existing cart and checkout identity.
      setRestoredCheckoutContext(null);

      const customerInfoData =
        buildCustomerInfoFromOrderFlowCustomer(normalizedCustomer);
      debugLog(
        "[handleNewCustomerAdded] Setting customerInfo to:",
        JSON.stringify(customerInfoData, null, 2),
      );
      setCustomerInfo(customerInfoData);

      setSpecialInstructions(customerInfoData.notes || "");

      // Close add customer modal and open menu modal
      debugLog("[handleNewCustomerAdded] Opening MenuModal");
      setShowAddCustomerModal(false);
      setShowMenuModal(true);
    };

    // Handler for saving customer info from modal (New Order Flow)
    const handleNewOrderCustomerInfoSave = (info: any) => {
      debugLog(
        "[handleNewOrderCustomerInfoSave] Called with info:",
        JSON.stringify(info, null, 2),
      );
      // Update local state. The customer info modal only edits street,
      // floor, ringer name, and coordinates — city/postal/email/notes are
      // not fields on that modal, so they must be carried over from the
      // previously stored customer info rather than blanked out.
      const customerInfoData = mergeCustomerInfoModalSave(customerInfo, info);
      debugLog(
        "[handleNewOrderCustomerInfoSave] Setting customerInfo:",
        JSON.stringify(customerInfoData, null, 2),
      );
      setCustomerInfo(customerInfoData);

      // Close customer info modal and open menu modal
      debugLog("[handleNewOrderCustomerInfoSave] Opening MenuModal");
      setShowCustomerInfoModal(false);
      setShowMenuModal(true);
    };

    // Handle customer info submission
    const handleCustomerInfoSubmit = () => {
      // Validate required fields
      if (!customerInfo?.name.trim()) {
        toast.error(t("orderDashboard.nameRequired"));
        return;
      }

      if (!customerInfo?.phone.trim()) {
        toast.error(t("orderDashboard.phoneRequired"));
        return;
      }

      // For delivery orders, validate address
      if (orderType === "delivery") {
        if (!customerInfo?.address?.street.trim()) {
          toast.error(t("orderDashboard.addressRequired"));
          return;
        }
        if (!customerInfo?.address?.city.trim()) {
          toast.error(t("orderDashboard.cityRequired"));
          return;
        }
        if (!customerInfo?.address?.postalCode.trim()) {
          toast.error(t("orderDashboard.postalCodeRequired"));
          return;
        }
      }

      setShowCustomerInfoModal(false);
      setShowMenuModal(true);
    };

    // Handle address validation
    const handleValidateAddress = async (): Promise<boolean> => {
      setIsValidatingAddress(true);

      try {
        // Simulate address validation API call
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Mock validation - in real app, this would validate against a real service
        const isValid =
          customerInfo?.address?.street.trim() &&
          customerInfo?.address?.city.trim() &&
          customerInfo?.address?.postalCode.trim();
        setAddressValid(!!isValid);

        if (isValid) {
          toast.success(t("orderDashboard.addressValidated"));
        } else {
          toast.error(t("orderDashboard.addressValidationFailed"));
        }
        return !!isValid;
      } catch (error) {
        console.error("Address validation failed:", error);
        toast.error(t("orderDashboard.addressValidationError"));
        setAddressValid(false);
        return false;
      } finally {
        setIsValidatingAddress(false);
      }
    };

    // Helper functions for menu modal
    const getCustomerForMenu = () => {
      debugLog(
        "[getCustomerForMenu] BUILD v2026.01.05.1 - existingCustomer:",
        !!existingCustomer,
        "customerInfo:",
        !!customerInfo,
      );
      if (existingCustomer) {
        const result = {
          ...existingCustomer,
          id: existingCustomer.id,
          name: existingCustomer.name,
          phone: existingCustomer.phone,
          phone_number: existingCustomer.phone,
          email: existingCustomer.email,
        };
        debugLog(
          "[getCustomerForMenu] Returning from existingCustomer:",
          result,
        );
        return result;
      } else if (customerInfo) {
        const result = {
          name: customerInfo.name,
          phone: customerInfo.phone,
          phone_number: customerInfo.phone,
          email: customerInfo.email,
        };
        debugLog(
          "[getCustomerForMenu] Returning from customerInfo:",
          result,
        );
        return result;
      }
      debugLog("[getCustomerForMenu] Returning null");
      return null;
    };

    const getSelectedAddress = () => {
      const resolvedAddress = existingCustomer
        ? resolveCanonicalCustomerAddress(
            existingCustomer as OrderFlowCustomer,
          )
        : null;
      if (resolvedAddress?.street_address) {
        debugLog(
          "[getSelectedAddress] Found canonical address from existingCustomer:",
          resolvedAddress.street_address,
        );
        return resolvedAddress;
      }

      // Finally check customerInfo state
      if (customerInfo?.address) {
        const streetValue = customerInfo.address.street || "";
        if (streetValue) {
          debugLog(
            "[getSelectedAddress] Found address from customerInfo.address:",
            streetValue,
          );
          return {
            street: streetValue,
            street_address: streetValue,
            city: customerInfo.address.city,
            postalCode:
              customerInfo.address.postalCode || customerInfo.address.postal_code || "",
            postal_code:
              customerInfo.address.postal_code || customerInfo.address.postalCode || "",
            floor:
              customerInfo.address.floor_number || customerInfo.address.floor || "",
            floor_number:
              customerInfo.address.floor_number || customerInfo.address.floor || "",
            notes: customerInfo.address.notes || customerInfo.notes || "",
            delivery_notes:
              customerInfo.address.notes || customerInfo.notes || "",
            nameOnRinger: customerInfo.address.name_on_ringer || "",
            name_on_ringer: customerInfo.address.name_on_ringer || "",
            ...(() => {
              const point = toValidLatLng(
                customerInfo.address.coordinates,
                customerInfo.address.latitude,
                customerInfo.address.longitude,
              );
              return {
                coordinates: point ?? undefined,
                latitude: point?.lat ?? null,
                longitude: point?.lng ?? null,
              };
            })(),
          };
        }
      }
      debugLog(
        "[getSelectedAddress] No address found. existingCustomer:",
        !!existingCustomer,
        "customerInfo:",
        !!customerInfo,
      );
      return null;
    };

    const finalizeCreatedOrderPayment = async (
      orderId: string,
      isGhostOrder: boolean,
      options: PaymentPrintPromptContext & {
        askBeforePrint?: boolean;
        autoPrintSuppressed?: boolean;
      } = {},
    ) => {
      const {
        askBeforePrint = false,
        autoPrintSuppressed = false,
        ...promptContext
      } = options;

      if (askBeforePrint) {
        const shouldPrint = await askForPaymentPrint({
          orderId,
          ...promptContext,
        });
        if (!shouldPrint) return;
      }

      if (isGhostOrder || autoPrintSuppressed) {
        const printResult: any = await bridge.payments.printReceipt(orderId);
        debugLog(
          "[OrderDashboard] Receipt print result:",
          printResult,
        );
        if (isGhostOrder) return;
      }

      if (isGhostOrder) {
        return;
      }

      // Non-ghost orders: Rust auto-print already enqueued the correct receipt.
      // Only fire fiscal print if enabled in settings.
      const fiscalEnabled = await bridge.settings
        .get("terminal", "fiscal_print_enabled")
        .catch(() => true);
      if (
        fiscalEnabled === false ||
        fiscalEnabled === "false" ||
        fiscalEnabled === "0"
      ) {
        return;
      }

      const fiscalResult: any = await bridge.ecr.fiscalPrint(orderId);
      if (fiscalResult?.skipped) {
        return;
      }
      debugLog("[OrderDashboard] Fiscal print result:", fiscalResult);
    };

    // Handle order completion from menu modal. Resolves false on failure so
    // MenuModal/PaymentModal keep the cart and skip their success toasts.
    // Fix review 30/09/2026: one checkout id per cart, reused by every press
    // of Pay until the checkout ends, so a slow card terminal is never paid
    // twice.
    const { take: takeCheckoutRequestId, reset: resetCheckoutRequestId, restore: restoreCheckoutRequestId, dismiss: dismissCheckoutRequestId } =
      useCheckoutRequestId();

    const [restoredCheckoutContext, setRestoredCheckoutContext] = useState<Record<string, any> | null>(null);
    const restoreCheckoutContext = useCallback((context: Record<string, any>, renewal?: { previousCheckoutRequestId: string }) => {
      if (!["pickup", "delivery", "dine-in"].includes(context.orderType)) return;
      restoreCheckoutRequestId(context.checkoutRequestId, { phase: context.checkoutPhase, editMode: context.editMode, renewedFrom: renewal?.previousCheckoutRequestId });
      setRestoredCheckoutContext(context);
      setSelectedOrderType(context.orderType);
      setOrderType(context.orderType);
      setExistingCustomer(context.selectedCustomer || null);
      setCustomerInfo(context.selectedCustomer || null);
      setSelectedTable(context.selectedTable || null);
      setTableNumber(context.tableNumber || "");
      setTableGuestCount(context.tableGuestCount || 1);
      setDeliveryZoneInfo(context.deliveryZoneInfo || null);
      setRoomChargeContext(context.roomChargeContext || null);
      if (context.editMode) {
        setCurrentEditOrderId(context.editOrderId);
        setCurrentEditSupabaseId(context.editSupabaseId);
        setCurrentEditOrderNumber(context.editOrderNumber);
        setCurrentEditSourceOrderType(context.editSourceOrderType);
        setEditHeaders(context.editHeaders);
        setEditingOrderType(context.orderType);
        setShowMenuModal(false);
        setShowEditMenuModal(true);
      } else {
        setShowEditMenuModal(false);
        setShowMenuModal(true);
      }
    }, [restoreCheckoutRequestId]);
    useEffect(() => {
      if (!organizationId || !effectiveBranchId || !resolvedTerminalId) return;
      let mounted = true;
      void getCheckoutDraftStore().then(owner => owner.load()).then(saved => {
        if (mounted && saved && (saved.cartItems.length || saved.phase === "checkout_pending")) {
          restoreCheckoutContext({ ...saved.context, checkoutRequestId: saved.checkoutRequestId, checkoutPhase: saved.phase });
        }
      }).catch(() => { /* Menu admission retains and displays a failed native read. */ });
      return () => { mounted = false; };
    }, [organizationId, effectiveBranchId, resolvedTerminalId, restoreCheckoutContext]);
    const acceptRecoveredCheckout = async () => {
      resetCheckoutRequestId();
      setRestoredCheckoutContext(null);
      await silentRefresh();
      void refetchTables();
    };

    const handleOrderComplete = async (orderData: any): Promise<boolean> => {
      const isSplitPayment = orderData.paymentData?.method === "pending";
      const isTablePaymentSave = orderData.paymentData?.method === "table";
      let createdOrderId: string | undefined;
      let orderPersisted = false;
      const finishOrderCompletion = (
        succeeded: boolean,
        chargedNotSaved = false,
      ): boolean => {
        const outcome = resolveOrderCompletionOutcome({
          succeeded,
          orderPersisted,
          chargedNotSaved,
        });
        if (outcome.resetOrderUiState) {
          resetCheckoutRequestId();
          setRestoredCheckoutContext(null);
          setShowMenuModal(false);
          setSelectedOrderType(null);
          setExistingCustomer(null);
          setCustomerInfo({ name: "", phone: "" });
          setSelectedTable(null);
          setTableNumber("");
          setTableGuestCount(1);
        }
        return outcome.completionResult;
      };
      try {
        debugLog(
          "[OrderDashboard.handleOrderComplete] orderData:",
          orderData,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] orderData.items with notes:",
          orderData.items?.map((item: any) => ({
            name: item.name,
            notes: item.notes,
            special_instructions: item.special_instructions,
          })),
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] orderData.address:",
          orderData.address,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] existingCustomer:",
          existingCustomer,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] existingCustomer?.address:",
          existingCustomer?.address,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] customerInfo:",
          customerInfo,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] customerInfo?.address:",
          customerInfo?.address,
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] getSelectedAddress():",
          getSelectedAddress(),
        );
        debugLog(
          "[OrderDashboard.handleOrderComplete] selectedOrderType:",
          selectedOrderType,
        );

        // Build delivery address string from multiple address sources
        let deliveryAddress: string | null = null;
        let deliveryCity: string | null = null;
        let deliveryPostalCode: string | null = null;
        let deliveryFloor: string | null = null;
        let deliveryNotes: string | null = null;
        let nameOnRinger: string | null = null;

        if (selectedOrderType === "delivery") {
          // Priority order for address resolution:
          // 1. orderData.address (from MenuModal)
          // 2. getSelectedAddress() (from state)
          // 3. existingCustomer.address (legacy field from customers table)
          // 4. customerInfo.address (from state)
          const addr = orderData.address || getSelectedAddress();
          const legacyCustomerAddress = existingCustomer?.address;
          const customerInfoAddress = customerInfo?.address;

          debugLog("[OrderDashboard.handleOrderComplete] addr:", addr);
          debugLog(
            "[OrderDashboard.handleOrderComplete] legacyCustomerAddress:",
            legacyCustomerAddress,
          );
          debugLog(
            "[OrderDashboard.handleOrderComplete] customerInfoAddress:",
            customerInfoAddress,
          );

          if (addr) {
            // Handle both string addresses and structured address objects
            if (typeof addr === "string") {
              deliveryAddress = addr;
            } else {
              const parts: string[] = [];
              // Check all possible field names for street
              const streetValue = addr.street_address || addr.street;
              if (streetValue) {
                parts.push(streetValue);
                deliveryAddress = streetValue; // Store individual field
              }
              if (addr.city) {
                parts.push(addr.city);
                deliveryCity = addr.city;
              }
              // Check all possible field names for postal code
              const postalValue = addr.postal_code || addr.postalCode;
              if (postalValue) {
                parts.push(postalValue);
                deliveryPostalCode = postalValue;
              }
              // Include floor number if available
              const floorValue = addr.floor_number || addr.floor;
              if (floorValue) {
                const floorPart = `Floor: ${floorValue}`;
                parts.push(floorPart);
                deliveryFloor = String(floorValue);
              }
              // Extract delivery notes
              const notesValue = addr.delivery_notes || addr.notes;
              if (notesValue) {
                deliveryNotes = notesValue;
              }
              // Extract name on ringer
              const ringerValue = addr.name_on_ringer || addr.nameOnRinger;
              if (ringerValue) {
                nameOnRinger = ringerValue;
              }
              // Build concatenated address string for display
              if (!deliveryAddress && parts.length > 0) {
                deliveryAddress = parts.filter(Boolean).join(", ");
              }
            }
          }

          // Fallback to legacy customer.address field if no structured address found
          if (!deliveryAddress && legacyCustomerAddress) {
            deliveryAddress = legacyCustomerAddress;
          }

          // Fallback to customerInfo.address from state
          if (!deliveryAddress && customerInfoAddress) {
            if (typeof customerInfoAddress === "string") {
              deliveryAddress = customerInfoAddress;
            } else if (customerInfoAddress.street) {
              const parts: string[] = [];
              if (customerInfoAddress.street) {
                parts.push(customerInfoAddress.street);
                if (!deliveryAddress)
                  deliveryAddress = customerInfoAddress.street;
              }
              if (customerInfoAddress.city) {
                parts.push(customerInfoAddress.city);
                if (!deliveryCity) deliveryCity = customerInfoAddress.city;
              }
              if (customerInfoAddress.postalCode) {
                parts.push(customerInfoAddress.postalCode);
                if (!deliveryPostalCode)
                  deliveryPostalCode = customerInfoAddress.postalCode;
              }
              if (!deliveryAddress)
                deliveryAddress = parts.filter(Boolean).join(", ");
            }
          }

          debugLog(
            "[OrderDashboard.handleOrderComplete] deliveryAddress built:",
            deliveryAddress,
          );
          debugLog(
            "[OrderDashboard.handleOrderComplete] Individual fields:",
            {
              deliveryCity,
              deliveryPostalCode,
              deliveryFloor,
              deliveryNotes,
              nameOnRinger,
            },
          );

          // Final fallback: Query customer from database if we have customerId but no address yet
          const persistedCustomerId = resolvePersistedCustomerId(
            existingCustomer?.id,
            orderData.customer?.id,
          );
          if (!deliveryAddress && persistedCustomerId) {
            debugLog(
              "[OrderDashboard.handleOrderComplete] Attempting database fallback for customerId:",
              persistedCustomerId,
            );
            try {
              const dbCustomer = (await bridge.customers.lookupById(
                persistedCustomerId,
              )) as Customer | null;
              if (dbCustomer) {
                const dbResolvedAddress = resolveCanonicalCustomerAddress(
                  withMaterializedCustomerAddresses(
                    dbCustomer as OrderFlowCustomer,
                  ),
                );
                debugLog(
                  "[OrderDashboard.handleOrderComplete] Database customer found:",
                  dbCustomer,
                );
                if (dbResolvedAddress) {
                  const parts: string[] = [];
                  const streetValue =
                    dbResolvedAddress.street_address || dbResolvedAddress.street;
                  if (streetValue) {
                    parts.push(streetValue);
                    if (!deliveryAddress) deliveryAddress = streetValue;
                  }
                  if (dbResolvedAddress.city) {
                    parts.push(dbResolvedAddress.city);
                    if (!deliveryCity) deliveryCity = dbResolvedAddress.city;
                  }
                  if (dbResolvedAddress.postal_code) {
                    parts.push(dbResolvedAddress.postal_code);
                    if (!deliveryPostalCode)
                      deliveryPostalCode = dbResolvedAddress.postal_code;
                  }
                  if (dbResolvedAddress.floor_number || dbResolvedAddress.floor) {
                    if (!deliveryFloor)
                      deliveryFloor = String(
                        dbResolvedAddress.floor_number ||
                          dbResolvedAddress.floor,
                      );
                  }
                  if (
                    dbResolvedAddress.delivery_notes ||
                    dbResolvedAddress.notes
                  ) {
                    if (!deliveryNotes)
                      deliveryNotes =
                        dbResolvedAddress.delivery_notes ||
                        dbResolvedAddress.notes ||
                        null;
                  }
                  if (
                    dbResolvedAddress.name_on_ringer ||
                    dbResolvedAddress.nameOnRinger
                  ) {
                    if (!nameOnRinger)
                      nameOnRinger =
                        dbResolvedAddress.name_on_ringer ||
                        dbResolvedAddress.nameOnRinger;
                  }
                  if (!deliveryAddress)
                    deliveryAddress = parts.filter(Boolean).join(", ");
                  debugLog(
                    "[OrderDashboard.handleOrderComplete] Database fallback address from addresses[]:",
                    deliveryAddress,
                  );
                }
                // Check legacy customer.address field (simple string)
                else if (dbCustomer.address) {
                  deliveryAddress = dbCustomer.address;
                  debugLog(
                    "[OrderDashboard.handleOrderComplete] Database fallback address from customer.address:",
                    deliveryAddress,
                  );
                }
              }
            } catch (err) {
              console.error(
                "[OrderDashboard.handleOrderComplete] Database fallback failed:",
                err,
              );
            }
          }

          // Validate that delivery orders have an address - show error if still missing
          if (!deliveryAddress) {
            console.error(
              "[OrderDashboard.handleOrderComplete] ❌ No address found for delivery order!",
            );
            console.error(
              "[OrderDashboard.handleOrderComplete] Available sources:",
              {
                orderDataAddress: orderData.address,
                selectedAddress: getSelectedAddress(),
                existingCustomerAddress: legacyCustomerAddress,
                customerInfoAddress: customerInfoAddress,
                customerId: persistedCustomerId,
              },
            );
            toast.error(t("orderDashboard.addressRequired"));
            return finishOrderCompletion(false); // Prevent order creation without address
          }
        }

        // Calculate totals
        // Note: item.totalPrice already includes quantity (from MenuModal), so don't multiply again
        // If item.totalPrice is not available, use (price * quantity) as fallback
        const subtotal =
          orderData.items?.reduce((sum: number, item: any) => {
            if (item.totalPrice !== undefined && item.totalPrice !== null) {
              // totalPrice already includes quantity
              return sum + item.totalPrice;
            }
            // Fallback: multiply price by quantity
            return sum + (item.price || 0) * (item.quantity || 1);
          }, 0) ||
          orderData.total ||
          0;
        const manualDiscountAmount = Number(orderData.discountAmount || 0);
        const couponDiscountAmount = Math.max(
          0,
          Number(orderData.coupon_discount_amount || 0),
        );
        const loyaltyRedemption =
          hasLoyaltyModule &&
          orderData.loyalty_redemption &&
          typeof orderData.loyalty_redemption === "object"
            ? orderData.loyalty_redemption
            : null;
        const loyaltyDiscountAmount = Math.max(
          0,
          Number(
            orderData.loyalty_discount_amount ??
              loyaltyRedemption?.discount_amount ??
              0,
          ),
        );
        const totalDiscountAmount = Math.max(
          0,
          Number(
            orderData.total_discount_amount ??
              manualDiscountAmount + couponDiscountAmount + loyaltyDiscountAmount,
          ),
        );
        const discountPercentage = orderData.discountPercentage || 0;
        const manualDiscountMode: "percentage" | "fixed" | null =
          orderData.manualDiscountMode ||
          (discountPercentage > 0 ? "percentage" : null);
        const manualDiscountValue =
          orderData.manualDiscountValue ??
          (manualDiscountMode === "percentage"
            ? discountPercentage
            : manualDiscountAmount);
        const couponId =
          typeof orderData.coupon_id === "string" ? orderData.coupon_id : null;
        const couponCode =
          typeof orderData.coupon_code === "string"
            ? orderData.coupon_code
            : null;
        const isGhostOrder =
          orderData.is_ghost === true ||
          orderData.isGhost === true ||
          orderData.ghost === true;
        const ghostSource = isGhostOrder
          ? typeof orderData.ghost_source === "string"
            ? orderData.ghost_source
            : "manual_code_x_1"
          : null;
        const ghostMetadata = isGhostOrder
          ? (orderData.ghost_metadata ?? null)
          : null;

        const deliveryFee =
          selectedOrderType === "delivery"
            ? Number(
                orderData.deliveryFee ??
                  resolveDeliveryFee(orderData.deliveryZoneInfo),
              )
            : 0;

        const tipAmount = Math.max(
          0,
          Number(orderData.paymentData?.tipAmount ?? orderData.paymentData?.tip_amount ?? 0) || 0,
        );
        const requestedTipRecipientRole = String(
          orderData.paymentData?.tipRecipientRole || "",
        );
        const tipRecipientRole: "waiter" | "cashier" | "driver" | undefined =
          tipAmount > 0 &&
          ["waiter", "cashier", "driver"].includes(requestedTipRecipientRole)
            ? (requestedTipRecipientRole as "waiter" | "cashier" | "driver")
            : undefined;
        const actualWaiterId =
          selectedTable?.currentWaiterId || staff?.staffId || undefined;
        const actualWaiterShiftId =
          actualWaiterId && actualWaiterId === staff?.staffId
            ? activeShift?.id
            : undefined;
        const tipRecipientStaffId =
          tipRecipientRole === "waiter" ? actualWaiterId : undefined;
        const tipRecipientStaffShiftId =
          tipRecipientRole === "waiter" ? actualWaiterShiftId : undefined;
        const total = subtotal - totalDiscountAmount + deliveryFee + tipAmount;
        const paymentMethod =
          typeof orderData.paymentData?.method === "string"
            ? orderData.paymentData.method
            : null;
        const isRoomChargePayment = paymentMethod === "room_charge";
        const roomId =
          orderData.paymentData?.roomId ||
          orderData.paymentData?.room_id ||
          orderData.roomId ||
          orderData.room_id ||
          null;
        const collectionAttribution = resolveAdjustmentAttribution({
          databaseStaffId: staff?.databaseStaffId,
          shiftStaffOwnerId: activeShift?.staff_id,
          staffShiftId: activeShift?.id,
          candidateStaffIds: [staff?.staffId],
        });
        const initialPayment =
          !isGhostOrder &&
          !isSplitPayment &&
          (paymentMethod === "cash" ||
            paymentMethod === "card" ||
            paymentMethod === "room_charge" || paymentMethod === "twint")
            ? {
                ...collectionAttribution,
                collectedBy: ['cashier', 'manager'].includes(activeShift?.role_type ?? '') ? 'cashier_drawer' : undefined,
                method: paymentMethod,
                payment_method: paymentMethod,
                amount: total,
                cashReceived:
                  paymentMethod === "cash"
                    ? orderData.paymentData?.cashReceived
                    : undefined,
                changeGiven:
                  paymentMethod === "cash"
                    ? orderData.paymentData?.change
                    : undefined,
                transactionRef: orderData.paymentData?.transactionId,
                idempotencyKey: orderData.paymentData?.idempotencyKey,
                currency: orderData.paymentData?.currency,
                metadata: orderData.paymentData?.metadata,
                tipAmount,
                tipRecipientRole,
                tipRecipientStaffId,
                tipRecipientStaffShiftId,
              }
            : undefined;

        const existingOrderId = orderData.paymentData?.existingOrderId;
        if (existingOrderId && (paymentMethod === "cash" || paymentMethod === "card" || paymentMethod === "twint")) {
          // Existing-order guard: continue the modal's claim or take the
          // order's ordinary claim before the first await of this write.
          const givenOwner: OrdinaryCollectionOwner | null =
            orderData.paymentData?.ordinaryOwner ?? null;
          const fallbackClaim = givenOwner
            ? null
            : claimOrdinaryCollectionOwner(collectionScope, existingOrderId);
          if (fallbackClaim && !fallbackClaim.claimed) {
            throw new Error(ordinaryRefusalText(fallbackClaim.code));
          }
          const fallbackOwner =
            givenOwner ?? (fallbackClaim?.claimed ? fallbackClaim.owner : null);
          if (!fallbackOwner) {
            throw new Error(ordinaryRefusalText("GIFT_CARD_HOLD_NOT_CURRENT"));
          }
          let askBeforeFallbackPrint = false;
          let fallbackRun: OrdinaryCollectionRun<any>;
          try {
            askBeforeFallbackPrint = await shouldAskPaymentPrint();
            fallbackRun = await runOrdinaryCollection<any>(
              fallbackOwner,
              {
                method: paymentMethod,
                amount: total,
                transactionRef: orderData.paymentData?.transactionId ?? null,
                idempotencyKey: orderData.paymentData?.idempotencyKey ?? null,
                settlementGeneration: null,
                terminalTransactionId: null,
              },
              async () => {
                let raw: unknown;
                let threw = false;
                try {
                  raw = await bridge.payments.recordPayment({
                    orderId: existingOrderId,
                    method: paymentMethod,
                    amount: total,
                    cashReceived:
                      paymentMethod === "cash"
                        ? orderData.paymentData?.cashReceived
                        : undefined,
                    changeGiven:
                      paymentMethod === "cash"
                        ? orderData.paymentData?.change
                        : undefined,
                    transactionRef: orderData.paymentData?.transactionId,
                    idempotencyKey: orderData.paymentData?.idempotencyKey,
                    currency: orderData.paymentData?.currency,
                    metadata: orderData.paymentData?.metadata,
                    tipAmount,
                    tipRecipientRole,
                    tipRecipientStaffId,
                    tipRecipientStaffShiftId,
                  });
                } catch {
                  threw = true;
                }
                const facts = readOrdinaryWriteReply(raw, threw);
                noteOrdinaryWriteFacts(fallbackOwner, facts);
                return { verdict: classifyOrdinaryWrite(facts), value: raw, code: facts.code };
              },
            );
          } finally {
            // Ends a claim taken here only while nothing was sent under it.
            if (!givenOwner) releaseOrdinaryOwnerBeforeSend(fallbackOwner);
          }
          if (fallbackRun.status === "refused") {
            throw new Error(ordinaryRefusalText(fallbackRun.code));
          }
          const paymentResult: any = fallbackRun.value;
          if (fallbackRun.status === "unknown") {
            throw new Error(
              t("orderDashboard.collectPaymentFailed", {
                defaultValue: "Failed to collect payment",
              }),
            );
          }
          if (fallbackRun.status !== "completed") {
            throw new Error(paymentResult?.error || "Failed to record payment");
          }
          await silentRefresh().catch((err) => {
            console.debug("[OrderDashboard] Silent refresh after fallback payment failed:", err);
          });
          finalizeCreatedOrderPayment(existingOrderId, isGhostOrder, {
            askBeforePrint: askBeforeFallbackPrint,
            autoPrintSuppressed: askBeforeFallbackPrint,
            amount: total,
          }).catch(
            (printError: any) => {
              if (isGhostOrder) {
                console.error(
                  "[OrderDashboard] Fallback receipt print error:",
                  printError,
                );
                toast.error(
                  t("orderDashboard.printFailed", {
                    defaultValue: "Receipt print failed",
                  }),
                );
                return undefined;
              }

              console.warn(
                "[OrderDashboard] Fallback fiscal print error (non-blocking):",
                printError,
              );
              toast.error(
                t("orderDashboard.fiscalPrintFailed", {
                  defaultValue: "Cash register print failed",
                }),
              );
            },
          );
          return finishOrderCompletion(true);
        }

        const isTableOrder =
          orderType === "dine-in" ||
          orderData.orderType === "dine-in" ||
          isTablePaymentSave ||
          Boolean(tableNumber?.trim());
        const tableOrderFields = buildTableOrderCreateFields({
          serviceOrderType: isTableOrder
            ? "dine-in"
            : selectedOrderType || orderData.orderType || "pickup",
          pricingOrderType: selectedOrderType || orderData.orderType || "pickup",
          table: selectedTable,
          tableNumber,
          tableSessionId: selectedTable?.tableSessionId || null,
          guestCount: tableGuestCount,
        });
        const {
          order_type: tableOrderType,
          ...tableOrderCreateFields
        } = tableOrderFields;
        const isPickupOrder = !isTableOrder &&
          (selectedOrderType || orderData.orderType || orderType || "pickup") === "pickup";
        const persistedCustomerName = isTableOrder
          ? pickMeaningfulOrderCustomerName(
              orderData.customer?.name,
              orderData.customer?.full_name,
              customerInfo?.name,
              existingCustomer?.name,
            )
          : isPickupOrder
            ? pickMeaningfulOrderCustomerName(
                orderData.customer?.name,
                orderData.customer?.full_name,
              )
            : pickMeaningfulOrderCustomerName(
                orderData.customer?.name,
                orderData.customer?.full_name,
                customerInfo?.name,
                existingCustomer?.name,
              );

        const persistedCustomerId = resolvePersistedCustomerId(
          orderData.customer?.id,
          existingCustomer?.id,
        );
        const askBeforeReceiptPrint =
          !isSplitPayment && !isTableOrder && (Boolean(initialPayment) || isGhostOrder)
            ? await shouldAskPaymentPrint()
            : false;

        // Create order object
        const orderToCreate = {
          clientRequestId: takeCheckoutRequestId(orderData.clientRequestId),
          customer_id: persistedCustomerId,
          customerId: persistedCustomerId,
          customer_name: persistedCustomerName ?? undefined,
          customer_phone:
            isPickupOrder
              ? orderData.customer?.phone_number ?? orderData.customer?.phone ?? ""
              : orderData.customer?.phone_number ||
                orderData.customer?.phone ||
                customerInfo?.phone ||
                existingCustomer?.phone ||
                "",
          items: normalizePosOrderItems(orderData.items || []),
          total_amount: total,
          subtotal: subtotal,
          discount_amount: totalDiscountAmount,
          tip_amount: tipAmount,
          discount_percentage: discountPercentage,
          manual_discount_mode: manualDiscountMode,
          manual_discount_value: manualDiscountValue,
          coupon_id: couponId,
          // Leave coupon_code null at create-time; redemption flow finalizes the code after usage increment.
          coupon_code: null,
          coupon_discount_amount: couponDiscountAmount,
          delivery_fee: deliveryFee,
          is_ghost: isGhostOrder,
          ghost_source: ghostSource,
          ghost_metadata: ghostMetadata,
          branch_id: effectiveBranchId || null,
          organization_id: organizationId || null,
          status: "pending" as const,
          order_type: (tableOrderType ||
            selectedOrderType ||
            "pickup") as Order["orderType"],
          payment_method: isGhostOrder
            ? null
            : paymentMethod || "cash",
          room_id: isRoomChargePayment ? roomId : null,
          roomId: isRoomChargePayment ? roomId : null,
          ...tableOrderCreateFields,
          initialPayment,
          skipAutoPrint: askBeforeReceiptPrint,
          skip_auto_print: askBeforeReceiptPrint,
          // Full delivery address fields for proper sync to Supabase
          delivery_address: deliveryAddress,
          ...(selectedOrderType === "delivery" ? orderCreateDeliveryLocation(
            { address: deliveryAddress, city: deliveryCity, postal: deliveryPostalCode },
            orderData.address || getSelectedAddress(), orderData.deliveryZoneInfo,
          ) : {}),
          delivery_city: deliveryCity,
          delivery_postal_code: deliveryPostalCode,
          delivery_floor: deliveryFloor,
          delivery_notes: deliveryNotes,
          name_on_ringer: nameOnRinger,
          notes: orderData.notes || null,
          staff_id: isTableOrder ? actualWaiterId || null : undefined,
          staff_shift_id: isTableOrder ? actualWaiterShiftId || null : undefined,
        };

        debugLog(
          "[OrderDashboard] Creating order with data:",
          orderToCreate,
        );

        const result = await createOrder(orderToCreate as any);

        if (result.success) {
          createdOrderId = result.orderId;
          orderPersisted = true;
          // The order exists: the next checkout is a new one.
          resetCheckoutRequestId();

          const roomCharge = (result as any).roomCharge;
        if (isRoomChargePayment && orderData.paymentData) orderData.paymentData.roomChargeApplied = roomCharge?.applied === true;
          if (isRoomChargePayment && roomCharge?.applied === false && result.orderId) {
            await silentRefresh().catch((err) => {
              console.debug("[OrderDashboard] Silent refresh after room-charge fallback failed:", err);
            });
            orderData.paymentData.existingOrderId = result.orderId;
            orderData.paymentData.existingOrderNumber = result.orderNumber;
            orderData.paymentData.roomChargeFallback = true;
            orderData.paymentData.roomChargeFallbackReason =
              roomCharge.code || roomCharge.error || "room_charge_not_applied";
            return false;
          }

          if (isTableOrder && result.orderId && selectedTable) {
            const tableSessionOpenPayload = buildTableSessionOpenPayload({
              table: selectedTable,
              orderId: result.orderId,
              orderResult: result as any,
              orderData: orderToCreate as any,
              guestCount: tableGuestCount,
              customerName:
                persistedCustomerName ||
                `Table ${selectedTable.tableNumber}`,
            });
            try {
              const sessionResult = await posApiPost<{
                success?: boolean;
                session?: { id?: string };
                table?: unknown;
                error?: string;
              }>("/api/pos/table-sessions", tableSessionOpenPayload);
              const sessionPayload = sessionResult.data;
              if (!sessionResult.success || sessionPayload?.success === false) {
                throw new Error(
                  sessionResult.error ||
                    sessionPayload?.error ||
                    "Failed to open table session",
                );
              }
              const sessionId =
                sessionPayload?.session?.id ||
                selectedTable.tableSessionId ||
                null;
              await updateTableStatus(
                selectedTable.id,
                "occupied",
                {
                  action: "assign_order",
                  current_order_id: result.orderId,
                  table_session_id: sessionId,
                  guest_count: tableGuestCount,
                  order_total: total,
                  paid_total: 0,
                  outstanding_balance: total,
                  payment_status: "pending",
                  customer_name:
                    persistedCustomerName ||
                    `Table ${selectedTable.tableNumber}`,
                  occupied_since: new Date().toISOString(),
                },
              );
            } catch (sessionError) {
              console.warn(
                "[OrderDashboard] Table session open failed, falling back to table status assignment:",
                sessionError,
              );
              let queuedTableSessionRetry = false;
              try {
                await enqueueTableSessionOpen({
                  organizationId,
                  branchId: effectiveBranchId || branchId || null,
                  payload: tableSessionOpenPayload,
                });
                queuedTableSessionRetry = true;
              } catch (queueError) {
                console.warn(
                  "[OrderDashboard] Failed to queue table session open:",
                  queueError,
                );
              }
              await updateTableStatus(selectedTable.id, "occupied", {
                action: "assign_order",
                current_order_id: result.orderId,
                table_session_id: selectedTable.tableSessionId || null,
                guest_count: tableGuestCount,
                order_total: total,
                paid_total: 0,
                outstanding_balance: total,
                payment_status: "pending",
                customer_name:
                  persistedCustomerName ||
                  `Table ${selectedTable.tableNumber}`,
                occupied_since: new Date().toISOString(),
              });
              if (queuedTableSessionRetry) {
                toast.success(
                  t("orderDashboard.tableSessionQueued", {
                    defaultValue:
                      "Table saved locally; session sync queued.",
                  }),
                );
              } else {
                toast.error(
                  t("orderDashboard.tableSessionSyncFailed", {
                    defaultValue:
                      "Order saved, but table-session sync needs retry.",
                  }),
                );
              }
            }
          }

          // Capture split payment data for the SplitPaymentModal (rendered in OrderDashboard).
          // This must happen before finishOrderCompletion closes MenuModal.
          if (isSplitPayment && createdOrderId) {
            setSplitPaymentData({
              kind: "new-order",
              orderId: createdOrderId,
              orderTotal: total,
              items: buildSplitPaymentItems({
                items: (orderData.items || []).map(
                  (item: any, index: number) => ({
                    name: item.name || "Item",
                    quantity: item.quantity || 1,
                    price: item.unitPrice || item.price || 0,
                    totalPrice:
                      item.totalPrice ||
                      (item.unitPrice || item.price || 0) *
                        (item.quantity || 1),
                    itemIndex: item.itemIndex ?? index,
                  }),
                ),
                orderTotal: total,
                deliveryFee,
                discountAmount: totalDiscountAmount,
                deliveryFeeLabel: t("payment.fields.deliveryFee", {
                  defaultValue: "Delivery Fee",
                }),
                discountLabel: t("modals.payment.discount", {
                  defaultValue: "Discount",
                }),
                adjustmentLabel: t("splitPayment.adjustment", {
                  defaultValue: "Adjustment",
                }),
              }),
              isGhostOrder,
              initialMode: "by-items",
              orderNumber: result.orderNumber,
              orderType: selectedOrderType || "pickup",
              tipAmount,
              tipRecipientRole,
              tipRecipientStaffId,
              tipRecipientStaffShiftId,
            });
          }

          toast.success(
            isTableOrder
              ? t("orderDashboard.orderSavedToTable", {
                  defaultValue: "Order saved to table",
                })
              : t("orderDashboard.orderCreated"),
          );
          // A saved table order moves the table to "occupied". If the active
          // status filter no longer matches (e.g. it was "reserved"), the grid
          // would show an empty "no tables" state even though the save succeeded,
          // making the table look like it disappeared. Recover by switching the
          // filter to "occupied" so the saved table stays visible. Leave "all"
          // and an already-"occupied" filter untouched (the table still matches).
          if (
            isTableOrder &&
            selectedTable &&
            tableStatusFilter !== "all" &&
            tableStatusFilter !== "occupied"
          ) {
            setTableStatusFilter("occupied");
          }
          // Refresh orders in background - don't block UI
          silentRefresh().catch((err) => {
            console.debug("[OrderDashboard] Background refresh error:", err);
          });

          if (!isGhostOrder && couponId && result.orderId) {
            couponRedemptionService
              .redeemOrQueue({
                couponId,
                couponCode,
                orderId: result.orderId,
                discountAmount: couponDiscountAmount,
              })
              .catch((error) => {
                console.warn(
                  "[OrderDashboard] Failed to enqueue coupon redemption retry:",
                  error,
                );
              });
          }

          if (hasLoyaltyModule && !isGhostOrder && loyaltyRedemption && result.orderId) {
            const redeemCustomerId = resolvePersistedCustomerId(
              loyaltyRedemption.customer_id,
              orderToCreate.customer_id,
              orderToCreate.customerId,
            );
            const redeemPoints = Math.max(
              0,
              Math.trunc(Number(loyaltyRedemption.points_redeemed || 0)),
            );

            if (redeemCustomerId && redeemPoints > 0) {
              bridge.loyalty
                .redeemPoints({
                  customerId: redeemCustomerId,
                  points: redeemPoints,
                  orderId: result.orderId,
                })
                .then((res: any) => {
                  if (res?.success) {
                    toast.success(
                      t("loyalty.redeemSuccess", {
                        points: redeemPoints,
                        discount: formatCurrency(
                          Number(res.discountValue ?? loyaltyDiscountAmount),
                        ),
                        defaultValue:
                          "Redeemed {{points}} points for {{discount}} discount",
                      }),
                    );
                    return undefined;
                  }
                  throw new Error(res?.error || "Loyalty redemption failed");
                })
                .catch((error: any) => {
                  console.warn(
                    "[OrderDashboard] Loyalty redemption failed:",
                    error,
                  );
                  toast.error(
                    t("loyalty.redeemFailed", {
                      defaultValue:
                        "Order saved, but loyalty points were not redeemed",
                    }),
                  );
                });
            }
          }

          if (result.orderId && !isSplitPayment && !isTableOrder) {
            if (initialPayment) {
              await silentRefresh().catch((err) => {
                console.debug(
                  "[OrderDashboard] Silent refresh after inline payment create failed:",
                  err,
                );
              });
            }
            finalizeCreatedOrderPayment(result.orderId, isGhostOrder, {
              askBeforePrint: askBeforeReceiptPrint,
              autoPrintSuppressed: askBeforeReceiptPrint,
              amount: total,
              orderNumber: result.orderNumber || null,
            }).catch(
              (printError: any) => {
                if (isGhostOrder) {
                  console.error(
                    "[OrderDashboard] Ghost receipt print error:",
                    printError,
                  );
                      toast.error(
                        t("orderDashboard.printFailed", {
                          defaultValue: "Receipt print failed",
                        }),
                      );
                      return undefined;
                    }

                console.warn(
                  "[OrderDashboard] Cash register print error (non-blocking):",
                  printError,
                );
                toast.error(
                  t("orderDashboard.fiscalPrintFailed", {
                    defaultValue: "Cash register print failed",
                  }),
                );
              },
            );

            // Auto-earn loyalty points (fire-and-forget, non-blocking)
            const loyaltyCustomerId = orderToCreate.customer_id;
            if (hasLoyaltyModule && loyaltyCustomerId && !isGhostOrder) {
              bridge.loyalty
                .earnPoints({
                  customerId: loyaltyCustomerId,
                  orderId: result.orderId,
                  amount: total,
                })
                .then((res: any) => {
                  if (res?.success && res?.pointsEarned > 0) {
                    toast.success(
                      t("loyalty.pointsEarned", {
                        points: res.pointsEarned,
                        defaultValue: "+{{points}} loyalty points earned",
                      }),
                    );
                  }
                })
                .catch((err: any) => {
                  console.warn(
                    "[OrderDashboard] Loyalty points earn failed:",
                    err,
                  );
                });
            }
          } else if (!isTableOrder) {
            console.warn(
              "[OrderDashboard] No orderId in result, skipping auto-print",
            );
          }

          return finishOrderCompletion(true);
        } else if (result.paymentNotSaved) {
          // Item E: the card was charged and the order could not be saved
          // yet. The till holds the order and its payment; the checkout ends
          // here (a retry from this cart would be a new checkout and a second
          // charge) and the banner offers "Save payment again".
          notifyPaymentNotSaved(result, t);
          announceUnsavedCheckoutChanged();
          return finishOrderCompletion(false, true);
        } else if (isCheckoutOutcomeUnknown(result)) {
          // The payment has no answer yet (fix review 30/09/2026): the cart
          // and its checkout id stay, so Pay again checks the same payment.
          notifyCheckoutOutcomeUnknown(result, t);
          return finishOrderCompletion(false);
        } else {
          toast.error(result.error || t("orderDashboard.orderCreateFailed"));
          return finishOrderCompletion(false);
        }
      } catch (error) {
        console.error("Error creating order:", error);
        toast.error(t("orderDashboard.orderCreateFailed"));
        // If the order persisted before the throw, finishOrderCompletion still
        // finalizes the UI — retrying from a stale cart would duplicate it.
        return finishOrderCompletion(false);
      }
    };

    // Handle split payment completion — dismiss the modal and refresh orders
    const resetEditOrderState = useCallback(() => {
      setShowEditOrderModal(false);
      setShowEditMenuModal(false);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
      setCurrentEditOrderId(undefined);
      setCurrentEditOrderNumber(undefined);
      setCurrentEditSupabaseId(undefined);
      setCurrentEditSourceOrderType(undefined);
      setEditHeaders(undefined);
    }, []);

    const normalizeEditOrderItems = useCallback(
      (items: any[]): OrderItem[] =>
        normalizePosOrderItems(items).map((item: any, index: number) => {
          const quantity = Math.max(0, Number(item.quantity || 0));
          const unitPrice = Number(
            item.unit_price ?? item.unitPrice ?? item.price ?? 0,
          );
          const originalUnitPrice = Number(
            item.original_unit_price ?? item.originalUnitPrice ?? unitPrice,
          );
          const totalPrice = Number(
            item.total_price ?? item.totalPrice ?? unitPrice * quantity,
          );

          return {
            id: String(
              item.id ||
                item.menu_item_id ||
                item.menuItemId ||
                `item-${index}`,
            ),
            order_item_id:
              item.order_item_id ??
              item.orderItemId ??
              item.source_order_item_id ??
              item.sourceOrderItemId ??
              item.original_order_item_id ??
              item.originalOrderItemId ??
              null,
            orderItemId:
              item.orderItemId ??
              item.order_item_id ??
              item.sourceOrderItemId ??
              item.source_order_item_id ??
              item.originalOrderItemId ??
              item.original_order_item_id ??
              null,
            source_order_item_id:
              item.source_order_item_id ??
              item.order_item_id ??
              item.orderItemId ??
              item.original_order_item_id ??
              item.originalOrderItemId ??
              null,
            sourceOrderItemId:
              item.sourceOrderItemId ??
              item.orderItemId ??
              item.order_item_id ??
              item.originalOrderItemId ??
              item.original_order_item_id ??
              null,
            menu_item_id: item.menu_item_id ?? item.menuItemId ?? null,
            menuItemId: item.menuItemId ?? item.menu_item_id ?? null,
            is_manual: item.is_manual === true,
            name: item.name || "Item",
            quantity,
            price: unitPrice,
            unit_price: unitPrice,
            total_price: totalPrice,
            original_unit_price: originalUnitPrice,
            is_price_overridden:
              item.is_price_overridden === true ||
              item.isPriceOverridden === true ||
              Math.abs(unitPrice - originalUnitPrice) > 0.0001,
            notes: item.notes || "",
            customizations: item.customizations || null,
            categoryName: item.categoryName || item.category_name || null,
          } as OrderItem;
        }),
      [],
    );

    const deriveEditSettlementPayload = useCallback(
      (
        order: Order | undefined,
        nextItems: OrderItem[],
        targetOrderType: EditableOrderType,
        taxRatePercentage: number,
      ): {
        financials?: Partial<OrderFinancialsUpdateParams>;
        orderUpdates?: Partial<EditSettlementOrderUpdates>;
      } => {
        if (!order) {
          return {};
        }

        const financials = deriveEditSettlementFinancials(
          order,
          nextItems,
          targetOrderType,
          taxRatePercentage,
        );

        const orderUpdates: Partial<EditSettlementOrderUpdates> = {
          orderType: targetOrderType,
        };

        // Forward customer + delivery fields into orderUpdates so the
        // atomic edit-settlement preserves (and, for pickup→delivery
        // conversions, commits) the full final shape of the order. Before
        // this, only orderType + some null-outs were forwarded, which
        // left paid pickup→delivery converted orders with customer=null
        // and delivery_address=null even after the user went through the
        // phone-lookup + address flow (see order #00003 incident,
        // 2026-04-22). Reading from the most recent local order state
        // means that whatever the earlier bridge.orders.convertPickupToDelivery
        // call landed is preserved — and if anything was lost in transit,
        // the client-side source of truth (the local order row after the
        // silentRefresh) wins the final commit.
        const orderAny = order as any;
        const customerId =
          orderAny?.customer_id ??
          orderAny?.customerId ??
          null;
        const customerName =
          orderAny?.customer_name ??
          orderAny?.customerName ??
          null;
        const customerPhone =
          orderAny?.customer_phone ??
          orderAny?.customerPhone ??
          null;
        const customerEmail =
          orderAny?.customer_email ??
          orderAny?.customerEmail ??
          null;
        if (customerId !== undefined) {
          orderUpdates.customerId = customerId;
        }
        if (typeof customerName === "string" && customerName.trim()) {
          orderUpdates.customerName = customerName;
        }
        if (typeof customerPhone === "string" && customerPhone.trim()) {
          orderUpdates.customerPhone = customerPhone;
        }
        if (customerEmail !== undefined) {
          orderUpdates.customerEmail = customerEmail;
        }

        if (targetOrderType === "delivery") {
          orderUpdates.tableNumber = null;
          orderUpdates.waiterId = null;
          // Forward delivery address from the current order row so the
          // atomic commit re-affirms it. The earlier phone-lookup flow
          // ran bridge.orders.convertPickupToDelivery which writes these
          // server-side; reading them back here defends against any
          // partial-commit or server-side null-out that would leave the
          // row type-converted but address-less.
          const deliveryAddress =
            orderAny?.delivery_address ?? orderAny?.deliveryAddress ?? null;
          const deliveryCity =
            orderAny?.delivery_city ?? orderAny?.deliveryCity ?? null;
          const deliveryPostalCode =
            orderAny?.delivery_postal_code ??
            orderAny?.deliveryPostalCode ??
            null;
          const deliveryFloor =
            orderAny?.delivery_floor ?? orderAny?.deliveryFloor ?? null;
          const deliveryNotes =
            orderAny?.delivery_notes ?? orderAny?.deliveryNotes ?? null;
          const nameOnRinger =
            orderAny?.name_on_ringer ?? orderAny?.nameOnRinger ?? null;
          orderUpdates.deliveryAddress = deliveryAddress;
          orderUpdates.deliveryCity = deliveryCity;
          orderUpdates.deliveryPostalCode = deliveryPostalCode;
          orderUpdates.deliveryFloor = deliveryFloor;
          orderUpdates.deliveryNotes = deliveryNotes;
          orderUpdates.nameOnRinger = nameOnRinger;
        } else {
          orderUpdates.deliveryAddress = null;
          orderUpdates.deliveryCity = null;
          orderUpdates.deliveryPostalCode = null;
          orderUpdates.deliveryFloor = null;
          orderUpdates.deliveryNotes = null;
          orderUpdates.nameOnRinger = null;
          orderUpdates.driverId = null;
          orderUpdates.driverName = null;
        }

        if (targetOrderType === "pickup") {
          orderUpdates.tableNumber = null;
          orderUpdates.waiterId = null;
        }

        return {
          financials,
          orderUpdates,
        };
      },
      [getSetting],
    );

    const openEditSettlementCollectionPrompt = useCallback(
      (preview: OrderEditSettlementPreview, request: EditSettlementRequest) => {
        // New simple cash/card delta picker replaces the former
        // SplitPaymentModal routing for edit-settlement collect cases.
        // Amount = how much more the customer still owes after the edit.
        const amount = Math.max(
          0,
          Number(preview.nextTotal || 0) - Number(preview.paidTotal || 0),
        );
        setEditSettlementDeltaPrompt({
          mode: "collect",
          amount,
          orderNumber: request.orderNumber ?? null,
          preview,
          request,
        });
      },
      [],
    );

    const applySettlementAwareOrderEdit = useCallback(
      async (requests: EditSettlementRequest[]): Promise<void> => {
        const normalizedRequests = requests.map((request) => ({
          ...request,
          items: normalizeEditOrderItems(request.items),
        }));
        const isTableEditRequest = (request: EditSettlementRequest): boolean => {
          const sourceOrder = orders.find((order) => order.id === request.orderId);
          return (
            isTableServiceOrder(sourceOrder as any) ||
            isTableServiceOrder({
              ...(request.orderUpdates || {}),
              orderType: (request.orderUpdates as any)?.orderType,
              order_type: (request.orderUpdates as any)?.order_type,
            } as any)
          );
        };

        const previews = await Promise.all(
          normalizedRequests.map((request) =>
            bridge.orders.previewEditSettlement({
              orderId: request.orderId,
              items: request.items,
              orderNotes: request.orderNotes,
              financials: request.financials,
              orderUpdates: request.orderUpdates,
            }),
          ),
        );

        if (
          normalizedRequests.length > 1 &&
          previews.some((preview) => preview.requiredAction !== "none")
        ) {
          throw new Error(
            t("orderDashboard.bulkPaidEditUnsupported", {
              defaultValue:
                "Paid or partially paid orders with settlement changes must be edited one at a time.",
            }),
          );
        }

        if (
          normalizedRequests.length === 1 &&
          previews[0]?.requiredAction === "collect"
        ) {
          const request = normalizedRequests[0];
          resetEditOrderState();
          clearBulkSelection();
          setPendingEditRefundSettlement(null);

          if (isTableEditRequest(request)) {
            await bridge.orders.applyEditSettlement({
              orderId: request.orderId,
              items: request.items,
              orderNotes: request.orderNotes,
              financials: request.financials,
              orderUpdates: request.orderUpdates,
              action: { type: "mark_partial" },
            });
            toast.success(
              t("orderDashboard.tableOrderUpdated", {
                defaultValue: "Table check updated. Balance stays open until the customer pays.",
              }),
            );
            await silentRefresh().catch(() => {});
            void refetchTables();
            return;
          }

          openEditSettlementCollectionPrompt(previews[0], request);
          toast(
            t("orderDashboard.orderEditPaymentRequiredToSave", {
              defaultValue:
                "Choose how to collect the extra payment. The order edit will be saved after payment is recorded.",
            }),
          );
          return;
        }

        if (
          normalizedRequests.length === 1 &&
          previews[0]?.requiredAction === "refund"
        ) {
          resetEditOrderState();
          clearBulkSelection();
          // Only money the LOCAL payment rows hold is refunded (native
          // `refundAmount`): `paidTotal` also counts money the order proved
          // without a local row, which no refund can name.
          const refundAmount = resolveEditSettlementRefundAmount(previews[0]);
          setEditSettlementDeltaPrompt({
            mode: "refund",
            amount: refundAmount,
            orderNumber: normalizedRequests[0].orderNumber ?? null,
            preview: previews[0],
            request: normalizedRequests[0],
          });
          return;
        }

        for (const request of normalizedRequests) {
          await bridge.orders.applyEditSettlement({
            orderId: request.orderId,
            items: request.items,
            orderNotes: request.orderNotes,
            financials: request.financials,
            orderUpdates: request.orderUpdates,
            action: { type: "none" },
          });
        }

        toast.success(
          t("orderDashboard.orderItemsUpdated", {
            count: normalizedRequests.length,
          }),
        );
        setPendingEditRefundSettlement(null);
        resetEditOrderState();
        clearBulkSelection();
        await loadOrders();
      },
      [
        bridge.orders,
        clearBulkSelection,
        loadOrders,
        normalizeEditOrderItems,
        openEditSettlementCollectionPrompt,
        orders,
        refetchTables,
        resetEditOrderState,
        silentRefresh,
        t,
      ],
    );

    const handleEditRefundSettlementConfirm = useCallback(
      async (refunds: OrderEditSettlementRefund[]) => {
        if (!pendingEditRefundSettlement) {
          return;
        }

        const request = pendingEditRefundSettlement.request;
        await bridge.orders.applyEditSettlement({
          orderId: request.orderId,
          items: request.items,
          orderNotes: request.orderNotes,
          financials: request.financials,
          orderUpdates: request.orderUpdates,
          action: {
            type: "refund",
            refunds: refunds.map((refund) => {
              const attribution = resolveAdjustmentAttribution({
                databaseStaffId: staff?.databaseStaffId,
                shiftStaffOwnerId: activeShift?.staff_id,
                staffShiftId: refund.staffShiftId ?? activeShift?.id,
                candidateStaffIds: [refund.staffId, staff?.staffId],
              });

              return {
                ...refund,
                staffId: attribution.staffId,
                staffShiftId: attribution.staffShiftId,
              };
            }),
          },
        });

        setPendingEditRefundSettlement(null);
        toast.success(t("orderDashboard.orderItemsUpdated", { count: 1 }));
        await loadOrders();
      },
      [
        activeShift?.id,
        activeShift?.staff_id,
        bridge.orders,
        loadOrders,
        pendingEditRefundSettlement,
        staff?.databaseStaffId,
        staff?.staffId,
        t,
      ],
    );

    /**
     * Confirm handler for the new simple cash/card delta modal. Dispatches
     * to applyEditSettlement with a single-element payments or refunds
     * array depending on mode. Replaces the former SplitPaymentModal
     * (collect) and EditOrderRefundSettlementModal (refund) paths for
     * edit-settlement cases.
     */
    const handleEditSettlementDeltaConfirm = useCallback(
      async (method: EditSettlementDeltaMethod) => {
        if (!editSettlementDeltaPrompt) return;
        const { mode, amount, preview, request } = editSettlementDeltaPrompt;

        if (editSettlementDeltaPrompt.menuCommit) {
          const pending = editSettlementDeltaPrompt.menuCommit;
          try {
            let action: Parameters<typeof commitMenuOrderEdit>[2];
            if (mode === 'collect') {
              const collectionAttribution = resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] });
              action = { type: 'collect', payments: [{ orderId: request.orderId, method, amount,
                ...collectionAttribution, paymentOrigin: 'manual', collectedBy: 'cashier_drawer' }] };
            } else {
              const attribution = resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] });
              action = menuEditRefundAction(preview, amount, method,
                t('orderDashboard.editSettlementRefundReason', { defaultValue: 'Edit settlement refund' }), attribution);
            }
            await commitMenuOrderEdit(bridge.orders, pending.data, action, pending.lifecycle);
            setEditSettlementDeltaPrompt(null);
            pending.resolve();
            void silentRefresh().catch(() => undefined);
            void refetchTables();
          } catch (error) {
            // The editor's frozen original owns recovery after confirmation.
            // Never leave another cash/card confirmation button in front of it.
            setEditSettlementDeltaPrompt(null);
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        if (mode === "collect") {
          // Existing-order guard: the edit's collected money is written under
          // the order's ordinary claim, taken before any await. Its reply has
          // no payment reference, so an unknown result stays held (no probe).
          const claim = claimOrdinaryCollectionOwner(collectionScope, request.orderId);
          if (!claim.claimed) {
            toast.error(ordinaryRefusalText(claim.code));
            throw new Error(claim.code);
          }
          const owner = claim.owner;
          const run = await runOrdinaryCollection<unknown>(
            owner,
            {
              method,
              amount,
              transactionRef: null,
              idempotencyKey: null,
              settlementGeneration: null,
              terminalTransactionId: null,
            },
            async () => {
              let raw: unknown;
              try {
                raw = await bridge.orders.applyEditSettlement({
                  orderId: request.orderId,
                  items: request.items,
                  orderNotes: request.orderNotes,
                  financials: request.financials,
                  orderUpdates: request.orderUpdates,
                  action: {
                    type: "collect",
                    payments: [
                      {
                        orderId: request.orderId,
                        method,
                        amount,
                        ...resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                          shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] }),
                        paymentOrigin: "manual",
                        collectedBy: "cashier_drawer",
                      },
                    ],
                  },
                });
              } catch {
                noteOrdinaryWriteFacts(owner, readOrdinaryWriteReply(undefined, true));
                return { verdict: "unknown" as const, value: undefined, code: null };
              }
              // The atomic edit settlement may answer without a payment id;
              // only an explicit failure reply is judged by its raw facts.
              if (
                raw &&
                typeof raw === "object" &&
                (raw as { success?: unknown }).success === false
              ) {
                const facts = readOrdinaryWriteReply(raw);
                noteOrdinaryWriteFacts(owner, facts);
                return { verdict: classifyOrdinaryWrite(facts), value: raw, code: facts.code };
              }
              return { verdict: "completed" as const, value: raw, code: null };
            },
          ).finally(() => {
            // Ends the claim only while nothing was sent under it.
            releaseOrdinaryOwnerBeforeSend(owner);
          });
          if (run.status !== "completed") {
            if (run.status === "unknown") void loadOrders().catch(() => undefined);
            toast.error(
              run.status === "refused"
                ? ordinaryRefusalText(run.code)
                : t("orderDashboard.collectPaymentFailed", {
                    defaultValue: "Failed to collect payment",
                  }),
            );
            throw new Error(run.code || "ORDINARY_COLLECTION_NOT_COMPLETED");
          }
        } else {
          // Refund path: attribute the refund to the first completed
          // payment that can cover it. Prefer a payment whose method
          // matches the operator's chosen refund method; fall back to the
          // payment with the most remaining refundable.
          const eligible = (preview.completedPayments || []).filter(
            (p) => Number(p.remainingRefundable || 0) >= amount - 0.005,
          );
          const preferred =
            eligible.find(
              (p) => String(p.method || "").toLowerCase() === method,
            ) ||
            eligible
              .slice()
              .sort(
                (a, b) =>
                  Number(b.remainingRefundable || 0) -
                  Number(a.remainingRefundable || 0),
              )[0];
          if (!preferred) {
            toast.error(
              t("orderDashboard.refundNoEligiblePayment", {
                defaultValue:
                  "No completed payment with enough remaining balance to refund against.",
              }),
            );
            throw new Error("no-eligible-payment-for-refund");
          }
          const attribution = resolveAdjustmentAttribution({
            databaseStaffId: staff?.databaseStaffId,
            shiftStaffOwnerId: activeShift?.staff_id,
            staffShiftId: activeShift?.id,
            candidateStaffIds: [staff?.staffId],
          });
          await bridge.orders.applyEditSettlement({
            orderId: request.orderId,
            items: request.items,
            orderNotes: request.orderNotes,
            financials: request.financials,
            orderUpdates: request.orderUpdates,
            action: {
              type: "refund",
              refunds: [
                {
                  paymentId: preferred.id,
                  amount,
                  reason: t("orderDashboard.editSettlementRefundReason", {
                    defaultValue: "Edit settlement refund",
                  }),
                  refundMethod: method,
                  // R2: who handed cash back is the till's rule (the courier
                  // while their earning is unsettled), never sent from here.
                  staffId: attribution.staffId,
                  staffShiftId: attribution.staffShiftId,
                },
              ],
            },
          });
        }

        setEditSettlementDeltaPrompt(null);
        toast.success(t("orderDashboard.orderItemsUpdated", { count: 1 }));
        await loadOrders();
      },
      [
        activeShift?.id,
        activeShift?.staff_id,
        bridge.orders,
        collectionScope,
        editSettlementDeltaPrompt,
        loadOrders,
        ordinaryRefusalText,
        staff?.databaseStaffId,
        staff?.staffId,
        silentRefresh,
        refetchTables,
        t,
      ],
    );

    const handleEditSettlementDeltaCancel = useCallback(() => {
      // Nothing to roll back server-side — the edit-settlement payments
      // row only gets written on confirm. Close the modal and let the
      // operator retry via the normal edit flow if they still want to.
      editSettlementDeltaPrompt?.menuCommit?.reject(new Error('EDIT_SETTLEMENT_CANCELLED'));
      setEditSettlementDeltaPrompt(null);
    }, [editSettlementDeltaPrompt]);

    const handleSplitPaymentClose = useCallback(async () => {
      const closingSplitPayment = splitPaymentData;
      const completionResult = splitPaymentCompletedRef.current;
      splitPaymentCompletedRef.current = null;

      if (!closingSplitPayment) return;

      if (closingSplitPayment.kind !== "new-order") {
        setSplitPaymentData(null);
        if (!completionResult && closingSplitPayment.kind === "edit-settlement") {
          toast(
            t("orderDashboard.orderEditPartialPaymentSaved", {
              defaultValue:
                "Order changes were saved. The remaining balance is still pending payment.",
            }),
          );
        }
        void silentRefresh().catch(() => {});
        return;
      }

      if (splitCloseRecoveryRef.current) return;
      splitCloseRecoveryRef.current = true;
      setIsReconcilingSplitClose(true);

      try {
        const resolution = await loadPersistedSplitDismissal(
          bridge,
          closingSplitPayment.orderId,
          closingSplitPayment.orderTotal,
        );
        await silentRefresh().catch(() => {});

        if (resolution.kind === "settled") {
          setSplitPaymentData(null);
          return;
        }

        if (resolution.kind === "partial") {
          setSplitPaymentData({
            ...closingSplitPayment,
            orderTotal: resolution.orderTotal,
            existingPayments: resolution.completedPayments,
            recoverySession: (closingSplitPayment.recoverySession ?? 0) + 1,
            settlementGeneration: resolution.settlementGeneration,
          });
          return;
        }

        setOutstandingPaymentData({
          orderId: closingSplitPayment.orderId,
          orderTotal: resolution.orderTotal,
          outstandingAmount: resolution.outstandingAmount,
          existingPayments: resolution.completedPayments,
          items: closingSplitPayment.items,
          isGhostOrder: closingSplitPayment.isGhostOrder,
          orderNumber: closingSplitPayment.orderNumber,
          orderType: closingSplitPayment.orderType || "pickup",
          tipAmount: closingSplitPayment.tipAmount,
          tipRecipientRole: closingSplitPayment.tipRecipientRole,
          tipRecipientStaffId: closingSplitPayment.tipRecipientStaffId,
          tipRecipientStaffShiftId: closingSplitPayment.tipRecipientStaffShiftId,
          recoverySession: closingSplitPayment.recoverySession,
          settlementGeneration: resolution.settlementGeneration!,
        });
        setSplitPaymentData(null);
      } catch (error) {
        console.error(
          "[OrderDashboard] Failed to reconcile dismissed split payment:",
          error,
        );
        setSplitPaymentData(closingSplitPayment);
        toast.error(
          t("orderDashboard.collectPaymentFailed", {
            defaultValue: "Failed to load the outstanding payment. Try again.",
          }),
        );
      } finally {
        splitCloseRecoveryRef.current = false;
        setIsReconcilingSplitClose(false);
      }
    }, [bridge, silentRefresh, splitPaymentData, t]);

    const outstandingPaymentDataRef = useRef(outstandingPaymentData);
    outstandingPaymentDataRef.current = outstandingPaymentData;

    // The Tender's receipt steps that keep a gift-paid order's receipt open;
    // any other native answer ends it.
    const giftReceiptPending = (nextAction: string): boolean =>
      nextAction === "finalize" || nextAction === "reconcile" || nextAction === "recheck";

    // Original receipt context of orders the Tender reported fully paid by gift
    // card, kept per order and independent of the current UI target. Memory
    // only: after a restart the native journal governs.
    const giftBookedReceiptsRef = useRef(
      new Map<string, NonNullable<typeof outstandingPaymentData>>(),
    );

    // Gift adoption for the outstanding order. The Tender already booked the
    // money natively; the host only rereads the canonical ledger once per new
    // payment and never records, completes or prints anything for it.
    const handleOutstandingGiftEvent = useCallback(
      (event: GiftCardTenderEvent) => {
        if (event.type === "fiscal") {
          // The Tender's own receipt progress: a finished receipt ends its retained reentry.
          giftFiscalNextRef.current = { orderId: event.orderId, nextAction: event.fiscal.nextAction };
          if (!giftReceiptPending(event.fiscal.nextAction)) {
            setGiftReceiptRecoveries((current) =>
              current.filter((entry) => entry.orderId !== event.orderId),
            );
          }
          return;
        }
        if (event.type !== "financial") return;
        const pendingPayment = outstandingPaymentDataRef.current;
        if (!pendingPayment || event.orderId !== pendingPayment.orderId) return;
        const { orderId, orderTotal } = pendingPayment;
        const epoch = outstandingEpochRef.current;
        const freshPaymentIds = adoptGiftCardPaymentIds(
          collectionScope,
          orderId,
          event.adopted.map((payment) => payment.localPaymentId),
        );
        const { coverage } = event;
        // The Tender's trusted full-gift event proves this order's money is booked:
        // keep its original receipt context before any await, so a Close while the
        // ledger reread is pending, failed or stale still reaches that receipt.
        if (
          event.adopted.length > 0 &&
          coverage !== null &&
          coverage.fullyCovered &&
          coverage.outstandingCents === 0
        ) {
          giftBookedReceiptsRef.current.set(orderId, pendingPayment);
        }
        giftEventQueueRef.current = giftEventQueueRef.current
          .then(async () => {
            if (freshPaymentIds.length > 0) await silentRefresh().catch(() => {});
            const settlement = await loadPersistedSplitDismissal(bridge, orderId, orderTotal);
            if (epoch !== outstandingEpochRef.current) return;
            if (
              settlement.kind === "settled" &&
              coverage !== null &&
              coverage.fullyCovered &&
              coverage.outstandingCents === 0
            ) {
              // Keep the Tender mounted so its pending receipt action stays reachable.
              setGiftSettledOrderId(orderId);
              return;
            }
            const settlementGeneration = settlement.settlementGeneration;
            if (!settlementGeneration) return;
            setOutstandingPaymentData((current) =>
              current && current.orderId === orderId
                ? {
                    ...current,
                    orderTotal: settlement.orderTotal,
                    outstandingAmount: settlement.outstandingAmount,
                    existingPayments: settlement.completedPayments,
                    settlementGeneration,
                  }
                : current,
            );
          })
          .catch(() => undefined);
      },
      [bridge, collectionScope, silentRefresh],
    );

    const outstandingExistingOrder = useMemo<PaymentModalExistingOrder | undefined>(() => {
      const orderId = outstandingPaymentData?.orderId;
      if (!orderId) return undefined;
      return {
        orderId,
        orderSynced: outstandingOrderSynced,
        currency:
          outstandingGiftCurrency?.orderId === orderId ? outstandingGiftCurrency.currency : null,
        scope: collectionScope,
        online: browserOnline && nativeOnline,
        outstandingCents: Math.round((outstandingPaymentData?.outstandingAmount ?? 0) * 100),
        giftEnabled: true,
        giftReceiptRecovery: giftReceiptReentryOrderId === orderId,
        onGiftEvent: handleOutstandingGiftEvent,
      };
    }, [
      browserOnline,
      collectionScope,
      giftReceiptReentryOrderId,
      handleOutstandingGiftEvent,
      nativeOnline,
      outstandingGiftCurrency,
      outstandingOrderSynced,
      outstandingPaymentData?.orderId,
      outstandingPaymentData?.outstandingAmount,
    ]);

    // The missing-payment repair takes no gift card; its cash/card write
    // still runs under the order's ordinary claim.
    const repairExistingOrder = useMemo<PaymentModalExistingOrder | undefined>(() => {
      const orderId = missingPaymentRepairTarget?.orderId;
      if (!orderId) return undefined;
      return {
        orderId,
        orderSynced: false,
        currency: null,
        scope: collectionScope,
        online: browserOnline && nativeOnline,
        outstandingCents: Math.round((missingPaymentRepairTarget?.amount ?? 0) * 100),
        giftEnabled: false,
      };
    }, [
      browserOnline,
      collectionScope,
      missingPaymentRepairTarget?.amount,
      missingPaymentRepairTarget?.orderId,
      nativeOnline,
    ]);

    // Reopens a gift-paid order's own Tender, which reads native receipt state
    // and offers only the step native allows; nothing here collects money.
    const reenterGiftReceipt = useCallback(
      (orderId: string) => {
        if (outstandingPaymentDataRef.current) return;
        const retained = giftReceiptRecoveries.find((entry) => entry.orderId === orderId);
        if (!retained) return;
        setGiftReceiptReentryOrderId(orderId);
        setOutstandingPaymentData({ ...retained, outstandingAmount: 0 });
      },
      [giftReceiptRecoveries],
    );

    const handleOutstandingClose = useCallback(() => {
      const pendingPayment = outstandingPaymentDataRef.current;
      if (!pendingPayment) return;
      setOutstandingPaymentData(null);
      const reentry = giftReceiptReentryOrderId === pendingPayment.orderId;
      setGiftReceiptReentryOrderId(null);
      // Retained from the Tender's event before the ledger reread settled the UI.
      const booked = giftBookedReceiptsRef.current.get(pendingPayment.orderId);
      if (giftSettledOrderId === pendingPayment.orderId || reentry || booked) {
        // Paid by gift card: the Tender owns its receipt, nothing is left to split.
        // A receipt it has not finished keeps a reentry to that same Tender.
        const fiscal = giftFiscalNextRef.current;
        const receiptPending =
          !fiscal || fiscal.orderId !== pendingPayment.orderId || giftReceiptPending(fiscal.nextAction);
        const original = booked ?? pendingPayment;
        setGiftReceiptRecoveries((current) => {
          const others = current.filter((entry) => entry.orderId !== pendingPayment.orderId);
          return receiptPending ? [...others, original] : others;
        });
        if (!reentry) void loadOrders().catch(() => undefined);
        return;
      }
      setSplitPaymentData({
        kind: "new-order",
        orderId: pendingPayment.orderId,
        orderTotal: pendingPayment.orderTotal,
        existingPayments: pendingPayment.existingPayments,
        items: pendingPayment.items,
        isGhostOrder: pendingPayment.isGhostOrder,
        initialMode: "by-items",
        orderNumber: pendingPayment.orderNumber,
        orderType: pendingPayment.orderType,
        tipAmount: pendingPayment.tipAmount,
        tipRecipientRole: pendingPayment.tipRecipientRole,
        tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
        tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
        recoverySession: (pendingPayment.recoverySession ?? 0) + 1,
      });
    }, [giftReceiptReentryOrderId, giftSettledOrderId, loadOrders]);

    const handleOutstandingPaymentSelect = useCallback(async (
      selection: OutstandingPaymentSelection,
    ): Promise<boolean | "reconciliation-pending"> => {
      const pendingPayment = outstandingPaymentData;
      if (!pendingPayment) return false;

      if (selection.method === "split") {
        setOutstandingPaymentData(null);
        setSplitPaymentData({
          kind: "new-order",
          orderId: pendingPayment.orderId,
          orderTotal: pendingPayment.orderTotal,
          existingPayments: pendingPayment.existingPayments,
          items: pendingPayment.items,
          isGhostOrder: pendingPayment.isGhostOrder,
          initialMode: "by-items",
          orderNumber: pendingPayment.orderNumber,
          orderType: pendingPayment.orderType,
          tipAmount: pendingPayment.tipAmount,
          tipRecipientRole: pendingPayment.tipRecipientRole,
          tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
          tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
          recoverySession: (pendingPayment.recoverySession ?? 0) + 1,
          settlementGeneration: pendingPayment.settlementGeneration,
        });
        return true;
      }
      const paymentMethod = selection.method;
      const orderId = pendingPayment.orderId;
      // Existing-order guard. A reconciliation only continues the retained
      // original collection and never writes; a collection sends under the
      // order's ordinary claim, taken here (or by the modal) before any await.
      const probeOwner = selection.reconciliationOnly
        ? selection.ordinaryOwner ?? retainedOrdinaryOwner(collectionScope, orderId)
        : null;
      let sendOwner: OrdinaryCollectionOwner | null = null;
      let claimedHere = false;
      if (!selection.reconciliationOnly) {
        if (selection.ordinaryOwner) {
          sendOwner = selection.ordinaryOwner;
        } else {
          const claim = claimOrdinaryCollectionOwner(collectionScope, orderId);
          if (!claim.claimed) {
            toast.error(ordinaryRefusalText(claim.code));
            return claim.retained ? "reconciliation-pending" : false;
          }
          sendOwner = claim.owner;
          claimedHere = true;
        }
      }
      const epoch = outstandingEpochRef.current;

      setIsProcessingOutstandingPayment(true);
      try {
        const askBeforePrint = await shouldAskPaymentPrint();
        let latestResolution: PersistedSplitDismissalResolution;
        let collectedHere: boolean;
        if (!sendOwner) {
          // Snapshot-only: the canonical ledger may settle the original; nothing is resent.
          const probe = probeOwner
            ? await probeOrdinaryOwner(probeOwner, async () => {
                const settlement = await loadPersistedSplitDismissal(
                  bridge,
                  orderId,
                  pendingPayment.orderTotal,
                );
                return { completedPayments: settlement.completedPayments, value: settlement };
              })
            : null;
          if (probe?.status === "unknown") return "reconciliation-pending";
          const snapshot =
            probe?.status === "completed" && probe.value
              ? probe.value
              : await loadPersistedSplitDismissal(
                  bridge,
                  orderId,
                  pendingPayment.orderTotal,
                ).catch(() => null);
          if (!snapshot) return "reconciliation-pending";
          latestResolution = snapshot;
          collectedHere =
            probe?.status === "completed" || ordinaryLandedRef.current === orderId;
        } else {
          const owner = sendOwner;
          const run = await runOrdinaryCollection(
            owner,
            {
              method: paymentMethod,
              amount: pendingPayment.outstandingAmount,
              transactionRef: selection.transactionId ?? null,
              idempotencyKey: selection.idempotencyKey ?? selection.transactionId ?? null,
              settlementGeneration: pendingPayment.settlementGeneration,
              terminalTransactionId: null,
            },
            async () => {
              const attempt = await reconcileOutstandingPaymentAttempt({
                recordPayment: () => bridge.payments.recordPayment({
                  orderId,
                  method: paymentMethod,
                  amount: pendingPayment.outstandingAmount,
                  cashReceived:
                    paymentMethod === "cash" ? selection.cashReceived : undefined,
                  changeGiven:
                    paymentMethod === "cash" ? selection.change : undefined,
                  transactionRef: selection.transactionId,
                  idempotencyKey: selection.idempotencyKey ?? selection.transactionId,
                  currency: selection.currency,
                  metadata: selection.metadata,
                  collectOutstandingBalance: true,
                  expectedSettlementGeneration: pendingPayment.settlementGeneration,
                  tipAmount: pendingPayment.tipAmount,
                  tipRecipientRole: pendingPayment.tipRecipientRole,
                  tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
                  tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
                }),
                bridge,
                orderId,
                fallbackOrderTotal: pendingPayment.orderTotal,
              });
              return {
                verdict: judgeOrdinaryAttempt(owner, attempt),
                value: attempt,
                code: attempt.attempt.code,
              };
            },
          );
          if (run.status === "refused") {
            toast.error(ordinaryRefusalText(run.code));
            return false;
          }
          const attempt = run.value;
          if (attempt?.kind === "not_saved") {
            // The card was charged but its payment is not saved on this till
            // (or the tender was refused because one is not): never "Failed to
            // collect payment" and never a new try with a new key. Its record
            // holds the Z and Save payment again replays it (30/09/2026). The
            // charged one keeps this order's ordinary claim until its own row
            // lands; a refused tender moved nothing and released it.
            if (epoch === outstandingEpochRef.current) {
              notifyPaymentNotSaved(attempt.result, t);
              setOutstandingPaymentData(null);
              void silentRefresh().catch(() => {});
            }
            return false;
          }
          if (attempt && isSetAsideOrdinaryWrite(attempt.attempt)) {
            // Money that moved found the order already covered: recorded set
            // aside for a manager to give back, never a collection and never
            // offered as still due (30/09/2026).
            if (epoch === outstandingEpochRef.current) {
              const setAsideMessage = formatSetAsidePaymentMessage(attempt.attempt.setAsideAnswer, t);
              if (setAsideMessage) toast.error(setAsideMessage, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
              setOutstandingPaymentData(null);
              void silentRefresh().catch(() => {});
            }
            return false;
          }
          if (run.status === "unknown" || !attempt || attempt.kind === "unknown") {
            if (run.status === "completed") ordinaryLandedRef.current = orderId;
            if (epoch === outstandingEpochRef.current) {
              toast.error(
                t("orderDashboard.collectPaymentFailed", {
                  defaultValue: "Failed to collect payment",
                }),
              );
            }
            return "reconciliation-pending";
          }
          latestResolution = attempt.settlement;
          collectedHere = run.status === "completed";
        }
        // A late result settles the original claim but never a newer screen,
        // checked again after the refresh: its target or scope may have changed.
        if (epoch !== outstandingEpochRef.current) return false;
        await silentRefresh().catch(() => {});
        if (epoch !== outstandingEpochRef.current) return false;

        if (latestResolution.kind === "partial") {
          setOutstandingPaymentData(null);
          setSplitPaymentData({
            kind: "new-order",
            orderId: pendingPayment.orderId,
            orderTotal: latestResolution.orderTotal,
            existingPayments: latestResolution.completedPayments,
            items: pendingPayment.items,
            isGhostOrder: pendingPayment.isGhostOrder,
            initialMode: "by-items",
            orderNumber: pendingPayment.orderNumber,
            orderType: pendingPayment.orderType,
            tipAmount: pendingPayment.tipAmount,
            tipRecipientRole: pendingPayment.tipRecipientRole,
            tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
            tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
            recoverySession: (pendingPayment.recoverySession ?? 0) + 1,
            settlementGeneration: latestResolution.settlementGeneration,
          });
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Failed to collect payment",
            }),
          );
          return false;
        }

        if (latestResolution.kind !== "settled") {
          setOutstandingPaymentData({
            ...pendingPayment,
            orderTotal: latestResolution.orderTotal,
            outstandingAmount: latestResolution.outstandingAmount,
            existingPayments: latestResolution.completedPayments,
            settlementGeneration: latestResolution.settlementGeneration!,
          });
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Failed to collect payment",
            }),
          );
          return false;
        }

        setOutstandingPaymentData(null);
        // Only this ordinary collection's own money gets its receipt here; a
        // gift-settled order's receipt belongs to the gift card Tender.
        if (collectedHere && giftSettledOrderId !== orderId) {
          void finalizeCreatedOrderPayment(
            pendingPayment.orderId,
            pendingPayment.isGhostOrder,
            {
              askBeforePrint,
              autoPrintSuppressed: askBeforePrint,
              amount: pendingPayment.outstandingAmount,
              orderNumber: pendingPayment.orderNumber || null,
            },
          ).catch((error) => {
            console.warn(
              "[OrderDashboard] Recovered payment print failed:",
              error,
            );
          });
        }
        if (ordinaryLandedRef.current === orderId) ordinaryLandedRef.current = null;
        return true;
      } catch {
        console.error("[OrderDashboard] Failed to collect recovered payment");
        if (epoch === outstandingEpochRef.current) {
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Failed to collect payment",
            }),
          );
        }
        return false;
      } finally {
        // Ends a claim taken here only while nothing was sent under it; the
        // processing flag belongs to this target and scope only.
        if (claimedHere && sendOwner) releaseOrdinaryOwnerBeforeSend(sendOwner);
        if (epoch === outstandingEpochRef.current) setIsProcessingOutstandingPayment(false);
      }
    }, [
      bridge,
      collectionScope,
      finalizeCreatedOrderPayment,
      giftSettledOrderId,
      judgeOrdinaryAttempt,
      ordinaryRefusalText,
      outstandingPaymentData,
      shouldAskPaymentPrint,
      silentRefresh,
      t,
    ]);

    const handleSplitComplete = async (result: SplitPaymentResult) => {
      splitPaymentCompletedRef.current = result;
      const closingSplitPayment = splitPaymentData;
      await silentRefresh().catch(() => {});
      if (
        result.paymentStatus === "paid" &&
        closingSplitPayment?.kind === "status-blocker" &&
        closingSplitPayment.statusAfterCollection
      ) {
        await retryBlockedStatusTransition(
          closingSplitPayment.orderId,
          closingSplitPayment.statusAfterCollection,
        );
      }
    };

    /*
     * Split collection data for status changes remains separate from the
     * new-order recovery state above.
     */
    const buildStatusBlockerSplitPaymentData = useCallback(
      (
        order: Order,
        targetStatus: StatusTransitionTarget,
        blocker: UnsettledPaymentBlocker,
      ) => ({
        kind: "status-blocker" as const,
        orderId: order.id,
        orderTotal: Number(blocker.totalAmount || order.total_amount || 0),
        existingPayments: [],
        items: buildSplitPaymentItems({
          items: (order.items || []).map((item: any, index: number) => ({
            name: item.name || "Item",
            quantity: Number(item.quantity || 1),
            price: Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0),
            totalPrice: Number(
              item.total_price ??
                item.totalPrice ??
                (item.unit_price ?? item.unitPrice ?? item.price ?? 0) *
                  (item.quantity || 1),
            ),
            itemIndex: Number(item.itemIndex ?? index),
          })),
          orderTotal: Number(blocker.totalAmount || order.total_amount || 0),
          deliveryFee: Number(order.deliveryFee ?? (order as any).delivery_fee ?? 0),
          discountAmount: Number(
            order.discount_amount ?? (order as any).discountAmount ?? 0,
          ),
          deliveryFeeLabel: t("payment.fields.deliveryFee", {
            defaultValue: "Delivery Fee",
          }),
          discountLabel: t("modals.payment.discount", {
            defaultValue: "Discount",
          }),
          adjustmentLabel: t("splitPayment.adjustment", {
            defaultValue: "Adjustment",
          }),
        }),
        isGhostOrder: order.is_ghost === true,
        initialMode: "by-amount" as const,
        statusAfterCollection: targetStatus,
      }),
      [t],
    );

    const handlePaymentIntegrityBlocker = useCallback(
      (
        order: Order,
        targetStatus: StatusTransitionTarget,
        payload: PaymentIntegrityErrorPayload,
      ) => {
        const blocker = payload.blockers?.[0];
        // Never surface the raw backend English payload (it also leaks the internal
        // ORD-* id). The handler owns all messaging for a payment-integrity blocker.
        if (!blocker) {
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Payment collection is required before continuing.",
            }),
          );
          return false;
        }

        // Shared rule R4 (round 3, 01/10/2026): the delivery platform holds
        // this order's money. It is restored from the server, never
        // collected at the till: no payment screen is offered.
        if (blocker.platformHeld === true) {
          toast.error(
            t("orderDashboard.platformHeldNotCollected", {
              defaultValue:
                "The delivery platform holds this order's money. Restore it from the server (Sync Now); it is never collected at the till.",
            }),
          );
          return false;
        }

        // Zero-payment blockers (no_persisted_payment) and explicit split blockers
        // route to the by-amount repair UI, where staff choose cash/card per portion
        // (never silently forced to cash when card is valid).
        if (
          blocker.reasonCode === "split_payment_incomplete" ||
          blocker.reasonCode === "no_persisted_payment" ||
          blocker.paymentMethod === "split"
        ) {
          setSinglePaymentCollectionData(null);
          setSplitPaymentData(
            buildStatusBlockerSplitPaymentData(order, targetStatus, blocker),
          );
          return true;
        }

        if (singlePaymentReasonCodes.has(blocker.reasonCode)) {
          const resolvedMethod: "cash" | "card" =
            blocker.reasonCode.includes("card") ||
            blocker.paymentMethod === "card"
              ? "card"
              : "cash";
          setSplitPaymentData(null);
          setSinglePaymentCollectionData({
            orderId: order.id,
            // Visible compact label (e.g. "ORD #00008"), not the internal ORD-* id.
            orderNumber: formatCompactOrderNumberForDisplay(getVisibleOrderNumber(order)),
            targetStatus,
            method: resolvedMethod,
            blocker,
          });
          return true;
        }

        toast.error(
          t("orderDashboard.collectPaymentFailed", {
            defaultValue: "Payment collection is required before continuing.",
          }),
        );
        return false;
      },
      [buildStatusBlockerSplitPaymentData, singlePaymentReasonCodes, t],
    );

    const retryBlockedStatusTransition = useCallback(
      async (
        orderId: string,
        targetStatus: StatusTransitionTarget,
      ): Promise<boolean> => {
        const result = await updateOrderStatusDetailed(orderId, targetStatus);
        if (result.success) {
          await silentRefresh().catch(() => {});
          toast.success(
            t("orderDashboard.orderStatusUpdated", {
              defaultValue: "Order status updated.",
            }),
          );
          return true;
        }

        if (result.paymentIntegrityPayload) {
          const targetOrder =
            orders.find((order) => order.id === orderId) ||
            pendingExternalOrders.find((order) => order.id === orderId);
          if (targetOrder) {
            handlePaymentIntegrityBlocker(
              targetOrder,
              targetStatus,
              result.paymentIntegrityPayload,
            );
            return false;
          }
        }

        toast.error(
          result.errorMessage ||
            t("orderDashboard.markDeliveredFailed", {
              defaultValue: "Failed to update order status.",
            }),
        );
        return false;
      },
      [
        handlePaymentIntegrityBlocker,
        orders,
        pendingExternalOrders,
        silentRefresh,
        t,
        updateOrderStatusDetailed,
      ],
    );

    const handleSinglePaymentCollected = useCallback(
      async (_result: SinglePaymentCollectionResult) => {
        const pendingCollection = singlePaymentCollectionData;
        setSinglePaymentCollectionData(null);
        if (!pendingCollection) {
          return;
        }

        await silentRefresh().catch(() => {});
        await retryBlockedStatusTransition(
          pendingCollection.orderId,
          pendingCollection.targetStatus,
        );
      },
      [retryBlockedStatusTransition, silentRefresh, singlePaymentCollectionData],
    );

    // Handle bulk actions
    const handleBulkAction = async (action: string) => {
      const deliveryOrders = selectedOrderObjects.filter(
        (order) => order.orderType === "delivery",
      );
      const pickupOrders = selectedOrderObjects.filter(
        (order) => order.orderType !== "delivery",
      );
      const deliveryOrdersInTransit = deliveryOrders.filter((order) => {
        const status = String(order.status || "").toLowerCase();
        return status === "out_for_delivery";
      });
      const deliveryOrdersNeedingDispatch = deliveryOrders.filter((order) => {
        const status = String(order.status || "").toLowerCase();
        return (
          status !== "out_for_delivery" &&
          status !== "delivered" &&
          status !== "completed"
        );
      });

      if (action === "delivery") {
        if (!selectedSinglePickupOrder) {
          toast.error(
            t("orderDashboard.noPickupOrderSelected") ||
              "Select a single pickup order to convert to delivery.",
          );
          return;
        }

        setPickupToDeliveryContext({
          orderId: selectedSinglePickupOrder.id,
          orderNumber:
            selectedSinglePickupOrder.orderNumber ||
            selectedSinglePickupOrder.order_number ||
            "",
        });
        setExistingCustomer(null);
        setCustomerInfo(null);
        setPhoneNumber("");
        setCustomerModalMode("new");
        setDeliveryZoneInfo(null);
        setShowAddCustomerModal(false);
        setShowPhoneLookupModal(true);
        return;
      }

      setIsBulkActionLoading(true);
      try {
        if (action === "view") {
          if (selectedOrders.length === 1) {
            const ord = orders.find((o) => o.id === selectedOrders[0]);
            if (ord) {
              setSelectedOrderForApproval(ord); // reuse approval panel state container for viewing
              setIsViewOnlyMode(true); // View mode - only print button, no approve/decline
              setShowApprovalPanel(true);
            }
          }
          return;
        }

        if (action === "receipt") {
          if (selectedOrders.length === 1) {
            try {
              const result = (await bridge.payments.getReceiptPreview(
                selectedOrders[0],
              )) as {
                success?: boolean;
                html?: string;
                error?: string;
                data?: { html?: string };
              };
              const html = result?.html ?? result?.data?.html;
              if (result?.success !== false && html) {
                setReceiptPreviewHtml(html);
                setReceiptPreviewOrderId(selectedOrders[0]);
                setShowReceiptPreview(true);
              } else {
                toast.error(
                  result?.error || "Failed to generate receipt preview",
                );
              }
            } catch (err) {
              console.error("Receipt preview failed:", err);
              toast.error("Failed to generate receipt preview");
            }
          }
          return;
        }

        if (action === "assign") {
          // Driver assignment for delivery orders
          if (deliveryOrders.length === 0) {
            toast.error(
              t("orderDashboard.noDeliveryOrdersSelected") ||
                "Select delivery orders to assign driver",
            );
            return;
          }
          setPendingDeliveryOrders(deliveryOrders.map((o) => o.id));
          setShowDriverModal(true);
          return;
        }

        if (action === "platform_ready") {
          // Relay ready/prepared to the platform for every selected platform
          // order. notifyPlatformReady sets status='ready' locally, queues the
          // offline fallback, and fires the immediate PATCH in one call.
          // Item D8 (01/10/2026): the till answers an order already past
          // Ready with `alreadyClosed` and a cancelled or refunded one with
          // `cancelled`; neither wrote, queued or sent anything. A cancelled
          // order is never announced as ready: the cashier gets the
          // platform's cancellation notice for it instead.
          const readyOrders = selectedOrderObjects.filter((order) => !isBoxOrder(order));
          if (readyOrders.length === 0) return;
          const outcome = await markPlatformOrdersReady(
            readyOrders.map((order) => ({
              id: order.id,
              displayNumber:
                formatCompactOrderNumberForDisplay(getVisibleOrderNumber(order)) ||
                order.id,
            })),
            (orderId) => bridge.orders.notifyPlatformReady(orderId),
          );
          announcePlatformReadyOutcome(outcome, t, toast);
          if (outcome.failedOrderNumber !== null) {
            return;
          }
          if (outcome.markedReady < readyOrders.length) {
            await loadOrders();
          }
          handleClearSelection();
          return;
        }

        if (action === "delivered") {
          // Handle pickup orders immediately (mark as completed)
          if (pickupOrders.length > 0) {
            for (const order of pickupOrders) {
              const result = await updateOrderStatusDetailed(
                order.id,
                "completed",
              );
              if (!result.success) {
                // A payment-integrity blocker is fully owned by the handler (it opens
                // the repair UI or shows one localized toast); never emit a second toast.
                if (result.paymentIntegrityPayload) {
                  handlePaymentIntegrityBlocker(
                    order,
                    "completed",
                    result.paymentIntegrityPayload,
                  );
                  return;
                }
                toast.error(
                  result.errorMessage ||
                    t("orderDashboard.markDeliveredFailed", {
                      orderNumber: formatCompactOrderNumberForDisplay(
                        getVisibleOrderNumber(order),
                      ),
                    }),
                );
                return;
              }
            }
            toast.success(
              t("orderDashboard.pickupDelivered", {
                count: pickupOrders.length,
              }),
            );
          }

          if (deliveryOrdersNeedingDispatch.length > 0) {
            toast.error(
              t("orderDashboard.dispatchDeliveryBeforeComplete", {
                defaultValue:
                  "Assign a driver or convert delivery orders to pickup before completing them.",
              }),
            );
            return;
          }

          if (deliveryOrdersInTransit.length > 0) {
            for (const order of deliveryOrdersInTransit) {
              const result = await updateOrderStatusDetailed(
                order.id,
                "delivered",
              );
              if (!result.success) {
                // A payment-integrity blocker is fully owned by the handler (it opens
                // the repair UI or shows one localized toast); never emit a second toast.
                if (result.paymentIntegrityPayload) {
                  handlePaymentIntegrityBlocker(
                    order,
                    "delivered",
                    result.paymentIntegrityPayload,
                  );
                  return;
                }
                toast.error(
                  result.errorMessage ||
                    t("orderDashboard.markDeliveredFailed", {
                      orderNumber: formatCompactOrderNumberForDisplay(
                        getVisibleOrderNumber(order),
                      ),
                    }),
                );
                return;
              }
            }
            toast.success(
              t("orderDashboard.deliveriesCompleted", {
                count: deliveryOrdersInTransit.length,
                defaultValue: "Completed {{count}} delivery order(s)",
              }),
            );
          } else if (pickupOrders.length > 0) {
            // If only pickup orders, clear selection
            clearBulkSelection();
          }
        } else if (action === "reset") {
          const completedOrders = selectedOrderObjects.filter((order) => {
            const status = String(order.status || "").toLowerCase();
            return status === "delivered" || status === "completed";
          });

          if (completedOrders.length === 0) {
            toast.error(
              t("orderDashboard.noCompletedOrdersSelected", {
                defaultValue: "No completed orders selected",
              }),
            );
          } else {
            for (const order of completedOrders) {
              let result;
              try {
                result = await bridge.orders.resetToActive(order.id);
              } catch (error) {
                console.error("[OrderDashboard] Failed to reset order:", error);
                toast.error(
                  t("orderDashboard.returnToOrdersFailed", {
                    orderNumber: formatCompactOrderNumberForDisplay(
                      getVisibleOrderNumber(order),
                    ),
                  }),
                );
                return;
              }
              if (!result?.success) {
                toast.error(
                  result?.error ||
                    t("orderDashboard.returnToOrdersFailed", {
                      orderNumber: formatCompactOrderNumberForDisplay(
                        getVisibleOrderNumber(order),
                      ),
                    }),
                );
                return;
              }
            }
            toast.success(
              t("orderDashboard.returnedToOrders", {
                count: completedOrders.length,
              }),
            );
            clearBulkSelection();
            await loadOrders();
          }
        } else if (action === "return" || action === "restore") {
          // Reactivate cancelled orders back to active (pending)
          const cancelledOrders = selectedOrderObjects.filter(
            (order) => isCancelledOrderStatus(order.status),
          );

          if (cancelledOrders.length === 0) {
            toast.error(t("orderDashboard.noCancelledOrdersSelected"));
          } else {
            for (const order of cancelledOrders) {
              const { success } = await updateOrderStatusDetailed(
                order.id,
                "pending",
              );
              if (!success) {
                toast.error(
                  t("orderDashboard.returnToOrdersFailed", {
                    orderNumber: formatCompactOrderNumberForDisplay(
                      getVisibleOrderNumber(order),
                    ),
                  }),
                );
                return;
              }
            }
            toast.success(
              t("orderDashboard.returnedToOrders", {
                count: cancelledOrders.length,
              }),
            );
            clearBulkSelection();
            await loadOrders();
          }
        } else if (action === "map") {
          const deliveryOrders = selectedOrderObjects.filter((order) => {
            const orderType = String(
              order.orderType || (order as any).order_type || "",
            ).toLowerCase();
            return orderType === "delivery";
          });
          const skippedNonDelivery =
            selectedOrderObjects.length - deliveryOrders.length;
          const routeStops = deliveryOrders
            .map((order) => buildSingleDeliveryRouteStop(order))
            .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop));
          const skippedMissingAddress =
            deliveryOrders.length - routeStops.length;

          if (routeStops.length === 0) {
            toast.error(
              t("orderDashboard.noAddressesForMap", {
                defaultValue:
                  "Select at least one delivery order with a valid address.",
              }),
            );
          } else {
            let optimizationResult = await requestOptimizedDeliveryRoute({
              stops: routeStops,
              originFallback: syncedBranchOriginFallback,
            });

            if (
              !optimizationResult.success &&
              optimizationResult.error.includes(
                "Store location is not configured",
              )
            ) {
              const refreshResult = await refreshTerminalSettings();
              const refreshedGetter = createTerminalSettingGetter(
                refreshResult &&
                  typeof refreshResult === "object" &&
                  "settings" in refreshResult
                  ? (refreshResult.settings as
                      | Record<string, unknown>
                      | undefined)
                  : undefined,
              );
              const refreshedOriginFallback = resolveSyncedBranchOriginFallback(
                refreshedGetter,
                effectiveBranchId,
              );

              optimizationResult = await requestOptimizedDeliveryRoute({
                stops: routeStops,
                originFallback: refreshedOriginFallback,
              });
            }

            if (!optimizationResult.success) {
              toast.error(
                optimizationResult.error || t("orderDashboard.mapOpenFailed"),
              );
            } else {
              try {
                for (const launch of optimizationResult.route.launches) {
                  const opened = await openExternalUrl(launch.url);
                  if (!opened) {
                    throw new Error("Failed to open external map URL");
                  }
                }

                const skippedMessages: string[] = [];
                if (skippedNonDelivery > 0) {
                  skippedMessages.push(
                    t("orderDashboard.mapSkippedNonDelivery", {
                      count: skippedNonDelivery,
                    }),
                  );
                }
                if (skippedMissingAddress > 0) {
                  skippedMessages.push(
                    t("orderDashboard.mapSkippedMissingAddress", {
                      count: skippedMissingAddress,
                    }),
                  );
                }

                toast.success(
                  optimizationResult.route.chunked
                    ? t("orderDashboard.openedOptimizedMapsChunked", {
                        count: optimizationResult.route.launches.length,
                      })
                    : t("orderDashboard.openedInMaps", {
                        count: routeStops.length,
                      }),
                );

                if (skippedMessages.length > 0) {
                  toast(
                    t("orderDashboard.mapSkippedOrders", {
                      details: skippedMessages.join(", "),
                    }),
                  );
                }

                // Server route notices arrive as machine codes and are spoken
                // in THIS till's language. The legacy `warnings` sentences are
                // English prose from the server — they were toasted verbatim
                // on Greek tills (observed live 2026-08-18) and are only the
                // fallback for a route payload that predates the codes.
                const warningDetails =
                  optimizationResult.route.warningDetails ?? null;
                if (warningDetails) {
                  warningDetails.forEach(({ code, params }) => {
                    const key = `orderDashboard.routeWarnings.${code}`;
                    const translated = t(key, { ...params });
                    toast(
                      translated === key
                        ? t("orderDashboard.routeWarnings.generic")
                        : translated,
                    );
                  });
                } else {
                  optimizationResult.route.warnings.forEach((warning) => {
                    toast(warning);
                  });
                }
              } catch (e) {
                console.error("Failed to open Google Maps:", e);
                toast.error(t("orderDashboard.mapOpenFailed"));
              }
            }
          }
        } else if (action === "cancel") {
          // Handle cancel action - show cancellation modal
          if (selectedOrders.length > 0) {
            const refusals = await findCancelRefusals(selectedOrders);
            if (refusals.notRecorded.length > 0) announceCancelRefusedNotRecorded(refusals.notRecorded);
            const plans: Record<string, ManualCancellationPlan> = {};
            const protectedOrders: string[] = [];
            const tableIds = selectedOrders.filter(id => {
              const order = [...orders, ...pendingExternalOrders].find(row => row.id === id);
              const type = String(order?.orderType || (order as any)?.order_type || "");
              return Boolean((order as any)?.tableSessionId || (order as any)?.table_session_id || type === "dine-in" || type === "dine_in");
            });
            for (const orderId of new Set([...refusals.hasPayments, ...tableIds])) {
              try {
                plans[orderId] = await prepareManualOrderCancellation(bridge, orderId);
              } catch (error) {
                console.warn("Manual cancellation preflight refused", error);
                protectedOrders.push(orderId);
                toast.error(t(manualCancellationFailureKey(error), { orderNumber: describeOrderNumbers([orderId]) }), { duration: 9000 });
              }
            }
            const cancellable = selectedOrders.filter(id => !refusals.notRecorded.includes(id) && !protectedOrders.includes(id));
            if (cancellable.length === 0) return;
            if (Object.values(plans).some(plan => plan.pending) && cancellable.length > 1) {
              toast.error(t("paymentIntegrity.fixCodes.table_cancellation_not_saved"));
              return;
            }
            if (new Set(Object.values(plans).filter(plan => plan.requiresReturn || plan.requiresHandback).map(plan => plan.currency)).size > 1) {
              toast.error(t("modals.orderCancellation.mixedCurrencies"));
              return;
            }
            setManualCancelPlans(plans);
            setPendingCancelOrders(cancellable);
            setShowCancelModal(true);
          } else {
            toast.error(t("orderDashboard.noOrdersForCancel"));
          }
        } else if (action === "edit") {
          // Handle edit action - show edit options modal
          if (selectedOrders.length > 0) {
            setPendingEditOrders(selectedOrders);
            setEditingSingleOrder(null);
            setShowEditOptionsModal(true);
          } else {
            toast.error(t("orderDashboard.noOrdersForEdit"));
          }
        }
      } finally {
        setIsBulkActionLoading(false);
      }
    };

    // Handle clearing selection
    const handleClearSelection = () => {
      clearBulkSelection();
    };

    // Handle driver modal close
    const handleDriverModalClose = () => {
      setShowDriverModal(false);
      setPendingDeliveryOrders([]);
    };

    const describeOrderNumbers = (orderIds: readonly string[]) =>
      orderIds
        .map((orderId) => {
          const order =
            orders.find((candidate) => candidate.id === orderId) ||
            pendingExternalOrders.find((candidate) => candidate.id === orderId);
          return order
            ? formatCompactOrderNumberForDisplay(getVisibleOrderNumber(order)) || orderId
            : orderId;
        })
        .join(", ");

    // An order labelled paid whose payment is not recorded on this till is
    // never cancelled (founder rule 30/09 and 01/10/2026): its record is
    // restored from the server or recorded first, never charged again.
    const announceCancelRefusedNotRecorded = (orderIds: readonly string[]) => {
      toast.error(
        t("orderDashboard.cancelRefusedNotRecorded", {
          orderNumber: describeOrderNumbers(orderIds),
          defaultValue:
            "Order {{orderNumber}} was not cancelled: it is marked paid, but its payment is not recorded on this till. Restore it from the server with Sync Now, or record the payment from the Z Report, then cancel.",
        }),
        { id: "order-cancel-refused-not-recorded", duration: 10000 },
      );
    };

    // An order money was taken on is never cancelled (fix review 30/09/2026):
    // the cashier is told which ones and what to do instead.
    const announceCancelRefusedPaid = (orderIds: readonly string[]) => {
      const orderNumbers = describeOrderNumbers(orderIds);
      toast.error(
        t("orderDashboard.cancelRefusedPaid", {
          orderNumber: orderNumbers,
          defaultValue:
            "Order {{orderNumber}} was not cancelled: money was taken on it. Void or refund the payment from the order first, or collect the rest.",
        }),
        { id: "order-cancel-refused-paid", duration: 8000 },
      );
    };

    // Handle order cancellation
    const handleOrderCancellation = async (reason: string, returnChannel?: CancellationReturnChannel) => {
      // Forward the typed reason so it's persisted locally AND included
      // in the outbound sync payload — without this, the admin dashboard's
      // cancellation panel falls back to "Reason not recorded".
      const trimmedReason = reason.trim();
      const cancellationOptions = trimmedReason
        ? { cancellationReason: trimmedReason }
        : undefined;
      try {
        // Cancel all pending orders. The trimmed reason is threaded through
        // updateOrderStatus -> Rust IPC -> sync payload so it lands on the
        // server's `cancellation_reason` column and shows up in both the
        // pos-tauri order detail view and the admin dashboard.
        for (const orderId of pendingCancelOrders) {
          const manualPlan = manualCancelPlans[orderId];
          if (manualPlan) {
            if (manualPlan.requiresReturn && !returnChannel) return;
            if (manualPlan.tableSessionId) {
              const result = await runTableReleaseApproval({
                scope: "cash_drawer_control",
                action: (managerPin) => bridge.orders.cancelWithApproval({
                  orderId, reason: trimmedReason, tableSessionId: manualPlan.tableSessionId,
                  clientEventId: manualPlan.requestId, managerPin,
                  ...((manualPlan.requiresReturn || manualPlan.requiresHandback) ? { manualCancellation: { generation: manualPlan.generation, returnChannel: returnChannel || "cash_drawer" } } : {}),
                }),
              });
              if (result?.success !== true) throw new Error("ORDER_CANCELLATION_FAILED");
            } else {
              await commitManualOrderCancellation(bridge, manualPlan, trimmedReason, returnChannel || "cash_drawer");
            }
            continue;
          }
          const targetOrder = [...orders, ...pendingExternalOrders].find(order => order.id === orderId);
          const { success, errorCode } = await updateOrderStatusDetailed(
            orderId,
            "cancelled",
            isBoxOrder(targetOrder) ? { cancellationReason: reason } : cancellationOptions,
          );
          if (!success && errorCode === ORDER_HAS_PAYMENTS) {
            // Money was taken on it since the reason was asked: the till
            // refused the cancel (fix review 30/09/2026).
            announceCancelRefusedPaid([orderId]);
            return;
          }
          if (!success && errorCode === ORDER_PAYMENT_NOT_RECORDED) {
            announceCancelRefusedNotRecorded([orderId]);
            return;
          }
          if (!success) {
            const order = orders.find((o) => o.id === orderId);
            toast.error(
              t("orderDashboard.cancelOrderFailed", {
                orderNumber: order?.orderNumber,
              }),
            );
            return;
          }
        }

        toast.success(
          t("orderDashboard.ordersCancelled", {
            count: pendingCancelOrders.length,
          }),
        );

        // Close modal and clear selections
        setShowCancelModal(false);
        setPendingCancelOrders([]);
        setManualCancelPlans({});
        clearBulkSelection();
        await loadOrders();
      } catch (error) {
        console.error("Failed to cancel orders:", error);
        toast.error(t(manualCancellationFailureKey(error), { orderNumber: describeOrderNumbers(pendingCancelOrders) }), { duration: 9000 });
      }
    };

    // Handle cancel modal close
    const handleCancelModalClose = () => {
      setShowCancelModal(false);
      setPendingCancelOrders([]);
      setManualCancelPlans({});
    };

    // Handle edit options
    const handleEditInfo = () => {
      const targetOrderIds =
        pendingEditOrders.length > 0
          ? pendingEditOrders
          : editingSingleOrder
            ? [editingSingleOrder]
            : [];

      // Capture the customer info NOW while pendingEditOrders is still populated
      setEditCustomerSnapshot(getSelectedOrderCustomerInfo());
      editCustomerOriginals.current = Object.fromEntries(targetOrderIds.map(id =>
        [id, orderCustomerEditSnapshot(orders.find(order => order.id === id))]));
      setEditCustomerOrderIds(targetOrderIds);
      setShowEditOptionsModal(false);
      setShowEditCustomerModal(true);
    };

    const editablePaymentOrder = React.useMemo(() => {
      if (pendingEditOrders.length !== 1) return null;
      return orders.find((order) => order.id === pendingEditOrders[0]) || null;
    }, [pendingEditOrders, orders]);

    const paymentEditIneligibilityReason = React.useMemo(() => {
      if (pendingEditOrders.length !== 1) {
        return t("orderDashboard.paymentMethodEditUnavailable");
      }

      if (!editablePaymentOrder) {
        return t("orderDashboard.paymentMethodEditUnavailable");
      }

      const status = String(editablePaymentOrder.status || "")
        .trim()
        .toLowerCase();
      if (status === "cancelled" || status === "canceled") {
        return t("orderDashboard.paymentMethodEditUnavailable");
      }

      return undefined;
    }, [
      pendingEditOrders.length,
      editablePaymentOrder,
      t,
    ]);

    const canEditPaymentMethod = !paymentEditIneligibilityReason;

    const showPaymentMethodEditError = (message: string) => {
      toast.error(message, { id: "payment-method-edit-error" });
    };

    const localizePaymentMethodEditError = (error: unknown) => {
      const rawMessage = extractOrderDashboardErrorMessage(error) || "";
      if (rawMessage.includes("PAYMENT_METHOD_EDIT_PROVIDER_PAYMENT_IMMUTABLE")) return t("orderDashboard.paymentMethodEditProviderOwned");
      if (rawMessage.includes("ORDER_EDIT_SETTLEMENT_PENDING")) return t("orderDashboard.paymentMethodEditPending");
      if (rawMessage.includes("PAYMENT_METHOD_EDIT_ADJUSTED_ORDER_NOT_EDITABLE")) {
        return t("orderDashboard.paymentMethodAdjustedOrder", {
          defaultValue: "This order has a refund or void. Its payment methods cannot be changed. Open the payment history to review the adjustment.",
        });
      }
      if (rawMessage.includes("PAYMENT_METHOD_EDIT_TARGET_NOT_FOUND")) {
        return t("orderDashboard.paymentMethodEditUnavailable");
      }
      return t("orderDashboard.paymentMethodUpdateFailed");
    };

    const handleEditPayment = async () => {
      if (paymentMethodEditRequestRef.current) return;

      if (!canEditPaymentMethod) {
        showPaymentMethodEditError(
          paymentEditIneligibilityReason ||
            t("orderDashboard.paymentMethodEditUnavailable"),
        );
        return;
      }

      if (!editablePaymentOrder) {
        showPaymentMethodEditError(
          t("orderDashboard.paymentMethodEditUnavailable"),
        );
        return;
      }

      paymentMethodEditRequestRef.current = true;
      setIsCheckingPaymentMethodEdit(true);
      try {
        const route = await loadPaymentEditRoute(bridge, editablePaymentOrder);
        if (route.kind === "blocked") {
          showPaymentMethodEditError(
            route.reason === "provider_owned" ? t("orderDashboard.paymentMethodEditProviderOwned") : route.reason === "adjusted"
              ? localizePaymentMethodEditError("PAYMENT_METHOD_EDIT_ADJUSTED_ORDER_NOT_EDITABLE")
              : route.reason === "platform_held"
                ? // R4: the platform's money is restored from the server,
                  // never collected or recorded at the till.
                  t("orderDashboard.platformHeldNotCollected", {
                    defaultValue:
                      "The delivery platform holds this order's money. Restore it from the server (Sync Now); it is never collected at the till.",
                  })
                : t("orderDashboard.paymentMethodEditUnavailable"),
          );
          return;
        }

        if (route.kind === "collect-missing") {
          const settlement = await loadPersistedSplitDismissal(
            bridge,
            editablePaymentOrder.id,
            Number(
              editablePaymentOrder.total_amount ||
                editablePaymentOrder.totalAmount ||
                0,
            ),
          );
          if (settlement.kind === "settled" || settlement.outstandingAmount <= 0) {
            showPaymentMethodEditError(
              t("orderDashboard.paymentMethodEditUnavailable"),
            );
            return;
          }
          const rawOrderType = String(
            editablePaymentOrder.order_type ||
              editablePaymentOrder.orderType ||
              "pickup",
          ).trim().toLowerCase();
          const orderType =
            rawOrderType === "delivery"
              ? "delivery"
              : rawOrderType === "dine-in" || rawOrderType === "dine_in"
                ? "dine-in"
                : "pickup";
          setMissingPaymentRepairTarget({
            orderId: editablePaymentOrder.id,
            orderNumber:
              editablePaymentOrder.order_number ||
              editablePaymentOrder.orderNumber,
            amount: settlement.outstandingAmount,
            settlementGeneration: settlement.settlementGeneration!,
            orderType,
          });
          setShowEditOptionsModal(false);
          return;
        }

        const paymentStatus =
          String(
            editablePaymentOrder.payment_status ||
              editablePaymentOrder.paymentStatus ||
              "pending",
          )
            .trim()
            .toLowerCase() || "pending";

        setEditPaymentTarget({
          orderId: editablePaymentOrder.id,
          orderNumber:
            editablePaymentOrder.order_number ||
            editablePaymentOrder.orderNumber,
          currentMethod: route.currentMethod,
          paymentStatus,
          payments: route.payments,
        });
        setShowEditOptionsModal(false);
        setShowEditPaymentModal(true);
      } catch (error) {
        console.error("Failed to check payment method edit eligibility:", error);
        showPaymentMethodEditError(localizePaymentMethodEditError(error));
      } finally {
        paymentMethodEditRequestRef.current = false;
        setIsCheckingPaymentMethodEdit(false);
      }
    };

    const handleMissingPaymentRepair = useCallback(
      async (selection: OutstandingPaymentSelection): Promise<boolean | "reconciliation-pending"> => {
        const target = missingPaymentRepairTarget;
        if (
          !target ||
          (selection.method === "split" || selection.method === "twint") ||
          missingPaymentRepairRef.current
        ) {
          return false;
        }
        const paymentMethod = selection.method;
        const orderId = target.orderId;
        // Existing-order guard, as for outstanding collection: a
        // reconciliation only continues the retained original, and a repair
        // write sends under the order's ordinary claim taken before any await.
        const probeOwner = selection.reconciliationOnly
          ? selection.ordinaryOwner ?? retainedOrdinaryOwner(collectionScope, orderId)
          : null;
        let sendOwner: OrdinaryCollectionOwner | null = null;
        let claimedHere = false;
        if (!selection.reconciliationOnly) {
          if (selection.ordinaryOwner) {
            sendOwner = selection.ordinaryOwner;
          } else {
            const claim = claimOrdinaryCollectionOwner(collectionScope, orderId);
            if (!claim.claimed) {
              toast.error(ordinaryRefusalText(claim.code));
              return claim.retained ? "reconciliation-pending" : false;
            }
            sendOwner = claim.owner;
            claimedHere = true;
          }
        }

        missingPaymentRepairRef.current = true;
        setIsRepairingMissingPayment(true);
        try {
          let settlement: PersistedSplitDismissalResolution;
          if (!sendOwner) {
            const probe = probeOwner
              ? await probeOrdinaryOwner(probeOwner, async () => {
                  const snapshot = await loadPersistedSplitDismissal(bridge, orderId, target.amount);
                  return { completedPayments: snapshot.completedPayments, value: snapshot };
                })
              : null;
            if (probe?.status === "unknown") return "reconciliation-pending";
            const snapshot =
              probe?.status === "completed" && probe.value
                ? probe.value
                : await loadPersistedSplitDismissal(bridge, orderId, target.amount).catch(
                    () => null,
                  );
            if (!snapshot) return "reconciliation-pending";
            settlement = snapshot;
          } else {
            const owner = sendOwner;
            const run = await runOrdinaryCollection(
              owner,
              {
                method: paymentMethod,
                amount: selection.amount,
                transactionRef: selection.transactionId ?? null,
                idempotencyKey: selection.idempotencyKey ?? selection.transactionId ?? null,
                settlementGeneration: target.settlementGeneration,
                terminalTransactionId: null,
              },
              async () => {
                const attempt = await reconcileOutstandingPaymentAttempt({
                  recordPayment: () => repairMissingPayment(bridge.payments, {
                    orderId,
                    method: paymentMethod,
                    amount: selection.amount,
                    cashReceived: selection.cashReceived,
                    changeGiven: selection.change,
                    transactionRef: selection.transactionId,
                    idempotencyKey: selection.idempotencyKey ?? selection.transactionId,

                    expectedSettlementGeneration: target.settlementGeneration,
                  }),
                  bridge,
                  orderId,
                  fallbackOrderTotal: target.amount,
                });
                return {
                  verdict: judgeOrdinaryAttempt(owner, attempt),
                  value: attempt,
                  code: attempt.attempt.code,
                };
              },
            );
            if (run.status === "refused") {
              toast.error(ordinaryRefusalText(run.code));
              return false;
            }
            const attempt = run.value;
            if (attempt?.kind === "not_saved") {
              // The card was charged but its payment is not saved on this till
              // (or the tender was refused because one is not): never "Failed to
              // collect payment" and never a new try with a new key. Its record
              // holds the Z and Save payment again replays it (30/09/2026).
              notifyPaymentNotSaved(attempt.result, t);
              setMissingPaymentRepairTarget(null);
              void loadOrders().catch(() => {});
              return false;
            }
            if (attempt && isSetAsideOrdinaryWrite(attempt.attempt)) {
              // Money that moved found the order already covered: recorded set
              // aside for a manager to give back, never a repair (30/09/2026).
              const setAsideMessage = formatSetAsidePaymentMessage(attempt.attempt.setAsideAnswer, t);
              if (setAsideMessage) toast.error(setAsideMessage, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
              setMissingPaymentRepairTarget(null);
              void loadOrders().catch(() => {});
              return false;
            }
            // An unknown repair keeps its claim and its target; nothing is re-targeted.
            if (run.status === "unknown" || !attempt || attempt.kind === "unknown") {
              toast.error(
                t("orderDashboard.collectPaymentFailed", {
                  defaultValue: "Failed to collect payment",
                }),
              );
              return "reconciliation-pending";
            }
            settlement = attempt.settlement;
          }
          if (settlement.kind === "settled") {
            setMissingPaymentRepairTarget(null);
            setPendingEditOrders([]);
            setEditingSingleOrder(null);
            clearBulkSelection();
            await loadOrders().catch(() => {
              console.warn("Missing payment was recorded but order refresh failed");
            });
            return true;
          }

          if (settlement.kind === "partial") {
            setMissingPaymentRepairTarget({
              ...target,
              amount: settlement.outstandingAmount,
              settlementGeneration: settlement.settlementGeneration!,
            });
          } else if (settlement.kind === "unpaid") {
            setMissingPaymentRepairTarget({
              ...target,
              amount: settlement.outstandingAmount,
              settlementGeneration: settlement.settlementGeneration!,
            });
          }
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Failed to collect payment",
            }),
          );
          return false;
        } catch {
          console.error("Failed to reconcile missing order payment");
          toast.error(
            t("orderDashboard.collectPaymentFailed", {
              defaultValue: "Failed to collect payment",
            }),
          );
          return false;
        } finally {
          // Ends a claim taken here only while nothing was sent under it.
          if (claimedHere && sendOwner) releaseOrdinaryOwnerBeforeSend(sendOwner);
          missingPaymentRepairRef.current = false;
          setIsRepairingMissingPayment(false);
        }
      }, [
        bridge,
        clearBulkSelection,
        collectionScope,
        judgeOrdinaryAttempt,
        loadOrders,
        missingPaymentRepairTarget,
        ordinaryRefusalText,
        t,
      ],
    );

    const openMenuEditSession = (targetOrderType?: EditableOrderType) => {
      setShowEditOptionsModal(false);
      setEditHeaders(undefined);

      // Get the order being edited to determine its type
      if (pendingEditOrders.length > 0) {
        const orderToEdit = orders.find(
          (order) => order.id === pendingEditOrders[0],
        );
        if (orderToEdit) {
          // Store the order ID, supabase ID, and number before opening the modal
          // This ensures they persist even if pendingEditOrders gets cleared
          setCurrentEditOrderId(orderToEdit.id);
          setCurrentEditSupabaseId(orderToEdit.supabase_id);
          setCurrentEditOrderNumber(
            orderToEdit.order_number || orderToEdit.orderNumber,
          );

          debugLog(
            "[OrderDashboard] handleEditOrder - orderId:",
            orderToEdit.id,
            "supabaseId:",
            orderToEdit.supabase_id,
            "orderNumber:",
            orderToEdit.order_number || orderToEdit.orderNumber,
          );

          setEditingOrderType(
            targetOrderType || resolveEditableOrderType(orderToEdit),
          );
          // The stored row still reflects its current type here (no
          // conversion has run), so the source type is simply that.
          setCurrentEditSourceOrderType(resolveEditableOrderType(orderToEdit));
        }
      }

      // Open the menu-based edit modal instead of the simple edit modal
      setShowEditMenuModal(true);
    };

    const handleEditOrder = () => {
      openMenuEditSession();
    };

    const handleChangeOrderType = (targetOrderType: EditableOrderType) => {
      if (pendingEditOrders.length !== 1) {
        toast.error(
          t("orderDashboard.changeOrderTypeSingleOnly", {
            defaultValue: "Change order type is only available for one order at a time.",
          }),
        );
        return;
      }

      const orderBeingEdited = orders.find(
        (o) => o.id === pendingEditOrders[0],
      );
      if (!orderBeingEdited) {
        openMenuEditSession(targetOrderType);
        return;
      }

      const currentType = resolveEditableOrderType(orderBeingEdited);
      if (currentType === targetOrderType) {
        // Button should be disabled, but belt-and-suspenders in case the
        // EditOptionsModal passes a same-type click through.
        openMenuEditSession(targetOrderType);
        return;
      }

      // Pickup / dine-in → delivery: route through the existing
      // customer-search + address-pick flow. After it resolves, the
      // `mode: 'edit'` branch in convertPickupOrderToDelivery reopens
      // the menu-edit session instead of finalizing as a bulk convert.
      if (targetOrderType === "delivery") {
        setShowEditOptionsModal(false);
        setCurrentEditOrderId(orderBeingEdited.id);
        setCurrentEditSupabaseId(orderBeingEdited.supabase_id);
        setCurrentEditOrderNumber(
          orderBeingEdited.order_number || orderBeingEdited.orderNumber,
        );
        setEditingOrderType("delivery");
        // Items are still priced at the PRE-conversion tier; the conversion
        // stamps order_type='delivery' before the modal reopens, so this is
        // the only place that still knows the tier the prices reflect.
        setCurrentEditSourceOrderType(currentType);
        setPickupToDeliveryContext({
          orderId: orderBeingEdited.id,
          orderNumber:
            orderBeingEdited.orderNumber ||
            orderBeingEdited.order_number ||
            "",
          mode: "edit",
        });
        setExistingCustomer(null);
        setCustomerInfo(null);
        setPhoneNumber("");
        setCustomerModalMode("new");
        setDeliveryZoneInfo(null);
        setShowAddCustomerModal(false);
        setShowPhoneLookupModal(true);
        return;
      }

      // Delivery-only fields are cleared atomically by the final Menu save.
      openMenuEditSession(targetOrderType);
    };

    const handleEditOptionsClose = () => {
      setShowEditOptionsModal(false);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
    };

    const handleEditPaymentClose = () => {
      if (isUpdatingPaymentMethod) return;
      setShowEditPaymentModal(false);
      setEditPaymentTarget(null);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
    };

    const handlePaymentMethodSave = async (
      paymentId: string | null,
      nextMethod: "cash" | "card",
    ) => {
      if (!editPaymentTarget) {
        toast.error(t("orderDashboard.paymentMethodEditUnavailable"));
        return;
      }
      const selectedPayment = editPaymentTarget.payments.find(
        (payment) => payment.id === paymentId,
      );
      const sameMethodRequested =
        (selectedPayment?.method ?? editPaymentTarget.currentMethod) ===
        nextMethod;

      setIsUpdatingPaymentMethod(true);
      try {
        const result: any = await bridge.payments.updatePaymentMethod(
          editPaymentTarget.orderId,
          nextMethod,
          paymentId,
        );
        if (!result?.success) {
          throw new Error(result?.error || "Failed to update payment method");
        }

        const retriedSync = Boolean(result?.data?.retriedSync);
        if (sameMethodRequested && !retriedSync) {
          toast.success(t("orderDashboard.paymentMethodNoChange"));
          return;
        }

        toast.success(
          retriedSync
            ? t("orderDashboard.paymentMethodSyncRetried", {
                defaultValue: "Payment sync retry queued",
              })
            : t("orderDashboard.paymentMethodUpdated"),
        );
        await loadOrders();
        setShowEditPaymentModal(false);
        setEditPaymentTarget(null);
        setPendingEditOrders([]);
        setEditingSingleOrder(null);
        clearBulkSelection();
      } catch (error) {
        console.error("Failed to update payment method:", error);
        const message = localizePaymentMethodEditError(error);
        toast.error(message, { id: "payment-method-edit-error" });
      } finally {
        setIsUpdatingPaymentMethod(false);
      }
    };

    // Handle customer info edit
    const handleCustomerInfoSave = async (
      customerInfo: EditCustomerInfoFormData,
    ) => {
      const targetOrderIds =
        editCustomerOrderIds.length > 0
          ? editCustomerOrderIds
          : pendingEditOrders.length > 0
            ? pendingEditOrders
            : editingSingleOrder
              ? [editingSingleOrder]
              : [];

      if (targetOrderIds.length === 0) {
        toast.error(t("orderDashboard.customerInfoFailed"));
        return;
      }

      try {
        for (const orderId of targetOrderIds) {
          const original = editCustomerOriginals.current[orderId];
          if (!original) throw new Error(t("orderDashboard.customerInfoFailed"));
          const updatePayload = customerInfoEditUpdate(customerInfo, original);
          const result = await bridge.orders.updateCustomerInfo({
            orderId,
            ...updatePayload,
          });

          if (!result?.success) {
            throw new Error(result?.error || "Failed to update customer info");
          }
        }

        await loadOrders();

        toast.success(
          t("orderDashboard.customerInfoUpdated", {
            count: targetOrderIds.length,
          }),
        );

        // Close modal and clear state
        setShowEditCustomerModal(false);
        setEditCustomerSnapshot(null);
        editCustomerOriginals.current = {};
        setEditCustomerOrderIds([]);
        setPendingEditOrders([]);
        setEditingSingleOrder(null);
        clearBulkSelection();
      } catch (error) {
        console.error("Failed to update customer info:", error);
        try {
          await loadOrders();
        } catch (reloadError) {
          console.error(
            "Failed to reload orders after customer info update:",
            reloadError,
          );
        }
        const errorMessage = extractOrderDashboardErrorMessage(error);
        toast.error(errorMessage || t("orderDashboard.customerInfoFailed"));
      }
    };

    const handleEditCustomerClose = () => {
      editCustomerOriginals.current = {};
      setShowEditCustomerModal(false);
      setEditCustomerSnapshot(null);
      setEditCustomerOrderIds([]);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
    };

    // Handle order items edit
    const handleOrderItemsSave = async (
      items: OrderItem[],
      orderNotes?: string,
    ) => {
      try {
        await applySettlementAwareOrderEdit(
          pendingEditOrders.map((orderId) => ({
            orderId,
            orderNumber:
              (orders.find((order) => order.id === orderId) as any)
                ?.order_number ||
              orders.find((order) => order.id === orderId)?.orderNumber,
            items,
            orderNotes,
          })),
        );
      } catch (error) {
        console.error("Failed to update order items:", error);
        const errorMessage = extractOrderDashboardErrorMessage(error);
        toast.error(errorMessage || t("orderDashboard.orderItemsFailed"));
      }
    };

    const handleEditOrderClose = () => {
      resetEditOrderState();
    };

    const handleEditMenuPreflight = async (data: MenuOrderEditData) =>
      (await previewMenuOrderEdit(bridge.orders, data, bridge.sync)).preflight;

    // Keep the cart editable through the picker; freeze the exact final action before IPC.
    const handleEditMenuComplete = async (data: MenuOrderEditData, lifecycle?: MenuOrderEditLifecycle) => {
      if (data.action === 'edit_settlement') {
        if (!data.settlementAction) throw new Error('RECOVERY_ORIGINAL_REQUEST_REQUIRED');
        await commitMenuOrderEdit(bridge.orders, data, data.settlementAction);
        void silentRefresh().catch(() => undefined);
        void refetchTables();
        return;
      }
      const { preflight, preview } = await previewMenuOrderEdit(bridge.orders, data, bridge.sync);
      if (preflight.kind !== 'settlement') {
        const target = orders.find(order => order.id === data.orderId) as any;
        const result: any = await bridge.orders.updateItems(data.orderId, data.items, {
          clientEventId: data.client_event_id, expectedVersion: data.expected_version,
          expectedLocalVersion: data.renderer_local_version,
          tableSessionId: target?.table_session_id || target?.tableSessionId,
          orderUpdates: data.orderUpdates, financials: data.financials, orderNotes: data.notes,
        });
        if (result?.success === false) throw new Error('CHECKOUT_DRAFT_EDIT_NOT_APPLIED');
        void silentRefresh().catch(() => undefined);
        void refetchTables();
        return;
      }
      if (!lifecycle) throw new Error('CHECKOUT_DRAFT_EDIT_FREEZE_REQUIRED');
      if (preview.requiredAction === 'none') {
        await commitMenuOrderEdit(bridge.orders, data, { type: 'none' }, lifecycle);
        void silentRefresh().catch(() => undefined);
        void refetchTables();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        setEditSettlementDeltaPrompt({ mode: preview.requiredAction as 'collect' | 'refund',
          amount: preview.requiredAction === 'collect' ? Math.max(0, preview.nextTotal - preview.paidTotal) : resolveEditSettlementRefundAmount(preview),
          orderNumber: currentEditOrderNumber, preview,
          request: { orderId: data.orderId, items: data.items, orderNotes: data.notes },
          menuCommit: { data, lifecycle, resolve, reject },
        });
      });
    };

    const handleEditMenuClose = () => {
      resetEditOrderState();
    };

    // Get customer info for the first selected order (for editing)
    const getSelectedOrderCustomerInfo = (): EditCustomerInfoFormData => {
      if (pendingEditOrders.length === 0 && !editingSingleOrder)
        return { name: "", phone: "", address: "", delivery_floor: "", name_on_ringer: "", notes: "" };

      const targetId = pendingEditOrders[0] || editingSingleOrder;
      const firstOrder = orders.find((order) => order.id === targetId) as any;
      return orderCustomerEditSnapshot(firstOrder);
    };

    // Get order items for the first selected order (for editing)
    const getSelectedOrderItems = () => {
      if (pendingEditOrders.length === 0) {
        debugLog(
          "[OrderDashboard] getSelectedOrderItems: No pending edit orders",
        );
        return [];
      }

      const firstOrder = orders.find(
        (order) => order.id === pendingEditOrders[0],
      );
      debugLog(
        "[OrderDashboard] getSelectedOrderItems: firstOrder:",
        firstOrder?.id,
        "items:",
        firstOrder?.items?.length,
        firstOrder?.items,
      );
      return firstOrder?.items || [];
    };

    // Get order number for the first selected order (for display in edit modal)
    // Requirements: 7.7 - Display same order_number in edit modal as shown in grid
    const getSelectedOrderNumber = (): string | undefined => {
      if (pendingEditOrders.length === 0) return undefined;

      const firstOrder = orders.find(
        (order) => order.id === pendingEditOrders[0],
      );
      // Handle both snake_case and camelCase field names
      return firstOrder?.order_number || firstOrder?.orderNumber;
    };

    // Get error from store
    const error = getLastError();

    // Handle retry
    const handleRetry = async () => {
      clearError();
      await loadOrders();
    };

    // Handle conflict resolution
    const handleResolveConflict = async (
      conflictId: string,
      strategy: string,
    ) => {
      try {
        await resolveConflict(
          conflictId,
          strategy as "accept_local" | "accept_remote" | "merge",
        );
        toast.success(t("orderDashboard.conflictResolved"));
      } catch (error) {
        toast.error(t("orderDashboard.conflictFailed"));
        console.error("Conflict resolution error:", error);
      }
    };

    // An order in progress must survive background refreshes. Every store
    // operation flips `isLoading` — loadOrders after an efood «Αποδοχή», a
    // status change, a driver assignment — and swapping the whole dashboard
    // for the skeleton unmounted MenuModal mid-order, so the cart vanished the
    // moment staff accepted an incoming efood order (live 06/09/2026, Το
    // Μικρό Παρίσι). The skeleton is for the very first load only; later
    // refreshes (and errors) render in place while order entry is open.
    const isOrderEntryOpen = showMenuModal || showEditMenuModal;
    if (isLoading && isShiftActive && !hasCompletedInitialLoadRef.current && !isOrderEntryOpen) {
      return <OrderDashboardSkeleton />;
    }

    // Show error display if there's an error (never over an open order draft —
    // the failure is already toasted, and replacing the tree would drop the cart)
    if (error && !isOrderEntryOpen) {
      return (
        <div className="p-6">
          <ErrorDisplay
            error={error}
            onRetry={handleRetry}
            showDetails={process.env.NODE_ENV === "development"}
          />
        </div>
      );
    }

    return (
      <div className={`relative flex h-full min-h-0 flex-col gap-4 overflow-hidden ${className}`}>
        <TableAttemptRecoveryNotice />
        {/* Order Conflict Banner */}
        {/* Conflict banner intentionally disabled: remote always wins */}

        {unsavedCheckout.payments.length > 0 ? (
          <div className="shrink-0" data-testid="unsaved-checkout-banner">
            <UnsavedChargedPaymentBanner
              payments={unsavedCheckout.payments}
              onSaveAgain={unsavedCheckout.saveAgain}
              isSaving={unsavedCheckout.isSaving}
            />
          </div>
        ) : null}

        {/* Order Tabs - Module dependent */}
        <div className="shrink-0">
          <OrderTabsBar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            orderCounts={{
              ...orderCounts,
              rooms: roomsHubCount,
              // Services count is intentionally 0: appointments data isn't loaded here and the
              // brief forbids a heavy duplicate fetch just for a tab badge.
              services: 0,
            }}
            showTablesTab={hasTablesModule}
            showRoomsTab={hasRoomsModule}
            showServicesTab={hasServicesModule}
          />
        </div>

        {/* Bulk Actions */}
        <div ref={bulkActionsBarRef} className="shrink-0">
          <BulkActionsBar
            selectedCount={selectedOrders.length}
            selectionType={selectionType}
            deliverySelectionCanBeCompleted={deliverySelectionCanBeCompleted}
            platformReadySelectionEligible={platformReadySelectionEligible}
            activeTab={activeTab}
            onBulkAction={handleBulkAction}
            onClearSelection={handleClearSelection}
            isLoading={isBulkActionLoading}
          />
        </div>

        {/* Orders Grid or Tables Grid based on active tab */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "tables" && hasTablesModule ? (
          <div
            ref={orderGridRef}
            onWheel={handleTableGridWheel}
            className="table-workspace"
            data-theme={resolvedTheme === "light" ? "light" : "dark"}
          >
            {displayTables.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <UtensilsCrossed
                  className={`w-16 h-16 mb-4 ${resolvedTheme === "light" ? "text-gray-300" : "text-white/20"}`}
                  strokeWidth={1.5}
                />
                <p
                  className={`text-lg font-medium ${resolvedTheme === "light" ? "text-gray-500" : "text-white/50"}`}
                >
                  {t("tables.noTables") || "No tables configured"}
                </p>
                <p
                  className={`text-sm mt-1 ${resolvedTheme === "light" ? "text-gray-400" : "text-white/30"}`}
                >
                  {t("tables.configureInAdmin") ||
                    "Configure tables in the Admin Dashboard"}
                </p>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <TableWorkspaceToolbar
                  stats={tableGridStats}
                  statusLabels={tableStatusConfig}
                  statusFilter={tableStatusFilter}
                  onStatusFilter={setTableStatusFilter}
                  floorFilter={effectiveTableFloorFilter}
                  floors={tableFloorOptions}
                  floorLabel={getTableFloorLabel}
                  onFloorFilter={setTableFloorFilter}
                  onList={() => setTableViewMode("list")}
                  onFloorPlan={() => setTableFloorPlanModalOpen(true)}
                  floorPlanOpen={tableFloorPlanModalOpen}
                  formatCurrency={formatCurrency}
                />

                <div
                  data-testid="order-dashboard-table-grid-container"
                  className="min-h-0 flex-1 overflow-hidden"
                >
                  <div
                    ref={tableGridScrollRef}
                    data-testid="order-dashboard-table-scroll-region"
                    className="table-workspace-scroll touch-scroll"
                  >
                  <TableFloorPlanModal
                    isOpen={tableFloorPlanModalOpen}
                    onClose={() => setTableFloorPlanModalOpen(false)}
                    tables={displayTables}
                    isDark={resolvedTheme !== "light"}
                    selectedTableId={selectedTable?.id ?? null}
                    onTableSelect={(table) => {
                      setTableFloorPlanModalOpen(false);
                      handleTableSelect(table);
                    }}
                  />
                  {visibleTableCards.length === 0 ? (
                    <div
                      className={`flex min-h-full items-center justify-center rounded-xl border border-dashed py-10 text-center font-semibold ${
                        resolvedTheme === "light"
                          ? "border-slate-300 text-slate-500"
                          : "border-white/15 text-white/50"
                      }`}
                    >
                      {t("tablesDashboard.noMatchingTables", "No tables match these filters")}
                    </div>
                  ) : tableViewMode === "floorplan" ? (
                    <TableFloorPlanView
                      tables={visibleTableCards}
                      isDark={resolvedTheme !== "light"}
                      selectedTableId={selectedTable?.id ?? null}
                      onTableSelect={handleTableSelect}
                      className="min-h-full"
                    />
                  ) : (
                  <div className="table-workspace-grid">
                    {visibleTableCards.map((table) => {
                      const displayStatus = resolveTableDisplayStatus(table);
                      const visual =
                        tableStatusConfig[displayStatus] ||
                        tableStatusConfig.available;
                      const balance = readTableBalance(table);
                      const hasOpenCheck = tableHasOpenCheckReference(table);
                      // Reserved tables (no open check) must keep the existing
                      // reservation-management path (edit / no-show / cancel) via
                      // TableActionModal, not the new-reservation shortcut.
                      // Cleaning/maintenance/unavailable tables are not ready for guests and must
                      // not offer guest order actions, even with no open check after payment.
                      const needsAttention =
                        !hasOpenCheck &&
                        (displayStatus === "cleaning" ||
                          displayStatus === "maintenance" ||
                          displayStatus === "unavailable");
                      const attentionActionLabel =
                        displayStatus === "cleaning"
                          ? t("tablesDashboard.needsCleaning", "Needs cleaning")
                          : t("tablesDashboard.outOfService", "Out of service");
                      const paidPercent =
                        balance.total > 0
                          ? Math.min(
                              100,
                              Math.round((balance.paid / balance.total) * 100),
                            )
                          : 0;
                      const occupiedSinceLabel =
                        hasOpenCheck && table.occupiedSince
                          ? formatOccupiedSince(table.occupiedSince, tableClockMs)
                          : null;
                      const waiterName =
                        table.currentWaiterName ||
                        t("tablesDashboard.unassigned", "Unassigned");
                      const guestCount =
                        table.guestCount || table.capacity || 0;

                      return (
                        <TableWorkspaceCard
                          key={table.id}
                          id={table.id}
                          number={formatTableDisplayNumber(table.tableNumber)}
                          shape={table.shape}
                          status={displayStatus}
                          statusLabel={visual.label}
                          floor={getTableFloorLabel(getTableFloorValue(table))}
                          covers={hasOpenCheck ? `${guestCount}/${table.capacity}` : String(table.capacity)}
                          waiter={waiterName}
                          hasOpenCheck={hasOpenCheck}
                          needsAttention={needsAttention}
                          attentionLabel={attentionActionLabel}
                          balance={balance}
                          paidPercent={paidPercent}
                          occupiedSince={occupiedSinceLabel}
                          orderId={table.currentOrderId}
                          formatCurrency={formatCurrency}
                          onPrimary={() => handleTableSelect(table)}
                        />
                      );
                    })}
                  </div>
                  )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : activeTab === "rooms" && hasRoomsModule ? (
          /* Rooms hub (Round 236) — embedded RoomsView; the bordered card bounds the scroll. */
          <div
            className={`h-full min-h-0 overflow-hidden rounded-2xl border shadow-sm transition-colors ${
              resolvedTheme === "light"
                ? "border-amber-100/80 bg-[#fffaf1]/90"
                : "border-white/10 bg-slate-950/45"
            }`}
          >
            {/* Round 237: the Rooms tab is browse-only — no preset. The New Order check-in /
                reservation flows run in the focused workflow modal below, not via this tab. */}
            <Suspense fallback={<div role="status" className="p-8">{t('common.loading')}</div>}>
              <RoomsView embedded />
            </Suspense>
          </div>
        ) : activeTab === "services" && hasServicesModule ? (
          /* Services hub (Round 236) — embedded AppointmentsView with its availability check intact. */
          <div
            className={`h-full min-h-0 overflow-hidden rounded-2xl border shadow-sm transition-colors ${
              resolvedTheme === "light"
                ? "border-amber-100/80 bg-[#fffaf1]/90"
                : "border-white/10 bg-slate-950/45"
            }`}
          >
            <Suspense fallback={<div role="status" className="p-8">{t('common.loading')}</div>}>
              <AppointmentsView
                embedded
                openCreateSignal={servicesOpenCreateSignal}
              />
            </Suspense>
          </div>
        ) : (
          /* Orders Grid - shown for Orders/Delivered/Canceled tabs */
          <div ref={orderGridRef} className="h-full min-h-0 overflow-hidden">
            <OrderGrid
              orders={filteredOrders}
              selectedOrders={selectedOrders}
              onToggleOrderSelection={handleToggleOrderSelection}
              onOrderDoubleClick={handleOrderDoubleClick}
              activeTab={activeTab as "orders" | "delivered" | "canceled"}
              storeMapOrigin={storeMapOrigin}
              className="h-full min-h-0"
            />
          </div>
        )}
        </div>

        {/* Declarative +New surface; real repair screens are owned by Task 9. */}
        <OrderPrimaryActionLauncher
          canOpen={canLaunchNewWork}
          onOpen={handleNewOrderClick}
        />

        {/* Order Type Selection Modal - Glassmorphism style */}
        <LiquidGlassModal
          isOpen={showOrderTypeModal}
          onClose={() => setShowOrderTypeModal(false)}
          title={t("primaryActions.trigger")}
          className={`${orderTypeModalWidthClass} order-type-transparent-modal`}
          contentClassName="!p-0 !overflow-visible"
        >
          <div className="p-2">
            {isOrderTypeTransitioning ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-b-yellow-500 dark:border-white/20 dark:border-b-yellow-400"></div>
                <span className="ml-3 liquid-glass-modal-text-muted">
                  {t("orderFlow.settingUpOrder") || "Setting up order..."}
                </span>
              </div>
            ) : (() => {
              // Localize each card's title + description once, then reuse for both the visible
              // text and the explicit aria-label (built via composeOrderTypeAriaLabel so the
              // accessible name never repeats the title when a locale leaves them identical).
              const deliveryTitle = t("orderFlow.deliveryOrder") || "Delivery Order";
              const deliveryDescription = t("modals.orderTypeSelection.deliveryDescription", {
                defaultValue: "Delivery to customer",
              });
              const pickupTitle = t("orderFlow.pickupOrder") || "Pickup Order";
              const pickupDescription = t("modals.orderTypeSelection.pickupDescription", {
                defaultValue: "Pickup at store",
              });
              const tableTitle = t("orderFlow.tableOrder") || "Table Order";
              const tableDescription = t("orderFlow.tableDescription") || "Dine-in order";
              const roomTitle = t("orderFlow.roomOrder", { defaultValue: "Room" });
              const roomDescription = t("orderFlow.roomDescription", {
                defaultValue: "Room order, check-in or reservation",
              });
              const serviceTitle = t("orderFlow.serviceOrder", { defaultValue: "Service" });
              const serviceDescription = t("orderFlow.serviceDescription", {
                defaultValue: "Book an appointment",
              });
              return (
              <div
                className={`grid gap-4 sm:gap-5 ${orderTypeGridColsClass}`}
              >
                {/* Delivery Button - Yellow (only if Delivery module acquired) */}
                {hasDeliveryModule && (
                  <button
                    type="button"
                    data-order-type-card="delivery"
                    onClick={() => handleOrderTypeSelect("delivery")}
                    aria-label={composeOrderTypeAriaLabel(deliveryTitle, deliveryDescription)}
                    className={`relative p-6 rounded-2xl border-2 border-[#facc15]/45 bg-[linear-gradient(135deg,rgba(250,204,21,0.16),rgba(234,179,8,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(deliveryCardVisibleIndex)}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <svg
                          className="w-full h-full text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          strokeWidth="1.5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12"
                          />
                        </svg>
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-yellow-400 transition-colors mb-1">
                          {deliveryTitle}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {deliveryDescription}
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                {/* Pickup Button - Green (the plain sale; only with the Orders module) */}
                {newWorkCard("pickup") && (
                <button
                  type="button"
                  data-order-type-card="pickup"
                  disabled={!newWorkCard("pickup")?.enabled}
                  onClick={() => handleOrderTypeSelect("pickup")}
                  aria-label={composeOrderTypeAriaLabel(pickupTitle, pickupDescription)}
                  className={`relative p-6 rounded-2xl border-2 border-[#34d399]/45 bg-[linear-gradient(135deg,rgba(52,211,153,0.16),rgba(22,163,74,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(pickupCardVisibleIndex)}${newWorkCardStateClass("pickup")}`}
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      <PickupOrderIcon className="w-full h-full text-white" />
                    </div>
                    <div className="text-center">
                      <h3 className="text-lg font-bold text-green-400 transition-colors mb-1">
                        {pickupTitle}
                      </h3>
                      <p className="text-sm leading-snug text-white/60 transition-colors">
                        {pickupDescription}
                      </p>
                    </div>
                  </div>
                </button>
                )}

                {/* Table Button - Blue (only if Tables module acquired) */}
                {hasTablesModule && (
                  <button
                    type="button"
                    data-order-type-card="table"
                    onClick={() => handleOrderTypeSelect("dine-in")}
                    aria-label={composeOrderTypeAriaLabel(tableTitle, tableDescription)}
                    className={`relative p-6 rounded-2xl border-2 border-[#60a5fa]/45 bg-[linear-gradient(135deg,rgba(96,165,250,0.16),rgba(37,99,235,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(tableCardVisibleIndex)}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        {/* Dine-in / table order icon */}
                        <TableOrderIcon
                          className="w-full h-full text-white"
                          strokeWidth={1.6}
                          opticalScale={1.62}
                        />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-[#60a5fa] transition-colors mb-1">
                          {tableTitle}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {tableDescription}
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                {/* Room Button - Purple (only if Rooms module acquired) — opens the room flow chooser */}
                {hasRoomsModule && (
                  <button
                    type="button"
                    data-order-type-card="room"
                    onClick={handleSelectRoomFlow}
                    aria-label={composeOrderTypeAriaLabel(roomTitle, roomDescription)}
                    className={`relative p-6 rounded-2xl border-2 border-[#a855f7]/45 bg-[linear-gradient(135deg,rgba(168,85,247,0.16),rgba(126,34,206,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(roomCardVisibleIndex)}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <BedDouble className="w-full h-full text-white" strokeWidth={1.5} />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-[#a855f7] transition-colors mb-1">
                          {roomTitle}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {roomDescription}
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                {/* Service Button - Teal (only if Appointments/Service Catalog module acquired) */}
                {hasServicesModule && (
                  <button
                    type="button"
                    data-order-type-card="service"
                    onClick={handleSelectServiceFlow}
                    aria-label={composeOrderTypeAriaLabel(serviceTitle, serviceDescription)}
                    className={`relative p-6 rounded-2xl border-2 border-[#22d3ee]/45 bg-[linear-gradient(135deg,rgba(34,211,238,0.16),rgba(8,145,178,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(serviceCardVisibleIndex)}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <CalendarClock className="w-full h-full text-white" strokeWidth={1.5} />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-[#22d3ee] transition-colors mb-1">
                          {serviceTitle}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {serviceDescription}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
                {/* Repair intake - Orange (only with the Repairs module) */}
                {newWorkCard("repair") && (
                  <button
                    type="button"
                    data-order-type-card="repair"
                    disabled={!newWorkCard("repair")?.enabled}
                    onClick={() => handleSelectRepairFlow("new_repair")}
                    aria-label={composeOrderTypeAriaLabel(
                      t("primaryActions.newRepair"),
                      t("orderFlow.repairDescription", { defaultValue: "Take in a device for repair" }),
                    )}
                    className={`relative p-6 rounded-2xl border-2 border-[#fb923c]/45 bg-[linear-gradient(135deg,rgba(251,146,60,0.16),rgba(234,88,12,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(repairCardVisibleIndex)}${newWorkCardStateClass("repair")}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <Wrench className="w-full h-full text-white" strokeWidth={1.5} />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-[#fb923c] transition-colors mb-1">
                          {t("primaryActions.newRepair")}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {newWorkCard("repair")?.enabled === false
                            ? t(newWorkCard("repair")?.disabledReasonKey ?? "orders.startShiftFirst")
                            : t("orderFlow.repairDescription", { defaultValue: "Take in a device for repair" })}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
                {/* Quick service - Violet (Repairs module with the quick-service capability) */}
                {newWorkCard("quick_service") && (
                  <button
                    type="button"
                    data-order-type-card="quick_service"
                    disabled={!newWorkCard("quick_service")?.enabled}
                    onClick={() => handleSelectRepairFlow("quick_service")}
                    aria-label={composeOrderTypeAriaLabel(
                      t("primaryActions.quickService"),
                      t("orderFlow.quickServiceDescription", { defaultValue: "Serve on the spot, no intake" }),
                    )}
                    className={`relative p-6 rounded-2xl border-2 border-[#a78bfa]/45 bg-[linear-gradient(135deg,rgba(167,139,250,0.16),rgba(124,58,237,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(quickServiceCardVisibleIndex)}${newWorkCardStateClass("quick_service")}`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <Zap className="w-full h-full text-white" strokeWidth={1.5} />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-[#a78bfa] transition-colors mb-1">
                          {t("primaryActions.quickService")}
                        </h3>
                        <p className="text-sm leading-snug text-white/60 transition-colors">
                          {newWorkCard("quick_service")?.enabled === false
                            ? t(newWorkCard("quick_service")?.disabledReasonKey ?? "orders.startShiftFirst")
                            : t("orderFlow.quickServiceDescription", { defaultValue: "Serve on the spot, no intake" })}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
              </div>
              );
            })()}
          </div>
        </LiquidGlassModal>

        {/* Room Flow Modal (Round 236) — Room Order / Check-in / Create Reservation chooser */}
        <LiquidGlassModal
          isOpen={showRoomFlowModal}
          onClose={() => setShowRoomFlowModal(false)}
          title={t("orderFlow.roomFlowTitle", { defaultValue: "Room" })}
          className="!max-w-md"
        >
          <div className="grid grid-cols-1 gap-3 p-2">
            {/* Room Order — only with the Orders module (it charges an order to a room folio). */}
            {hasOrdersModule && (
              <button
                type="button"
                onClick={handleRoomFlowOrder}
                aria-label={composeOrderTypeAriaLabel(
                  t("orderFlow.roomFlowOrder", { defaultValue: "Room Order" }),
                  t("orderFlow.roomFlowOrderDesc", { defaultValue: "Charge an order to a room" }),
                )}
                className="flex min-h-[64px] items-center gap-4 rounded-2xl border-2 border-amber-400/30 bg-gradient-to-br from-amber-500/10 to-amber-600/5 px-5 py-4 text-left transition-transform duration-150 active:scale-95"
              >
                <DoorOpen className="h-7 w-7 shrink-0 text-amber-400" strokeWidth={1.6} />
                <div>
                  <h3 className="text-base font-bold text-amber-400">
                    {t("orderFlow.roomFlowOrder", { defaultValue: "Room Order" })}
                  </h3>
                  <p className="text-sm leading-snug text-white/60">
                    {t("orderFlow.roomFlowOrderDesc", { defaultValue: "Charge an order to a room" })}
                  </p>
                </div>
              </button>
            )}

            {/* Check-in stays under the Rooms module (the Room card itself is Rooms-gated). */}
            <button
              type="button"
              onClick={handleRoomFlowCheckin}
              aria-label={composeOrderTypeAriaLabel(
                t("orderFlow.roomFlowCheckin", { defaultValue: "Check-in" }),
                t("orderFlow.roomFlowCheckinDesc", { defaultValue: "Check in a reserved room" }),
              )}
              className="flex min-h-[64px] items-center gap-4 rounded-2xl border-2 border-green-400/30 bg-gradient-to-br from-green-500/10 to-green-600/5 px-5 py-4 text-left transition-transform duration-150 active:scale-95"
            >
              <UserCheck className="h-7 w-7 shrink-0 text-green-400" strokeWidth={1.6} />
              <div>
                <h3 className="text-base font-bold text-green-400">
                  {t("orderFlow.roomFlowCheckin", { defaultValue: "Check-in" })}
                </h3>
                <p className="text-sm leading-snug text-white/60">
                  {t("orderFlow.roomFlowCheckinDesc", { defaultValue: "Check in a reserved room" })}
                </p>
              </div>
            </button>

            {/* Create Reservation — only with the Reservations module. */}
            {hasReservationsModule && (
              <button
                type="button"
                onClick={handleRoomFlowReservation}
                aria-label={composeOrderTypeAriaLabel(
                  t("orderFlow.roomFlowReservation", { defaultValue: "Create Reservation" }),
                  t("orderFlow.roomFlowReservationDesc", { defaultValue: "Reserve an available room" }),
                )}
                className="flex min-h-[64px] items-center gap-4 rounded-2xl border-2 border-purple-400/30 bg-gradient-to-br from-purple-500/10 to-purple-600/5 px-5 py-4 text-left transition-transform duration-150 active:scale-95"
              >
                <CalendarPlus className="h-7 w-7 shrink-0 text-[#a855f7]" strokeWidth={1.6} />
                <div>
                  <h3 className="text-base font-bold text-[#a855f7]">
                    {t("orderFlow.roomFlowReservation", { defaultValue: "Create Reservation" })}
                  </h3>
                  <p className="text-sm leading-snug text-white/60">
                    {t("orderFlow.roomFlowReservationDesc", { defaultValue: "Reserve an available room" })}
                  </p>
                </div>
              </button>
            )}
          </div>
        </LiquidGlassModal>

        {/* Room Order Selector (Round 236) — occupied rooms; only those with an active folio are tappable */}
        <LiquidGlassModal
          isOpen={showRoomOrderSelector}
          onClose={() => setShowRoomOrderSelector(false)}
          title={t("orderFlow.roomOrderTitle", { defaultValue: "Select a room" })}
          className="!max-w-3xl"
        >
          <div className="p-2">
            {roomOrderRooms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <BedDouble className="h-12 w-12 text-white/30" strokeWidth={1.5} />
                <p className="text-sm text-white/60">
                  {t("orderFlow.roomOrderEmpty", {
                    defaultValue: "No occupied rooms with an open folio yet",
                  })}
                </p>
                <p className="max-w-xs text-xs text-white/45">
                  {t("orderFlow.roomOrderEmptyHint", {
                    defaultValue:
                      "A room charge needs a checked-in guest with an active folio. Use Check-in first to open one.",
                  })}
                </p>
              </div>
            ) : (
              <>
                <RoomFloorChips
                  floors={roomOrderFloors}
                  value={roomOrderFloor}
                  onChange={setRoomOrderFloor}
                />
                {visibleRoomOrderRooms.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <BedDouble className="h-12 w-12 text-white/30" strokeWidth={1.5} />
                    <p className="text-sm text-white/60">
                      {t("roomsView.noRooms", { defaultValue: "No rooms found" })}
                    </p>
                  </div>
                ) : (
                  <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto scrollbar-hide pb-2 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleRoomOrderRooms.map((room) => {
                      const folioId = room.activeFolio?.id || null;
                      const guest = room.activeFolio?.guestName;
                      return (
                        <button
                          key={room.id}
                          type="button"
                          disabled={!folioId}
                          onClick={() => handleRoomOrderRoomSelect(room)}
                          aria-label={t("orderFlow.roomOrderSelectRoom", {
                            room: room.roomNumber,
                            defaultValue: "Room {{room}}",
                          })}
                          className={`flex flex-col gap-1 rounded-2xl border-2 px-4 py-3 text-left transition-transform duration-150 ${
                            folioId
                              ? "border-amber-400/30 bg-gradient-to-br from-amber-500/10 to-amber-600/5 active:scale-95"
                              : "border-white/10 bg-white/[0.03] opacity-50 cursor-not-allowed"
                          }`}
                        >
                          <span className="text-base font-bold text-white">
                            {t("orderFlow.roomOrderSelectRoom", {
                              room: room.roomNumber,
                              defaultValue: "Room {{room}}",
                            })}
                          </span>
                          {guest && <span className="text-sm text-white/70">{guest}</span>}
                          {folioId ? (
                            <span className="text-xs font-semibold text-amber-300">
                              {formatCurrency(room.activeFolio?.balance || 0)}
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-red-400">
                              {t("orderFlow.roomOrderNoFolio", { defaultValue: "No active folio" })}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </LiquidGlassModal>

        {/* Room Check-in (Round 238) — focused selector of RESERVED rooms only, then the check-in
            form for the chosen room. NO embedded RoomsView / hubPreset, no stats/search/filter/floor
            hub chrome. */}
        <RoomStaySelectorModal
          isOpen={showRoomCheckinSelector}
          variant="checkin"
          rooms={reservedRoomsForCheckin}
          onClose={() => setShowRoomCheckinSelector(false)}
          onSelectRoom={(room) => {
            setShowRoomCheckinSelector(false);
            setCheckinRoom(room);
          }}
        />
        {checkinRoom && (
          <RoomCheckinModal
            room={checkinRoom}
            branchId={effectiveBranchId || ""}
            organizationId={organizationId || ""}
            updateRoomStatus={updateHubRoomStatus}
            refetchRooms={refetchHubRooms}
            onClose={() => setCheckinRoom(null)}
            onCompleted={() => setCheckinRoom(null)}
          />
        )}

        {/* Create Reservation (Round 238) — focused selector of AVAILABLE rooms only, then the
            reservation form for the chosen room. NO embedded RoomsView / hubPreset. */}
        <RoomStaySelectorModal
          isOpen={showRoomReservationSelector}
          variant="reservation"
          rooms={availableRoomsForReservation}
          onClose={() => setShowRoomReservationSelector(false)}
          onSelectRoom={(room) => {
            setShowRoomReservationSelector(false);
            setReservationRoom(room);
          }}
        />
        {reservationRoom && (
          <RoomReservationModal
            room={reservationRoom}
            branchId={effectiveBranchId || ""}
            organizationId={organizationId || ""}
            updateRoomStatus={updateHubRoomStatus}
            refetchRooms={refetchHubRooms}
            onClose={() => setReservationRoom(null)}
            onCompleted={() => setReservationRoom(null)}
          />
        )}

        {/* Table Selector Modal (for table orders) */}
        <TableSelector
          isOpen={showTableSelector}
          tables={displayTables}
          onTableSelect={handleTableSelectorSelect}
          onClose={() => setShowTableSelector(false)}
        />

        {/* Table Action Modal */}
        {selectedTable && (
          <TableActionModal
            isOpen={showTableActionModal}
            table={selectedTable}
            onNewOrder={handleTableNewOrder}
            onNewReservation={handleTableNewReservation}
            canCreateReservation={hasReservationsModule}
            onSetAvailable={handleTableSetAvailable}
            onEditReservation={handleTableEditReservation}
            onNoShowReservation={handleTableNoShowReservation}
            onCancelReservation={handleTableCancelReservation}
            onClose={() => {
              setShowTableActionModal(false);
              setSelectedTable(null);
            }}
          />
        )}

        {tableReleaseModal}
        {tableReleaseApprovalModal}

        {selectedTable && (
          <TableCheckManagerModal
            isOpen={showTableCheckManager}
            table={selectedTable}
            tables={displayTables}
            localOrders={orders}
            onAddItems={handleTableCheckAddItems}
            onRefreshTables={refetchTables}
            onRefreshOrders={silentRefresh}
            onClose={() => {
              setShowTableCheckManager(false);
              // Paying/closing a check can move the table out of the active status
              // filter (e.g. occupied -> cleaning), which would leave an empty grid.
              // If the managed table no longer matches the filter, fall back to "all".
              if (selectedTable && tableStatusFilter !== "all") {
                const refreshed = tables.find(
                  (entry) => entry.id === selectedTable.id,
                );
                const currentStatus = refreshed
                  ? resolveTableDisplayStatus(refreshed)
                  : null;
                if (currentStatus && currentStatus !== tableStatusFilter) {
                  setTableStatusFilter("all");
                }
              }
              setSelectedTable(null);
            }}
          />
        )}

        {/* Reservation Form Modal */}
        {selectedTable && (
          <ReservationForm
            isOpen={showReservationForm}
            tableId={selectedTable.id}
            tableCapacity={selectedTable.capacity}
            tableNumber={selectedTable.tableNumber}
            initialReservation={editingReservation}
            onSubmit={handleReservationSubmit}
            onCancel={handleReservationCancel}
          />
        )}

        {/* Phone Lookup Modal */}
        {showPhoneLookupModal && (
          <CustomerSearchModal
            isOpen={showPhoneLookupModal}
            onClose={closeCustomerSearchModal}
            onCustomerSelected={handleCustomerSelectedDirect}
            onAddNewCustomer={handleAddNewCustomer}
            onEditCustomer={handleEditCustomer}
            onAddNewAddress={handleAddNewAddress}
          />
        )}

        {/* Add Customer Modal - also used for editing existing customers */}
        {showAddCustomerModal && (
          <AddCustomerModal
            isOpen={showAddCustomerModal}
            onClose={closeAddCustomerModal}
            onCustomerAdded={handleNewCustomerAdded}
            initialPhone={phoneNumber}
            initialCustomer={
              existingCustomer
                ? (() => {
                    const orderFlowCustomer =
                      existingCustomer as OrderFlowCustomer;
                    const resolvedAddress =
                      resolvePickupToDeliveryAddress(orderFlowCustomer);
                    const customerInfoData =
                      buildCustomerInfoFromOrderFlowCustomer(orderFlowCustomer);
                    return {
                      ...(orderFlowCustomer as any),
                      id: orderFlowCustomer.id,
                      phone: orderFlowCustomer.phone || "",
                      name: orderFlowCustomer.name,
                      email: orderFlowCustomer.email,
                      address:
                        resolvedAddress?.streetAddress ||
                        customerInfoData.address?.street ||
                        undefined,
                      city:
                        resolvedAddress?.city ||
                        customerInfoData.address?.city ||
                        undefined,
                      postal_code:
                        resolvedAddress?.postalCode ||
                        customerInfoData.address?.postalCode ||
                        undefined,
                      floor_number:
                        resolvedAddress?.floor ||
                        orderFlowCustomer.floor_number ||
                        undefined,
                      notes:
                        resolvedAddress?.notes ||
                        orderFlowCustomer.notes ||
                        undefined,
                      name_on_ringer:
                        resolvedAddress?.nameOnRinger ||
                        orderFlowCustomer.name_on_ringer,
                      addresses: orderFlowCustomer.addresses || [],
                      editAddressId: orderFlowCustomer.editAddressId,
                      selected_address_id:
                        orderFlowCustomer.selected_address_id,
                    };
                  })()
                : undefined
            }
            mode={customerModalMode}
          />
        )}

        {/* Customer Info Modal (New Order Flow) */}
        {showCustomerInfoModal && (
          <CustomerInfoModal
            isOpen={showCustomerInfoModal}
            onClose={() => setShowCustomerInfoModal(false)}
            onSave={handleNewOrderCustomerInfoSave}
            initialData={
              customerInfo
                ? {
                    name: customerInfo.name,
                    phone: customerInfo.phone,
                    address: customerInfo.address?.street || "",
                    floor_number:
                      customerInfo.address?.floor_number ||
                      customerInfo.address?.floor ||
                      "",
                    name_on_ringer:
                      customerInfo.address?.name_on_ringer || "",
                    coordinates: customerInfo.address?.coordinates,
                  }
                : {
                    name: "",
                    phone: phoneNumber,
                    address: "",
                  }
            }
            orderType={
              orderType === "delivery"
                ? "delivery"
                : orderType === "pickup"
                  ? "pickup"
                  : "dine-in"
            }
          />
        )}

        {/* Menu Modal */}
        <MenuModal
          key={menuSessionKey}
          isOpen={showMenuModal}
          onClose={() => { setRestoredCheckoutContext(null); handleMenuModalClose(); }}
          selectedCustomer={restoredCheckoutContext?.selectedCustomer || getCustomerForMenu()}
          selectedAddress={restoredCheckoutContext?.selectedAddress || getSelectedAddress()}
          orderType={selectedOrderType || "pickup"}
          deliveryZoneInfo={deliveryZoneInfo}
          onRepickDeliveryAddress={handleRepickDeliveryAddress}
          onOrderComplete={handleOrderComplete}
          roomChargeContext={roomChargeContext}
          draftContext={{ selectedTable, tableNumber, tableGuestCount, deliveryZoneInfo }}
          onDraftRestore={restoreCheckoutContext}
          onRecoveredOrder={acceptRecoveredCheckout}
        />

        {/* Split Payment Modal — rendered at OrderDashboard level so it
          survives MenuModal closing after order creation */}
        {splitPaymentData && (
          <SplitPaymentModal
            key={`${splitPaymentData.orderId}:${splitPaymentData.recoverySession ?? 0}`}
            isOpen={true}
            onClose={handleSplitPaymentClose}
            orderId={splitPaymentData.orderId}
            orderTotal={splitPaymentData.orderTotal}
            existingPayments={splitPaymentData.existingPayments}
            items={splitPaymentData.items}
            initialMode={splitPaymentData.initialMode || "by-items"}
            isGhostOrder={splitPaymentData.isGhostOrder}
            isReconciliationPending={isReconcilingSplitClose}
            collectionMode={splitPaymentData.collectionMode}
            allowDiscounts={splitPaymentData.kind !== "edit-settlement"}
            onSplitComplete={handleSplitComplete}
            collectionScope={collectionScope}
          />
        )}

        {outstandingPaymentData && (
          <OutstandingPaymentMethodModal
            isOpen={true}
            onClose={handleOutstandingClose}
            amount={outstandingPaymentData.outstandingAmount}
            orderType={outstandingPaymentData.orderType}
            isProcessing={isProcessingOutstandingPayment}
            onSelect={handleOutstandingPaymentSelect}
            existingOrder={outstandingExistingOrder}
          />
        )}
        {!outstandingPaymentData && giftReceiptRecoveries.length > 0 && (
          <div className="fixed bottom-4 right-4 z-40 space-y-2" data-testid="gift-receipt-recovery">
            {giftReceiptRecoveries.map((entry) => (
              <div
                key={entry.orderId}
                role="status"
                className="liquid-glass-modal-card flex items-center gap-3 rounded-2xl px-4 py-3 text-sm"
              >
                <span className="liquid-glass-modal-text">
                  {entry.orderNumber ? `#${entry.orderNumber} · ` : ""}
                  {t("giftCardCheckout.refusal.fiscalPending", {
                    defaultValue: "A receipt for this order is still pending. Check the receipt first.",
                  })}
                </span>
                <button
                  type="button"
                  className="liquid-glass-modal-button"
                  onClick={() => reenterGiftReceipt(entry.orderId)}
                >
                  {t("giftCardCheckout.checkAgain", { defaultValue: "Check again" })}
                </button>
              </div>
            ))}
          </div>
        )}

        {singlePaymentCollectionData && (
          <SinglePaymentCollectionModal
            isOpen={true}
            onClose={() => setSinglePaymentCollectionData(null)}
            onPaymentCollected={handleSinglePaymentCollected}
            orderId={singlePaymentCollectionData.orderId}
            orderNumber={singlePaymentCollectionData.orderNumber}
            method={singlePaymentCollectionData.method}
            outstandingAmount={Math.max(
              0,
              Number(singlePaymentCollectionData.blocker.totalAmount || 0) -
                Number(singlePaymentCollectionData.blocker.settledAmount || 0),
            )}
            settledAmount={Number(
              singlePaymentCollectionData.blocker.settledAmount || 0,
            )}
            totalAmount={Number(
              singlePaymentCollectionData.blocker.totalAmount || 0,
            )}
            collectionScope={collectionScope}
          />
        )}

        <EditOrderRefundSettlementModal
          isOpen={pendingEditRefundSettlement !== null}
          orderNumber={pendingEditRefundSettlement?.request.orderNumber}
          preview={pendingEditRefundSettlement?.preview || null}
          onConfirm={handleEditRefundSettlementConfirm}
        />

        {/*
          New simple cash/card picker shown after a paid-order edit produces
          a non-zero delta. Replaces the former SplitPaymentModal routing
          (collect) and the multi-line EditOrderRefundSettlementModal
          (refund) for edit-settlement cases. Zero-delta edits commit
          directly without this modal.
        */}
        <EditSettlementDeltaModal
          isOpen={editSettlementDeltaPrompt !== null}
          mode={editSettlementDeltaPrompt?.mode ?? "collect"}
          amount={editSettlementDeltaPrompt?.amount ?? 0}
          orderNumber={editSettlementDeltaPrompt?.orderNumber ?? null}
          onConfirm={handleEditSettlementDeltaConfirm}
          onCancel={handleEditSettlementDeltaCancel}
        />

        {/* Order Detail / Approval */}
        {showApprovalPanel && selectedOrderForApproval && isViewOnlyMode && (
          <OrderDetailsModal
            isOpen={true}
            orderId={
              selectedOrderForApproval.id ||
              selectedOrderForApproval.order_number ||
              ""
            }
            order={selectedOrderForApproval}
            onClose={() => {
              setShowApprovalPanel(false);
              setSelectedOrderForApproval(null);
              setIsViewOnlyMode(true);
            }}
            onPrintReceipt={async () => {
              const orderId = selectedOrderForApproval.id;
              if (!orderId) {
                toast.error(
                  t("orders.messages.printFailed", {
                    defaultValue: "No order ID available for printing",
                  }),
                );
                return;
              }

              toast.loading(
                t("orderApprovalPanel.printing", {
                  defaultValue: "Printing...",
                }),
                { id: "dashboard-view-print" },
              );
              try {
                const result = await bridge.payments.printReceipt(
                  orderId,
                  "order_receipt",
                );
                if ((result as any)?.skipped && (result as any)?.reason === "sandbox_order") {
                  toast.error(
                    t("orders.sandboxPrintSkipped", {
                      defaultValue:
                        "Test order — printing skipped. Enable «Print sandbox test orders» in Printer Settings.",
                    }),
                    { id: "dashboard-view-print" },
                  );
                } else if (result?.success) {
                  toast.success(
                    t("orderApprovalPanel.printSuccess", {
                      defaultValue: "Receipt printed successfully",
                    }),
                    { id: "dashboard-view-print" },
                  );
                } else {
                  toast.error(
                    result?.error ||
                      t("orderApprovalPanel.printFailed", {
                        defaultValue: "Failed to print receipt",
                      }),
                    { id: "dashboard-view-print" },
                  );
                }
              } catch (error: any) {
                console.error(
                  "[OrderDashboard] Failed to print receipt from view modal:",
                  error,
                );
                toast.error(
                  error?.message ||
                    t("orderApprovalPanel.printFailed", {
                      defaultValue: "Failed to print receipt",
                    }),
                  { id: "dashboard-view-print" },
                );
              }
            }}
          />
        )}

        {showApprovalPanel && selectedOrderForApproval && !isViewOnlyMode && (
          <OrderApprovalPanel
            key={approvalPanelInstance}
            order={selectedOrderForApproval}
            onApprove={handleApproveOrder}
            onDecline={handleDeclineOrder}
            onBeforeDecline={handleBeforeDeclineOrder}
            onClose={() => {
              setShowApprovalPanel(false);
              setSelectedOrderForApproval(null);
              setIsViewOnlyMode(true);
            }}
            viewOnly={false}
          />
        )}

        {/* Existing Modals */}
        <DriverAssignmentModal
          isOpen={showDriverModal}
          orderCount={pendingDeliveryOrders.length}
          onDriverAssign={handleDriverAssignment}
          onClose={handleDriverModalClose}
        />

        <OrderCancellationModal
          isOpen={showCancelModal}
          orderCount={pendingCancelOrders.length}
          recovery={Object.values(manualCancelPlans).find(plan => plan.pending) ? {
            reason: Object.values(manualCancelPlans).find(plan => plan.pending)?.reason || "",
            returnChannel: Object.values(manualCancelPlans).find(plan => plan.pending)?.returnChannel,
          } : undefined}
          manualReturn={Object.values(manualCancelPlans).some(plan => plan.requiresReturn) ? {
            amountCents: Object.values(manualCancelPlans).reduce((sum, plan) => sum + plan.amountCents, 0),
            currency: Object.values(manualCancelPlans).find(plan => plan.requiresReturn)?.currency || "",
          } : undefined}
          platformOrder={orders.some((order) => {
            if (!pendingCancelOrders.includes(order.id)) {
              return false;
            }
            const plugin =
              order.plugin ||
              order.order_plugin ||
              order.platform ||
              order.order_platform;
            const externalId =
              order.external_plugin_order_id || order.external_platform_order_id;
            return Boolean(plugin && externalId && isExternalPlatform(String(plugin)));
          })}
          onConfirmCancel={handleOrderCancellation}
          onClose={handleCancelModalClose}
        />

        <EditOptionsModal
          isOpen={showEditOptionsModal}
          orderCount={pendingEditOrders.length}
          onEditInfo={handleEditInfo}
          onEditOrder={handleEditOrder}
          onChangeOrderType={handleChangeOrderType}
          currentOrderType={
            pendingEditOrders.length === 1
              ? resolveEditableOrderType(
                  (orders.find((order) => order.id === pendingEditOrders[0]) as Order) || {
                    orderType: "pickup",
                    order_type: "pickup",
                  },
                )
              : "pickup"
          }
          onEditPayment={handleEditPayment}
          canEditPayment={
            canEditPaymentMethod && !isCheckingPaymentMethodEdit
          }
          paymentEditHint={
            isCheckingPaymentMethodEdit
              ? t("orderDashboard.paymentMethodEditChecking")
              : paymentEditIneligibilityReason
          }
          onClose={handleEditOptionsClose}
        />

        <EditPaymentMethodModal
          isOpen={showEditPaymentModal}
          orderNumber={editPaymentTarget?.orderNumber}
          currentMethod={editPaymentTarget?.currentMethod || "cash"}
          payments={editPaymentTarget?.payments || []}
          isSaving={isUpdatingPaymentMethod}
          onSave={handlePaymentMethodSave}
          onClose={handleEditPaymentClose}
        />

        {missingPaymentRepairTarget && (
          <OutstandingPaymentMethodModal
            isOpen={true}
            amount={missingPaymentRepairTarget.amount}
            orderType={missingPaymentRepairTarget.orderType}
            allowSplit={false}
            allowTwint={false}
            isProcessing={isRepairingMissingPayment}
            onSelect={handleMissingPaymentRepair}
            existingOrder={repairExistingOrder}
            onClose={() => {
              if (isRepairingMissingPayment) return;
              setMissingPaymentRepairTarget(null);
              setPendingEditOrders([]);
              setEditingSingleOrder(null);
            }}
          />
        )}

        <EditCustomerInfoModal
          isOpen={showEditCustomerModal}
          orderCount={
            editCustomerOrderIds.length ||
            pendingEditOrders.length ||
            (editCustomerSnapshot ? 1 : 0)
          }
          initialCustomerInfo={
            editCustomerSnapshot || getSelectedOrderCustomerInfo()
          }
          onSave={handleCustomerInfoSave}
          onClose={handleEditCustomerClose}
        />

        <EditOrderItemsModal
          isOpen={showEditOrderModal}
          orderCount={pendingEditOrders.length}
          orderId={
            pendingEditOrders.length > 0 ? pendingEditOrders[0] : undefined
          }
          orderNumber={getSelectedOrderNumber()}
          initialItems={getSelectedOrderItems()}
          onSave={handleOrderItemsSave}
          onClose={handleEditOrderClose}
        />

        {/* Menu-based Edit Order Modal */}
        <MenuModal
          isOpen={showEditMenuModal}
          onClose={() => { setRestoredCheckoutContext(null); handleEditMenuClose(); }}
          orderType={editingOrderType}
          editMode={true}
          editOrderId={currentEditOrderId}
          editSupabaseId={currentEditSupabaseId}
          editOrderNumber={currentEditOrderNumber}
          editSourceOrderType={currentEditSourceOrderType}
          editHeaders={editHeaders}
          initialCartItems={[]}
          onEditPreflight={handleEditMenuPreflight}
          onEditComplete={handleEditMenuComplete}
          draftContext={{ editOrderNumber: currentEditOrderNumber, editHeaders }}
          onDraftRestore={restoreCheckoutContext}
          onRecoveredOrder={acceptRecoveredCheckout}
        />

        {/* Receipt Preview Modal */}
        <PrintPreviewModal
          isOpen={showReceiptPreview}
          onClose={() => {
            if (receiptPreviewPrinting) return;
            setShowReceiptPreview(false);
            setReceiptPreviewHtml(null);
            setReceiptPreviewOrderId(null);
          }}
          onPrint={async () => {
            if (!receiptPreviewOrderId || receiptPreviewPrinting) {
              return;
            }
            setReceiptPreviewPrinting(true);
            try {
              const result: any = await bridge.payments.printReceipt(
                receiptPreviewOrderId,
              );
              if (result?.success === false) {
                throw new Error(
                  result?.error || "Failed to queue receipt print",
                );
              }
              toast.success(
                t("orderDashboard.receiptQueued") || "Receipt print queued",
              );
            } catch (error: any) {
              console.error(
                "[OrderDashboard] Failed to print receipt from preview:",
                error,
              );
              toast.error(error?.message || "Failed to print receipt");
            } finally {
              setReceiptPreviewPrinting(false);
            }
          }}
          title={t("orderDashboard.receiptPreview") || "Receipt Preview"}
          previewHtml={receiptPreviewHtml || ""}
          isPrinting={receiptPreviewPrinting}
        />
        {paymentPrintPromptModal}
      </div>
    );
  },
);

OrderDashboard.displayName = "OrderDashboard";

export default OrderDashboard;

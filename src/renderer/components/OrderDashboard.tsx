import React, {
  memo,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useOrderStore } from "../hooks/useOrderStore";
import { useShift } from "../contexts/shift-context";
import type { OrderItem } from "../types/orders";
import type { Customer, CustomerInfo } from "../types/customer";
import OrderGrid from "./OrderGrid";
import OrderTabsBar, { type TabId } from "./OrderTabsBar";
import BulkActionsBar from "./BulkActionsBar";
import DriverAssignmentModal from "./modals/DriverAssignmentModal";
import OrderCancellationModal from "./modals/OrderCancellationModal";
import EditOptionsModal from "./modals/EditOptionsModal";
import EditPaymentMethodModal from "./modals/EditPaymentMethodModal";
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
import { TableSelector, TableActionModal, TableCheckManagerModal, ReservationForm, TableFloorPlanView } from "./tables";
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
  UserCheck,
  Users,
  UtensilsCrossed,
  WalletCards,
} from "lucide-react";
import TableOrderIcon from "./icons/TableOrderIcon";
import PickupOrderIcon from "./icons/PickupOrderIcon";
import { toLocalDateString } from "../utils/date";
import {
  buildChangedReservationUpdate,
  reservationsService,
  type Reservation,
} from "../services/ReservationsService";
import { PrintPreviewModal } from "./modals/PrintPreviewModal";
import { FloatingActionButton } from "./ui/FloatingActionButton";
import { useTheme } from "../contexts/theme-context";
import { useI18n } from "../contexts/i18n-context";
import { usePaymentPrintPrompt, type PaymentPrintPromptContext } from "../hooks/usePaymentPrintPrompt";
import { MODULE_IDS, useAcquiredModules } from "../hooks/useAcquiredModules";
import { useTables } from "../hooks/useTables";
import { useRooms } from "../hooks/useRooms";
import { getRoomEffectiveStatus, type Room } from "../services/RoomsService";
import { RoomsView } from "../pages/verticals/hotel/RoomsView";
import { AppointmentsView } from "../pages/verticals/salon/AppointmentsView";
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
import { useKioskOrderAutoPrint } from "../hooks/useKioskOrderAutoPrint";
import { openExternalUrl } from "../utils/external-url";
import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from "../utils/orderNumberUtils";
import { formatTableDisplayNumber } from "../utils/table-display";
import {
  buildSingleDeliveryRouteStop,
  createTerminalSettingGetter,
  requestOptimizedDeliveryRoute,
  resolveSyncedBranchOriginFallback,
  resolveStoreMapOrigin,
} from "../utils/delivery-routing";
import { resolveDeliveryFee } from "../utils/delivery-fee";
import { pickMeaningfulOrderCustomerName } from "../utils/orderDisplay";
import { resolveAdjustmentAttribution } from "../utils/staffAttribution";
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from "../services/terminal-credentials";
import { couponRedemptionService } from "../services/CouponRedemptionService";
import { getBridge, offEvent, onEvent } from "../../lib";
import type {
  EditSettlementOrderUpdates,
  OrderFinancialsUpdateParams,
  OrderEditSettlementPreview,
  OrderEditSettlementRefund,
  PickupToDeliveryConversionParams,
} from "../../lib/ipc-adapter";
import { buildSplitPaymentItems } from "../utils/splitPaymentItems";
import { resolveOrderCompletionOutcome } from "../utils/orderCompletionOutcome";
import { deriveEditSettlementFinancials } from "../utils/editSettlementFinancials";
import {
  calculatePickupToDeliveryTotal,
  getPickupToDeliveryValidationAmount,
  resolvePickupToDeliveryAddress,
} from "../utils/pickup-to-delivery";
import {
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
  shouldShowInStandardOrderLane,
  tableHasOpenCheckReference,
} from "../utils/tableOrderFlow";
import {
  enqueueTableSessionOpen,
} from "../utils/tableSessionOfflineQueue";

const INCOMING_ORDER_ALERT_SOUND_URL = new URL(
  "../assets/sounds/incoming-order.mp3",
  import.meta.url,
).href;
const INCOMING_ORDER_ALERT_REPEAT_MS = 30_000;

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

const toLatLngCoordinates = (
  coordinates:
    | { lat: number; lng: number }
    | { type: "Point"; coordinates: [number, number] }
    | null
    | undefined,
  latitude?: number | null,
  longitude?: number | null,
): { lat: number; lng: number } | undefined => {
  if (
    coordinates &&
    "lat" in coordinates &&
    Number.isFinite(coordinates.lat) &&
    Number.isFinite(coordinates.lng)
  ) {
    return { lat: Number(coordinates.lat), lng: Number(coordinates.lng) };
  }

  if (
    coordinates &&
    "type" in coordinates &&
    coordinates.type === "Point" &&
    Array.isArray(coordinates.coordinates) &&
    coordinates.coordinates.length >= 2 &&
    Number.isFinite(coordinates.coordinates[1]) &&
    Number.isFinite(coordinates.coordinates[0])
  ) {
    return {
      lat: Number(coordinates.coordinates[1]),
      lng: Number(coordinates.coordinates[0]),
    };
  }

  if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    return {
      lat: Number(latitude),
      lng: Number(longitude),
    };
  }

  return undefined;
};

const buildCustomerInfoFromOrderFlowCustomer = (
  customer: OrderFlowCustomer,
): CustomerInfo => {
  const resolvedAddress = resolveCanonicalCustomerAddress(customer);
  const coordinates = toLatLngCoordinates(
    resolvedAddress?.coordinates ?? customer.coordinates,
    resolvedAddress?.latitude ?? customer.latitude,
    resolvedAddress?.longitude ?? customer.longitude,
  );

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
      latitude: coordinates?.lat ?? resolvedAddress?.latitude ?? customer.latitude ?? null,
      longitude:
        coordinates?.lng ?? resolvedAddress?.longitude ?? customer.longitude ?? null,
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

export const OrderDashboard = memo<OrderDashboardProps>(
  ({ className = "", orderFilter }) => {
    const bridge = getBridge();
    const { t } = useI18n();
    const { askForPaymentPrint, shouldAskPaymentPrint, paymentPrintPromptModal } =
      usePaymentPrintPrompt();
    const { resolvedTheme } = useTheme();
    const { getSetting, refresh: refreshTerminalSettings } =
      useTerminalSettings();
    const {
      orders,
      pendingExternalOrders,
      filter,
      setFilter,
      isLoading,
      updateOrderStatus,
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

    const scopedPendingExternalOrders = React.useMemo(
      () =>
        orderFilter
          ? pendingExternalOrders.filter(orderFilter)
          : pendingExternalOrders,
      [pendingExternalOrders, orderFilter],
    );

    // Module-based feature flags
    const {
      hasDeliveryModule,
      hasTablesModule,
      hasRoomsModule,
      hasAppointmentsModule,
      hasServiceCatalogModule,
      hasModule,
    } = useAcquiredModules();
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
    const visibleOrderTypeCardCount =
      1 +
      (hasDeliveryModule ? 1 : 0) +
      (hasTablesModule ? 1 : 0) +
      (hasRoomsModule ? 1 : 0) +
      (hasServicesModule ? 1 : 0);
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
    // Round 322: compose the chooser grid intentionally for 4 and 5 cards (live QA: a 3+2 set left a big
    // empty bottom-right hole). FIVE cards use a 6-col track on lg where each card spans 2 columns, so the
    // first row holds 3 and the bottom row of 2 is centered (the 4th visible card starts at col 2). FOUR
    // cards use a clean 4-up row on lg (never 3+1). 1/2/3 keep the existing compact tracks.
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
    // Each visible card's 1-based position in the live order (Delivery, Pickup, Table, Room, Service).
    // Pickup is always present; the others are module-gated. Computed by index (not card name) so the
    // centered layout is correct for any module combination.
    const deliveryCardVisibleIndex = hasDeliveryModule ? 1 : 0;
    const pickupCardVisibleIndex = deliveryCardVisibleIndex + 1;
    const tableCardVisibleIndex = pickupCardVisibleIndex + (hasTablesModule ? 1 : 0);
    const roomCardVisibleIndex = tableCardVisibleIndex + (hasRoomsModule ? 1 : 0);
    const serviceCardVisibleIndex = roomCardVisibleIndex + (hasServicesModule ? 1 : 0);
    // Per-card span/offset for the lg layout: in the 5-card 6-col track every card spans 2, and the 4th
    // visible card opens the centered bottom row at column 2. Other counts need no per-card class.
    const orderTypeCardSpanClass = (visibleIndex: number): string =>
      visibleOrderTypeCardCount >= 5
        ? visibleIndex === 4
          ? "lg:col-span-2 lg:col-start-2"
          : "lg:col-span-2"
        : "";
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

    // Auto-print kitchen tickets and receipts for incoming kiosk orders
    // assigned to this terminal. Only active when the terminal identity is resolved.
    useKioskOrderAutoPrint(resolvedTerminalId);

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

    const tableStatusConfig = useMemo(() => {
      const light = resolvedTheme === "light";
      return {
        available: {
          label: t("tablesDashboard.tableStatus.available", "Available"),
          card:
            light
              ? "border-emerald-300 bg-emerald-50/90"
              : "border-emerald-400/35 bg-emerald-500/10",
          badge:
            light
              ? "border-emerald-200 bg-emerald-100 text-emerald-700"
              : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
          accent: "bg-emerald-500",
          value: "text-emerald-600 dark:text-emerald-300",
        },
        occupied: {
          label: t("tablesDashboard.tableStatus.occupied", "Occupied"),
          card:
            light
              ? "border-zinc-300 bg-zinc-100/95"
              : "border-zinc-400/45 bg-zinc-500/10",
          badge:
            light
              ? "border-zinc-300 bg-zinc-200 text-zinc-700"
              : "border-zinc-500/30 bg-zinc-400/10 text-zinc-200",
          accent: "bg-zinc-800",
          value: "text-zinc-700 dark:text-zinc-200",
        },
        reserved: {
          label: t("tablesDashboard.tableStatus.reserved", "Reserved"),
          card:
            light
              ? "border-amber-300 bg-amber-50"
              : "border-amber-400/40 bg-amber-500/10",
          badge:
            light
              ? "border-amber-200 bg-amber-100 text-amber-700"
              : "border-amber-400/30 bg-amber-400/10 text-amber-200",
          accent: "bg-amber-500",
          value: "text-amber-600 dark:text-amber-300",
        },
        cleaning: {
          label: t("tablesDashboard.tableStatus.cleaning", "Cleaning"),
          card:
            light
              ? "border-slate-300 bg-slate-50"
              : "border-slate-400/25 bg-white/[0.045]",
          badge:
            light
              ? "border-slate-200 bg-slate-100 text-slate-700"
              : "border-slate-400/25 bg-slate-400/10 text-slate-200",
          accent: "bg-slate-500",
          value: "text-slate-600 dark:text-slate-300",
        },
        maintenance: {
          label: t("tablesDashboard.tableStatus.maintenance", "Maintenance"),
          card:
            light
              ? "border-orange-300 bg-orange-50"
              : "border-orange-400/35 bg-orange-500/10",
          badge:
            light
              ? "border-orange-200 bg-orange-100 text-orange-700"
              : "border-orange-400/25 bg-orange-400/10 text-orange-200",
          accent: "bg-orange-500",
          value: "text-orange-600 dark:text-orange-300",
        },
        unavailable: {
          label: t("tablesDashboard.tableStatus.unavailable", "Unavailable"),
          card:
            light
              ? "border-slate-300 bg-slate-100"
              : "border-slate-500/25 bg-slate-800/35",
          badge:
            light
              ? "border-slate-300 bg-slate-200 text-slate-700"
              : "border-slate-500/25 bg-slate-500/10 text-slate-300",
          accent: "bg-slate-500",
          value: "text-slate-600 dark:text-slate-300",
        },
      } satisfies Record<TableStatus, {
        label: string;
        card: string;
        badge: string;
        accent: string;
        value: string;
      }>;
    }, [resolvedTheme, t]);

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
    const [pendingCancelOrders, setPendingCancelOrders] = useState<string[]>(
      [],
    );
    const [showApprovalPanel, setShowApprovalPanel] = useState(false);
    const [selectedOrderForApproval, setSelectedOrderForApproval] =
      useState<Order | null>(null);
    const [isViewOnlyMode, setIsViewOnlyMode] = useState(true); // View-only mode for order details (no approve/decline)

    // State for edit modals
    const [showEditOptionsModal, setShowEditOptionsModal] = useState(false);
    const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
    const [showEditOrderModal, setShowEditOrderModal] = useState(false);
    const [showEditMenuModal, setShowEditMenuModal] = useState(false); // New: Menu-based edit modal
    const [showEditPaymentModal, setShowEditPaymentModal] = useState(false);
    const [isUpdatingPaymentMethod, setIsUpdatingPaymentMethod] =
      useState(false);
    const [editPaymentTarget, setEditPaymentTarget] = useState<{
      orderId: string;
      orderNumber?: string;
      currentMethod: "cash" | "card";
      paymentStatus: string;
    } | null>(null);
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

    // State for new order flow
    const [showOrderTypeModal, setShowOrderTypeModal] = useState(false);
    const [showMenuModal, setShowMenuModal] = useState(false);
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
    } | null>(null);
    const [singlePaymentCollectionData, setSinglePaymentCollectionData] =
      useState<PendingStatusPaymentCollection | null>(null);
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
    const alertTimeoutRef = useRef<number | null>(null);
    const alertingOrderIdRef = useRef<string | null>(null);
    const activeAlertAudioRef = useRef<HTMLAudioElement | null>(null);
    const shiftRefreshArmedRef = useRef(false);
    const splitPaymentCompletedRef = useRef(false);

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

    const closeAddCustomerModal = useCallback(() => {
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

    // Auto-open approval panel for external pending orders (queue)
    const playFallbackExternalOrderAlert = useCallback(() => {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 880;
        gain.gain.value = 0.18;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        oscillator.start();
        setTimeout(() => {
          oscillator.stop();
          ctx.close();
        }, 450);
      } catch (error) {
        console.warn(
          "[OrderDashboard] Failed to play order alert sound:",
          error,
        );
      }
    }, []);

    const playExternalOrderAlert = useCallback(() => {
      try {
        activeAlertAudioRef.current?.pause();
        activeAlertAudioRef.current = null;

        const audio = new Audio(INCOMING_ORDER_ALERT_SOUND_URL);
        audio.preload = "auto";
        audio.volume = 0.9;
        activeAlertAudioRef.current = audio;
        audio.addEventListener(
          "ended",
          () => {
            if (activeAlertAudioRef.current === audio) {
              activeAlertAudioRef.current = null;
            }
          },
          { once: true },
        );

        void audio.play().catch((error) => {
          if (activeAlertAudioRef.current === audio) {
            activeAlertAudioRef.current = null;
          }
          console.warn(
            "[OrderDashboard] Failed to play incoming order MP3, using fallback beep:",
            error,
          );
          playFallbackExternalOrderAlert();
        });
      } catch (error) {
        console.warn(
          "[OrderDashboard] Failed to prepare incoming order MP3, using fallback beep:",
          error,
        );
        playFallbackExternalOrderAlert();
      }
    }, [playFallbackExternalOrderAlert]);

    const startAlertLoop = useCallback(
      (orderId: string) => {
        if (alertTimeoutRef.current) {
          clearTimeout(alertTimeoutRef.current);
          alertTimeoutRef.current = null;
        }

        alertingOrderIdRef.current = orderId;

        const tick = () => {
          if (alertingOrderIdRef.current !== orderId) {
            return;
          }
          playExternalOrderAlert();
          alertTimeoutRef.current = window.setTimeout(
            tick,
            INCOMING_ORDER_ALERT_REPEAT_MS,
          );
        };

        tick();
      },
      [playExternalOrderAlert],
    );

    const stopAlertLoop = useCallback(() => {
      if (alertTimeoutRef.current) {
        clearTimeout(alertTimeoutRef.current);
        alertTimeoutRef.current = null;
      }
      alertingOrderIdRef.current = null;
      activeAlertAudioRef.current?.pause();
      activeAlertAudioRef.current = null;
    }, []);

    useEffect(() => {
      if (
        !scopedPendingExternalOrders ||
        scopedPendingExternalOrders.length === 0
      ) {
        stopAlertLoop();
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
      stopAlertLoop,
    ]);

    useEffect(() => {
      const activeOrderId =
        showApprovalPanel && !isViewOnlyMode
          ? selectedOrderForApproval?.id
          : null;
      if (!activeOrderId) {
        stopAlertLoop();
        return;
      }

      if (
        alertingOrderIdRef.current !== activeOrderId ||
        !alertTimeoutRef.current
      ) {
        startAlertLoop(activeOrderId);
      }
    }, [
      showApprovalPanel,
      isViewOnlyMode,
      selectedOrderForApproval,
      startAlertLoop,
      stopAlertLoop,
    ]);

    useEffect(
      () => () => {
        stopAlertLoop();
      },
      [stopAlertLoop],
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

      // Apply tab-specific filters
      switch (activeTab) {
        case "orders":
          filtered = filtered.filter((order) =>
            shouldShowInStandardOrderLane(order as any),
          );
          break;
        case "delivered":
          filtered = filtered.filter(
            (order) =>
              !isTableServiceOrder(order as any) &&
              (order.status === "delivered" || order.status === "completed"),
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

      baseOrders.forEach((order) => {
        const isTableOrder = isTableServiceOrder(order as any);
        if (!isTableOrder && shouldShowInStandardOrderLane(order as any)) {
          counts.orders++;
          return;
        }

        if (!isTableOrder && (order.status === "delivered" || order.status === "completed")) {
          counts.delivered++;
          return;
        }

        if (isCancelledOrderStatus(order.status)) {
          counts.canceled++;
        }
      });

      setOrderCounts(counts);
    }, [orders, filter, activeTab, orderFilter, displayTables]);

    // Handle tab change
    const handleTabChange = useCallback(
      (tab: TabId) => {
        // Source-of-truth gate: ignore taps on module tabs whose module is not acquired, so a stale
        // or out-of-band tab id can never surface a disabled vertical's content.
        if (tab === "tables" && !hasTablesModule) return;
        if (tab === "rooms" && !hasRoomsModule) return;
        if (tab === "services" && !hasServicesModule) return;
        if (tab === "delivered" && !hasDeliveryModule) return;
        setActiveTab(tab);
        clearBulkSelection();
        // Ensure global status filter doesn't hide tab contents
        try {
          setFilter({ status: "all" });
        } catch {}
      },
      [clearBulkSelection, setFilter, hasTablesModule, hasRoomsModule, hasServicesModule, hasDeliveryModule],
    );

    // If the active vertical tab's module becomes unavailable while selected (e.g. a module is
    // revoked mid-session), fall back to the always-available Orders tab so no dead/disabled
    // vertical content stays mounted.
    useEffect(() => {
      if (
        (activeTab === "tables" && !hasTablesModule) ||
        (activeTab === "rooms" && !hasRoomsModule) ||
        (activeTab === "services" && !hasServicesModule) ||
        (activeTab === "delivered" && !hasDeliveryModule)
      ) {
        setActiveTab("orders");
      }
    }, [activeTab, hasTablesModule, hasRoomsModule, hasServicesModule, hasDeliveryModule]);

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

    // Handle order approval
    const handleApproveOrder = async (
      orderId: string,
      estimatedTime?: number,
    ) => {
      try {
        await approveOrder(orderId, estimatedTime);
        await loadOrders();
        setShowApprovalPanel(false);
        setSelectedOrderForApproval(null);
        setIsViewOnlyMode(true);
      } catch (error) {
        toast.error(t("orderDashboard.approveOrderFailed"));
      }
    };

    // Handle order decline
    const handleDeclineOrder = async (orderId: string, reason: string) => {
      try {
        await declineOrder(orderId, reason);
        await loadOrders();
        setShowApprovalPanel(false);
        setSelectedOrderForApproval(null);
        setIsViewOnlyMode(true);
      } catch (error) {
        toast.error(t("orderDashboard.declineOrderFailed"));
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
      setShowOrderTypeModal(true);
    };

    // Handle order type selection (supports pickup, delivery, and dine-in/table)
    const handleOrderTypeSelect = async (
      type: "pickup" | "delivery" | "dine-in",
    ) => {
      setIsOrderTypeTransitioning(true);

      // Smooth transition
      await new Promise((resolve) => setTimeout(resolve, 300));

      setShowOrderTypeModal(false);
      setIsOrderTypeTransitioning(false);

      if (type === "pickup") {
        setSelectedOrderType("pickup");
        setOrderType("pickup");
        // For pickup orders, go directly to menu with basic customer info
        setCustomerInfo({
          name: "",
          phone: "",
          email: "",
          address: {
            street: "",
            city: "",
            postalCode: "",
          },
          notes: "",
        });
        setShowMenuModal(true);
      } else if (type === "delivery") {
        setSelectedOrderType("delivery");
        setOrderType("delivery");
        // For delivery orders, start with phone lookup
        setShowPhoneLookupModal(true);
      } else if (type === "dine-in") {
        // For table orders, show table selector
        setShowTableSelector(true);
      }
    };

    // --- Round 236: New Order -> Room / Service flows ---------------------------------------

    // New Order -> Room opens a small chooser (Room Order / Check-in / Create Reservation).
    const handleSelectRoomFlow = () => {
      setShowOrderTypeModal(false);
      setShowRoomFlowModal(true);
    };

    // New Order -> Service switches to the Services hub tab and opens the existing Create
    // Appointment modal. Its staff/service/day/time availability check is preserved untouched.
    const handleSelectServiceFlow = () => {
      setShowOrderTypeModal(false);
      setActiveTab("services");
      setServicesOpenCreateSignal((n) => n + 1);
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
      const guestName = room.activeFolio?.guestName || room.currentGuestName || null;
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
        const released = await updateTableStatus(selectedTable.id, "available", {
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
    }, [refetchTables, selectedTable, t, updateTableStatus]);

    const handleTableEditReservation = useCallback(async () => {
      const reservationBranchId = effectiveBranchId || branchId;
      if (!selectedTable || !reservationBranchId || !organizationId) {
        toast.error(
          t("orderDashboard.missingContext") ||
            "Missing branch or organization context",
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
          t("orderDashboard.missingContext") ||
            "Missing branch or organization context",
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
        await updateTableStatus(selectedTable.id, "available", { __release: true });
        await refetchTables();
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
    }, [branchId, effectiveBranchId, organizationId, refetchTables, releaseStaleReservedTable, selectedTable, t, updateTableStatus]);

    const handleTableCancelReservation = useCallback(async () => {
      const reservationBranchId = effectiveBranchId || branchId;
      if (!selectedTable || !reservationBranchId || !organizationId) {
        toast.error(
          t("orderDashboard.missingContext") ||
            "Missing branch or organization context",
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
        await updateTableStatus(selectedTable.id, "available", { __release: true });
        await refetchTables();
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
    }, [branchId, effectiveBranchId, organizationId, refetchTables, releaseStaleReservedTable, selectedTable, t, updateTableStatus]);

    const handleTableSetAvailable = useCallback(async () => {
      if (!selectedTable) {
        return;
      }

      const success = await updateTableStatus(selectedTable.id, "available");
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
    }, [selectedTable, t, updateTableStatus]);

    // Handle reservation form submission
    const handleReservationSubmit = useCallback(
      async (data: CreateReservationDto) => {
        const reservationBranchId = effectiveBranchId || branchId;
        if (!reservationBranchId || !organizationId) {
          toast.error(
            t("orderDashboard.missingContext") ||
              "Missing branch or organization context",
          );
          return;
        }

        try {
          // Set context for the service with actual IDs
          reservationsService.setContext(reservationBranchId, organizationId);

          // Format date and time from the Date object
          const reservationDate = toLocalDateString(data.reservationTime);
          const reservationTime = data.reservationTime
            .toTimeString()
            .slice(0, 5);

          if (editingReservation) {
            const updatePayload = buildChangedReservationUpdate(editingReservation, {
              customerName: data.customerName,
              customerPhone: data.customerPhone,
              partySize: data.partySize,
              reservationDate,
              reservationTime,
              tableId: data.tableId,
              specialRequests: data.specialRequests,
            });

            if (Object.keys(updatePayload).length > 0) {
              await reservationsService.updateReservationDetails(editingReservation.id, updatePayload);
            }

            toast.success(
              t("orderDashboard.reservationUpdated", {
                defaultValue: "Reservation updated successfully",
              }),
            );
            setShowReservationForm(false);
            setEditingReservation(null);
            setSelectedTable(null);
            await refetchTables();
            return;
          }

          // Create the reservation with table status update
          await reservationsService.createReservationWithTableUpdate({
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            partySize: data.partySize,
            reservationDate,
            reservationTime,
            tableId: data.tableId,
            specialRequests: data.specialRequests,
          });

          toast.success(
            t("orderDashboard.reservationCreated") ||
              "Reservation created successfully",
          );
          setShowReservationForm(false);
          setSelectedTable(null);
          await refetchTables();
        } catch (error) {
          console.error("Failed to create reservation:", error);
          const reservationUpdateError = extractOrderDashboardErrorMessage(error);
          toast.error(
            editingReservation
              ? reservationUpdateError ||
                t("orderDashboard.reservationUpdateFailed", {
                  defaultValue: "Failed to update reservation",
                })
              : t("orderDashboard.reservationFailed", {
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
    const handleTableReserve = useCallback((table: RestaurantTable) => {
      setEditingReservation(null);
      setSelectedTable(table);
      setShowReservationForm(true);
    }, []);

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

        const addressCoordinates = toLatLngCoordinates(
          resolvedAddress.coordinates,
          resolvedAddress.latitude,
          resolvedAddress.longitude,
        );
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
          const validationAmount =
            getPickupToDeliveryValidationAmount(targetOrder);
          let validationResult = await validateDeliveryAddress(
            validationTarget,
            validationAmount,
          );
          const canProceed =
            validationResult?.uiState?.canProceed ??
            validationResult?.deliveryAvailable ??
            validationResult?.isValid ??
            false;

          if (!canProceed) {
            const canAttemptOverride = Boolean(
              validationResult?.uiState?.showOverrideOption ||
              validationResult?.uiState?.requiresManagerApproval,
            );

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

          const deliveryFee = resolveDeliveryFee(validationResult);
          const validatedCoordinates =
            toLatLngCoordinates(validationResult?.coordinates, null, null) ||
            addressCoordinates;
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
            customerId: resolvedAddress.customerId || customer.id || undefined,
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
            deliveryLatitude:
              validatedCoordinates?.lat ?? resolvedAddress.latitude ?? undefined,
            deliveryLongitude:
              validatedCoordinates?.lng ?? resolvedAddress.longitude ?? undefined,
            deliveryAddressFingerprint:
              resolvedAddress.addressFingerprint || undefined,
            deliveryZoneId,
            deliveryFee,
            totalAmount,
          };

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
          const conversionMode = pickupToDeliveryContext.mode || "finalize";

          try {
            await silentRefresh();
          } catch (refreshError) {
            console.debug(
              "[OrderDashboard] Silent refresh after pickup-to-delivery failed:",
              refreshError,
            );
            await loadOrders();
          }

          if (conversionMode === "edit") {
            // EditOptionsModal "Change Order Type → Delivery" entry path.
            // Customer + address are persisted; order is now delivery with
            // delivery_fee set. Reopen the menu-edit session so the operator
            // can add/remove items against the delivery tier before saving.
            resetPickupToDeliveryFlow();
            setCurrentEditOrderId(targetOrder.id);
            setCurrentEditSupabaseId(targetOrder.supabase_id);
            setCurrentEditOrderNumber(
              targetOrder.order_number || targetOrder.orderNumber,
            );
            setEditingOrderType("delivery");
            setShowEditMenuModal(true);
            return true;
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
        bridge.orders,
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
    const handleCustomerSelectedDirect = async (customer: any) => {
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

      console.log(
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
      console.log(
        "[handleCustomerSelectedDirect] Current orderType:",
        orderType,
      );

      const normalizedCustomer = withMaterializedCustomerAddresses(
        customer as OrderFlowCustomer,
      ) as OrderFlowCustomer;
      const resolvedAddress = resolveCanonicalCustomerAddress(
        normalizedCustomer,
      );
      console.log(
        "[handleCustomerSelectedDirect] resolvedAddress:",
        JSON.stringify(resolvedAddress, null, 2),
      );

      // For delivery orders, validate that customer has an address
      if (orderType === "delivery") {
        setDeliveryZoneInfo(null);
        const hasAddress =
          resolvedAddress?.street_address || normalizedCustomer.address;
        console.log(
          "[handleCustomerSelectedDirect] Delivery check - hasAddress:",
          hasAddress,
        );
        if (!hasAddress) {
          console.log(
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

        // Validate delivery zone for the address
        try {
          const addressString = [
            resolvedAddress?.street_address || normalizedCustomer.address || "",
            resolvedAddress?.city || normalizedCustomer.city || "",
            resolvedAddress?.postal_code || normalizedCustomer.postal_code || "",
          ]
            .filter(Boolean)
            .join(", ");
          const addressCoordinates = toLatLngCoordinates(
            resolvedAddress?.coordinates,
            resolvedAddress?.latitude,
            resolvedAddress?.longitude,
          );

          if (addressCoordinates || addressString) {
            const validationResult = await validateDeliveryAddress(
              addressCoordinates || addressString,
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
          return;
        }

        await convertPickupOrderToDelivery(orderFlowCustomer);
        return;
      }

      console.log(
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
      console.log("[handleNewCustomerAdded] Current orderType:", orderType);

      const normalizedCustomer = withMaterializedCustomerAddresses(
        customer as OrderFlowCustomer,
      ) as OrderFlowCustomer;
      const resolvedAddress = resolveCanonicalCustomerAddress(
        normalizedCustomer,
      );
      console.log(
        "[handleNewCustomerAdded] resolvedAddress:",
        JSON.stringify(resolvedAddress, null, 2),
      );

      // For delivery orders, validate that customer has an address
      if (orderType === "delivery") {
        setDeliveryZoneInfo(null);
        const hasAddress =
          resolvedAddress?.street_address || normalizedCustomer.address;
        console.log(
          "[handleNewCustomerAdded] Delivery check - hasAddress:",
          hasAddress,
        );
        if (!hasAddress) {
          console.log(
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

        // Validate delivery zone for the address
        try {
          const addressString = [
            resolvedAddress?.street_address || normalizedCustomer.address || "",
            resolvedAddress?.city || normalizedCustomer.city || "",
            resolvedAddress?.postal_code || normalizedCustomer.postal_code || "",
          ]
            .filter(Boolean)
            .join(", ");
          const addressCoordinates = toLatLngCoordinates(
            resolvedAddress?.coordinates ?? normalizedCustomer.coordinates,
            resolvedAddress?.latitude ?? normalizedCustomer.latitude,
            resolvedAddress?.longitude ?? normalizedCustomer.longitude,
          );

          if (addressCoordinates || addressString) {
            const validationResult = await validateDeliveryAddress(
              addressCoordinates || addressString,
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

      // Store the customer info and proceed to menu
      console.log(
        "[handleNewCustomerAdded] Setting existingCustomer to:",
        normalizedCustomer?.name,
      );
      setExistingCustomer(normalizedCustomer);

      const customerInfoData =
        buildCustomerInfoFromOrderFlowCustomer(normalizedCustomer);
      console.log(
        "[handleNewCustomerAdded] Setting customerInfo to:",
        JSON.stringify(customerInfoData, null, 2),
      );
      setCustomerInfo(customerInfoData);

      setSpecialInstructions(customerInfoData.notes || "");

      // Close add customer modal and open menu modal
      console.log("[handleNewCustomerAdded] Opening MenuModal");
      setShowAddCustomerModal(false);
      setShowMenuModal(true);
    };

    // Handler for saving customer info from modal (New Order Flow)
    const handleNewOrderCustomerInfoSave = (info: any) => {
      console.log(
        "[handleNewOrderCustomerInfoSave] Called with info:",
        JSON.stringify(info, null, 2),
      );
      // Update local state
      const customerInfoData = {
        name: info.name,
        phone: info.phone,
        email: info.email,
        address: {
          street: info.address || "",
          city: "", // info.address is single string in modal often, might need parsing or just store as street
          postalCode: "",
          coordinates: info.coordinates,
        },
        notes: "",
      };
      console.log(
        "[handleNewOrderCustomerInfoSave] Setting customerInfo:",
        JSON.stringify(customerInfoData, null, 2),
      );
      setCustomerInfo(customerInfoData);

      // Close customer info modal and open menu modal
      console.log("[handleNewOrderCustomerInfoSave] Opening MenuModal");
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
      console.log(
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
        console.log(
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
        console.log(
          "[getCustomerForMenu] Returning from customerInfo:",
          result,
        );
        return result;
      }
      console.log("[getCustomerForMenu] Returning null");
      return null;
    };

    const getSelectedAddress = () => {
      const resolvedAddress = existingCustomer
        ? resolveCanonicalCustomerAddress(
            existingCustomer as OrderFlowCustomer,
          )
        : null;
      if (resolvedAddress?.street_address) {
        console.log(
          "[getSelectedAddress] Found canonical address from existingCustomer:",
          resolvedAddress.street_address,
        );
        return resolvedAddress;
      }

      // Finally check customerInfo state
      if (customerInfo?.address) {
        const streetValue = customerInfo.address.street || "";
        if (streetValue) {
          console.log(
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
            coordinates: customerInfo.address.coordinates,
            latitude:
              customerInfo.address.latitude ??
              customerInfo.address.coordinates?.lat ??
              null,
            longitude:
              customerInfo.address.longitude ??
              customerInfo.address.coordinates?.lng ??
              null,
          };
        }
      }
      console.log(
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
        console.log(
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
      console.log("[OrderDashboard] Fiscal print result:", fiscalResult);
    };

    // Handle order completion from menu modal. Resolves false on failure so
    // MenuModal/PaymentModal keep the cart and skip their success toasts.
    const handleOrderComplete = async (orderData: any): Promise<boolean> => {
      const isSplitPayment = orderData.paymentData?.method === "pending";
      const isTablePaymentSave = orderData.paymentData?.method === "table";
      let createdOrderId: string | undefined;
      let orderPersisted = false;
      const finishOrderCompletion = (succeeded: boolean): boolean => {
        const outcome = resolveOrderCompletionOutcome({
          succeeded,
          orderPersisted,
        });
        if (outcome.resetOrderUiState) {
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
        console.log(
          "[OrderDashboard.handleOrderComplete] orderData:",
          orderData,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] orderData.items with notes:",
          orderData.items?.map((item: any) => ({
            name: item.name,
            notes: item.notes,
            special_instructions: item.special_instructions,
          })),
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] orderData.address:",
          orderData.address,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] existingCustomer:",
          existingCustomer,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] existingCustomer?.address:",
          existingCustomer?.address,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] customerInfo:",
          customerInfo,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] customerInfo?.address:",
          customerInfo?.address,
        );
        console.log(
          "[OrderDashboard.handleOrderComplete] getSelectedAddress():",
          getSelectedAddress(),
        );
        console.log(
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

          console.log("[OrderDashboard.handleOrderComplete] addr:", addr);
          console.log(
            "[OrderDashboard.handleOrderComplete] legacyCustomerAddress:",
            legacyCustomerAddress,
          );
          console.log(
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

          console.log(
            "[OrderDashboard.handleOrderComplete] deliveryAddress built:",
            deliveryAddress,
          );
          console.log(
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
            console.log(
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
                console.log(
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
                  console.log(
                    "[OrderDashboard.handleOrderComplete] Database fallback address from addresses[]:",
                    deliveryAddress,
                  );
                }
                // Check legacy customer.address field (simple string)
                else if (dbCustomer.address) {
                  deliveryAddress = dbCustomer.address;
                  console.log(
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

        const total = subtotal - totalDiscountAmount + deliveryFee;
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
        const initialPayment =
          !isGhostOrder &&
          !isSplitPayment &&
          (paymentMethod === "cash" ||
            paymentMethod === "card" ||
            paymentMethod === "room_charge")
            ? {
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
              }
            : undefined;

        const existingOrderId = orderData.paymentData?.existingOrderId;
        if (existingOrderId && (paymentMethod === "cash" || paymentMethod === "card")) {
          const askBeforeFallbackPrint = await shouldAskPaymentPrint();
          const paymentResult: any = await bridge.payments.recordPayment({
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
          });
          if (paymentResult?.success === false) {
            throw new Error(paymentResult.error || "Failed to record payment");
          }
          await silentRefresh().catch((err) =>
            console.debug("[OrderDashboard] Silent refresh after fallback payment failed:", err),
          );
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
        const persistedCustomerName = isTableOrder
          ? pickMeaningfulOrderCustomerName(
              orderData.customer?.name,
              orderData.customer?.full_name,
              customerInfo?.name,
              existingCustomer?.name,
            )
          : selectedOrderType === "pickup"
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
          customer_id: persistedCustomerId,
          customerId: persistedCustomerId,
          customer_name: persistedCustomerName ?? undefined,
          customer_phone:
            orderData.customer?.phone_number ||
            orderData.customer?.phone ||
            customerInfo?.phone ||
            existingCustomer?.phone ||
            "",
          items: normalizePosOrderItems(orderData.items || []),
          total_amount: total,
          subtotal: subtotal,
          discount_amount: totalDiscountAmount,
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
          delivery_city: deliveryCity,
          delivery_postal_code: deliveryPostalCode,
          delivery_floor: deliveryFloor,
          delivery_notes: deliveryNotes,
          name_on_ringer: nameOnRinger,
          notes: orderData.notes || null,
        };

        console.log(
          "[OrderDashboard] Creating order with data:",
          orderToCreate,
        );

        const result = await createOrder(orderToCreate as any);

        if (result.success) {
          createdOrderId = result.orderId;
          orderPersisted = true;

          const roomCharge = (result as any).roomCharge;
          if (isRoomChargePayment && roomCharge?.applied === false && result.orderId) {
            await silentRefresh().catch((err) =>
              console.debug("[OrderDashboard] Silent refresh after room-charge fallback failed:", err),
            );
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
          silentRefresh().catch((err) =>
            console.debug("[OrderDashboard] Background refresh error:", err),
          );

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
      [],
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
          const refundAmount = Math.max(
            0,
            Number(previews[0].paidTotal || 0) -
              Number(previews[0].nextTotal || 0),
          );
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

        if (mode === "collect") {
          await bridge.orders.applyEditSettlement({
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
                  paymentOrigin: "manual",
                  collectedBy: "cashier_drawer",
                },
              ],
            },
          });
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
                  cashHandler:
                    method === "cash" ? "cashier_drawer" : undefined,
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
        editSettlementDeltaPrompt,
        loadOrders,
        staff?.databaseStaffId,
        staff?.staffId,
        t,
      ],
    );

    const handleEditSettlementDeltaCancel = useCallback(() => {
      // Nothing to roll back server-side — the edit-settlement payments
      // row only gets written on confirm. Close the modal and let the
      // operator retry via the normal edit flow if they still want to.
      setEditSettlementDeltaPrompt(null);
    }, []);

    const handleSplitComplete = async (_result: SplitPaymentResult) => {
      splitPaymentCompletedRef.current = true;
      const closingSplitPayment = splitPaymentData;
      setSplitPaymentData(null);
      await silentRefresh().catch(() => {});
      if (
        closingSplitPayment?.kind === "status-blocker" &&
        closingSplitPayment.statusAfterCollection
      ) {
        await retryBlockedStatusTransition(
          closingSplitPayment.orderId,
          closingSplitPayment.statusAfterCollection,
        );
      }
    };

    const handleSplitPaymentClose = useCallback(() => {
      const closingSplitPayment = splitPaymentData;
      const wasSuccessful = splitPaymentCompletedRef.current;
      splitPaymentCompletedRef.current = false;
      setSplitPaymentData(null);
      if (!wasSuccessful && closingSplitPayment?.kind === "edit-settlement") {
        toast(
          t("orderDashboard.orderEditPartialPaymentSaved", {
            defaultValue:
              "Order changes were saved. The remaining balance is still pending payment.",
          }),
        );
      }
      void silentRefresh().catch(() => {});
    }, [silentRefresh, splitPaymentData, t]);

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
        } else if (action === "return" || action === "restore") {
          // Reactivate cancelled orders back to active (pending)
          const cancelledOrders = selectedOrderObjects.filter(
            (order) => isCancelledOrderStatus(order.status),
          );

          if (cancelledOrders.length === 0) {
            toast.error(t("orderDashboard.noCancelledOrdersSelected"));
          } else {
            for (const order of cancelledOrders) {
              const success = await updateOrderStatus(order.id, "pending");
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
                  skippedMessages.push(`${skippedNonDelivery} non-delivery`);
                }
                if (skippedMissingAddress > 0) {
                  skippedMessages.push(
                    `${skippedMissingAddress} missing address`,
                  );
                }

                toast.success(
                  optimizationResult.route.chunked
                    ? t("orderDashboard.openedOptimizedMapsChunked", {
                        defaultValue:
                          "Opened {{count}} optimized route launch(es).",
                        count: optimizationResult.route.launches.length,
                      })
                    : t("orderDashboard.openedInMaps", {
                        defaultValue:
                          "Opened Google Maps for {{count}} delivery stop(s).",
                        count: routeStops.length,
                      }),
                );

                if (skippedMessages.length > 0) {
                  toast(
                    t("orderDashboard.mapSkippedOrders", {
                      defaultValue: "Skipped {{details}}.",
                      details: skippedMessages.join(", "),
                    }),
                  );
                }

                optimizationResult.route.warnings.forEach((warning) => {
                  toast(warning);
                });
              } catch (e) {
                console.error("Failed to open Google Maps:", e);
                toast.error(t("orderDashboard.mapOpenFailed"));
              }
            }
          }
        } else if (action === "cancel") {
          // Handle cancel action - show cancellation modal
          if (selectedOrders.length > 0) {
            setPendingCancelOrders(selectedOrders);
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

    // Handle order cancellation
    const handleOrderCancellation = async (reason: string) => {
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
          const success = await updateOrderStatus(
            orderId,
            "cancelled",
            cancellationOptions,
          );
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
        clearBulkSelection();
      } catch (error) {
        console.error("Failed to cancel orders:", error);
        toast.error(t("orderDashboard.cancelFailed"));
      }
    };

    // Handle cancel modal close
    const handleCancelModalClose = () => {
      setShowCancelModal(false);
      setPendingCancelOrders([]);
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
      setEditCustomerOrderIds(targetOrderIds);
      setShowEditOptionsModal(false);
      setShowEditCustomerModal(true);
    };

    const editablePaymentOrder = React.useMemo(() => {
      if (pendingEditOrders.length !== 1) return null;
      return orders.find((order) => order.id === pendingEditOrders[0]) || null;
    }, [pendingEditOrders, orders]);

    const editablePaymentMethod = React.useMemo<"cash" | "card" | null>(() => {
      if (!editablePaymentOrder) return null;
      const method = String(
        editablePaymentOrder.payment_method ||
          editablePaymentOrder.paymentMethod ||
          "",
      )
        .trim()
        .toLowerCase();
      return method === "cash" || method === "card" ? method : null;
    }, [editablePaymentOrder]);

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

      if (!editablePaymentMethod) {
        return t("orderDashboard.paymentMethodEditUnavailable");
      }

      return undefined;
    }, [
      pendingEditOrders.length,
      editablePaymentOrder,
      editablePaymentMethod,
      t,
    ]);

    const canEditPaymentMethod = !paymentEditIneligibilityReason;

    const handleEditPayment = () => {
      if (!canEditPaymentMethod) {
        toast.error(
          paymentEditIneligibilityReason ||
            t("orderDashboard.paymentMethodEditUnavailable"),
        );
        return;
      }

      if (!editablePaymentOrder || !editablePaymentMethod) {
        toast.error(t("orderDashboard.paymentMethodEditUnavailable"));
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
          editablePaymentOrder.order_number || editablePaymentOrder.orderNumber,
        currentMethod: editablePaymentMethod,
        paymentStatus,
      });
      setShowEditOptionsModal(false);
      setShowEditPaymentModal(true);
    };

    // Used when the operator changes order type FROM delivery TO pickup or
    // dine-in via the Change-Order-Type card. Per product decision: customer
    // name/phone are preserved on the order record (reprints, loyalty,
    // recall search by phone) but delivery-specific fields are cleared so
    // z-reports and driver views don't show a delivery address attached
    // to a pickup/dine-in order. Best-effort — if the bridge call fails
    // the local state is still updated, and the server-side update will
    // retry through the normal sync queue on the next save.
    //
    const clearDeliveryFieldsForOrder = async (orderId: string) => {
      try {
        const order = orders.find((o) => o.id === orderId);
        if (!order) return;
        const customerName = String(
          order.customer_name || order.customerName || "",
        ).trim();
        const customerPhone = String(
          order.customer_phone || order.customerPhone || "",
        ).trim();
        if (!customerName || !customerPhone) {
          // The `updateCustomerInfo` bridge requires name + phone as
          // required fields. If neither is set, we can't call it —
          // that's fine, the order had nothing delivery-specific to
          // clear anyway (or it'll be corrected on the next save).
          return;
        }
        const result = await bridge.orders.updateCustomerInfo({
          orderId,
          customerName,
          customerPhone,
          deliveryAddress: "",
          deliveryPostalCode: "",
          deliveryNotes: "",
        });
        if (!result?.success) {
          console.warn(
            "[OrderDashboard] clearDeliveryFieldsForOrder: non-success response",
            result,
          );
        }
        // silentRefresh picks up the cleared fields for subsequent
        // renders; also re-hydrates any other fields that drift.
        try {
          await silentRefresh();
        } catch {
          /* non-fatal — loadOrders will converge later */
        }
      } catch (err) {
        console.warn(
          "[OrderDashboard] clearDeliveryFieldsForOrder failed (non-fatal):",
          err,
        );
      }
    };

    const openMenuEditSession = (targetOrderType?: EditableOrderType) => {
      setShowEditOptionsModal(false);

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

          console.log(
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

      // Delivery → pickup/dine-in: keep customer, clear delivery-only
      // fields before reopening the menu. Per product decision: we never
      // silently keep delivery_address on an order whose type is no
      // longer delivery — that pollutes z-reports and driver views.
      // TS note: targetOrderType is narrowed to "pickup" | "dine-in" here
      // because the delivery branch above returned.
      if (currentType === "delivery") {
        void clearDeliveryFieldsForOrder(orderBeingEdited.id);
      }

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

    const handlePaymentMethodSave = async (nextMethod: "cash" | "card") => {
      if (!editPaymentTarget) {
        toast.error(t("orderDashboard.paymentMethodEditUnavailable"));
        return;
      }
      const sameMethodRequested =
        editPaymentTarget.currentMethod === nextMethod;

      setIsUpdatingPaymentMethod(true);
      try {
        const result: any = await bridge.payments.updatePaymentMethod(
          editPaymentTarget.orderId,
          nextMethod,
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
        const message =
          extractOrderDashboardErrorMessage(error) ||
          t("orderDashboard.paymentMethodUpdateFailed");
        toast.error(message);
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
        const updatePayload = {
          customerName: customerInfo.name.trim(),
          customerPhone: customerInfo.phone.trim(),
          deliveryAddress: customerInfo.address.trim(),
          deliveryPostalCode: customerInfo.postal_code?.trim() || null,
          deliveryFloor: customerInfo.delivery_floor?.trim() || null,
          nameOnRinger: customerInfo.name_on_ringer?.trim() || null,
          deliveryNotes: customerInfo.notes?.trim() || null,
          deliveryLatitude: customerInfo.latitude ?? customerInfo.coordinates?.lat ?? null,
          deliveryLongitude: customerInfo.longitude ?? customerInfo.coordinates?.lng ?? null,
          deliveryAddressFingerprint: customerInfo.addressFingerprint ?? null,
        };
        for (const orderId of targetOrderIds) {
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

    // Handle menu-based order edit completion
    const handleEditMenuComplete = async (orderData: {
      orderId: string;
      items: any[];
      total: number;
      orderType?: string;
      notes?: string;
    }) => {
      try {
        const targetOrder = orders.find((order) => order.id === orderData.orderId);
        const targetOrderType = resolveEditableOrderType({
          orderType:
            (orderData.orderType as Order["orderType"]) ||
            targetOrder?.orderType,
          order_type:
            (orderData.orderType as Order["order_type"]) ||
            targetOrder?.order_type,
        });
        const settlementPayload = deriveEditSettlementPayload(
          targetOrder,
          normalizeEditOrderItems(orderData.items),
          targetOrderType,
        );

        await applySettlementAwareOrderEdit([
          {
            orderId: orderData.orderId,
            orderNumber: currentEditOrderNumber,
            items: orderData.items,
            orderNotes: orderData.notes,
            financials: settlementPayload.financials,
            orderUpdates: settlementPayload.orderUpdates,
          },
        ]);
      } catch (error) {
        console.error("Failed to update order items:", error);
        const errorMessage = extractOrderDashboardErrorMessage(error);
        toast.error(errorMessage || t("orderDashboard.orderItemsFailed"));
      }
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
      const rawAddress = firstOrder?.address && typeof firstOrder.address === "object"
        ? firstOrder.address
        : null;
      return {
        name: firstOrder?.customerName || firstOrder?.customer_name || "",
        phone: firstOrder?.customerPhone || firstOrder?.customer_phone || "",
        address:
          firstOrder?.deliveryAddress ||
          firstOrder?.delivery_address ||
          firstOrder?.address ||
          "",
        postal_code:
          firstOrder?.deliveryPostalCode ||
          firstOrder?.delivery_postal_code ||
          firstOrder?.postalCode ||
          firstOrder?.postal_code ||
          "",
        delivery_floor:
          firstOrder?.deliveryFloor ||
          firstOrder?.delivery_floor ||
          rawAddress?.floor_number ||
          rawAddress?.floor ||
          "",
        name_on_ringer:
          firstOrder?.nameOnRinger ||
          firstOrder?.name_on_ringer ||
          rawAddress?.name_on_ringer ||
          rawAddress?.nameOnRinger ||
          "",
        notes:
          firstOrder?.deliveryNotes ||
          firstOrder?.delivery_notes ||
          firstOrder?.specialInstructions ||
          firstOrder?.special_instructions ||
          firstOrder?.notes ||
          "",
        coordinates: toLatLngCoordinates(
          firstOrder?.coordinates,
          firstOrder?.deliveryLatitude ?? firstOrder?.delivery_latitude ?? firstOrder?.latitude,
          firstOrder?.deliveryLongitude ?? firstOrder?.delivery_longitude ?? firstOrder?.longitude,
        ),
        latitude:
          typeof (firstOrder?.deliveryLatitude ?? firstOrder?.delivery_latitude) === "number"
            ? firstOrder?.deliveryLatitude ?? firstOrder?.delivery_latitude
            : typeof firstOrder?.latitude === "number" ? firstOrder.latitude : null,
        longitude:
          typeof (firstOrder?.deliveryLongitude ?? firstOrder?.delivery_longitude) === "number"
            ? firstOrder?.deliveryLongitude ?? firstOrder?.delivery_longitude
            : typeof firstOrder?.longitude === "number"
              ? firstOrder.longitude
              : null,
        addressFingerprint:
          firstOrder?.deliveryAddressFingerprint ||
          firstOrder?.delivery_address_fingerprint ||
          null,
      };
    };

    // Get order items for the first selected order (for editing)
    const getSelectedOrderItems = () => {
      if (pendingEditOrders.length === 0) {
        console.log(
          "[OrderDashboard] getSelectedOrderItems: No pending edit orders",
        );
        return [];
      }

      const firstOrder = orders.find(
        (order) => order.id === pendingEditOrders[0],
      );
      console.log(
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

    // Show skeleton during loading (only when shift is active)
    if (isLoading && isShiftActive) {
      return <OrderDashboardSkeleton />;
    }

    // Show error display if there's an error
    if (error) {
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
        {/* Order Conflict Banner */}
        {/* Conflict banner intentionally disabled: remote always wins */}

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
            showDeliveredTab={hasDeliveryModule}
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
            className={`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border p-4 shadow-sm transition-colors ${
              resolvedTheme === "light"
                ? "border-amber-100/80 bg-[#fffaf1]/90"
                : "border-white/10 bg-slate-950/45"
            }`}
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
                <div className="shrink-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:min-w-[390px]">
                    <div
                      className={`rounded-xl border px-4 py-3 backdrop-blur-xl ${
                        resolvedTheme === "light"
                          ? "border-amber-100/80 bg-[#fffdf8]"
                          : "border-white/10 bg-white/[0.055]"
                      }`}
                    >
                      <div
                        className={`text-[11px] font-bold uppercase tracking-wide ${
                          resolvedTheme === "light"
                            ? "text-slate-500"
                            : "text-slate-400"
                        }`}
                      >
                        {t("tablesDashboard.occupied", "Occupied")}
                      </div>
                      <div
                        className={`mt-1 text-xl font-black ${
                          resolvedTheme === "light"
                            ? "text-slate-950"
                            : "text-white"
                        }`}
                      >
                        {tableGridStats.occupied}/{tableGridStats.total}
                      </div>
                    </div>
                    <div
                      className={`rounded-xl border px-4 py-3 backdrop-blur-xl ${
                        resolvedTheme === "light"
                          ? "border-amber-100/80 bg-[#fffdf8]"
                          : "border-white/10 bg-white/[0.055]"
                      }`}
                    >
                      <div
                        className={`text-[11px] font-bold uppercase tracking-wide ${
                          resolvedTheme === "light"
                            ? "text-slate-500"
                            : "text-slate-400"
                        }`}
                      >
                        {t("tablesDashboard.openDue", "Open due")}
                      </div>
                      <div className="mt-1 text-xl font-black text-amber-600 dark:text-amber-300">
                        {formatCurrency(tableGridStats.due)}
                      </div>
                    </div>
                    <div
                      className={`rounded-xl border px-4 py-3 backdrop-blur-xl ${
                        resolvedTheme === "light"
                          ? "border-amber-100/80 bg-[#fffdf8]"
                          : "border-white/10 bg-white/[0.055]"
                      }`}
                    >
                      <div
                        className={`text-[11px] font-bold uppercase tracking-wide ${
                          resolvedTheme === "light"
                            ? "text-slate-500"
                            : "text-slate-400"
                        }`}
                      >
                        {t("tablesDashboard.rate", "Rate")}
                      </div>
                      <div
                        className={`mt-1 text-xl font-black ${
                          tableGridStats.occupancyRate > 80
                            ? "text-red-500"
                            : tableGridStats.occupancyRate > 50
                              ? "text-amber-500"
                              : "text-emerald-500"
                        }`}
                      >
                        {tableGridStats.occupancyRate}%
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div
                      className={`inline-flex rounded-xl border p-1 ${
                        resolvedTheme === "light"
                          ? "border-amber-100/80 bg-[#fffdf8]"
                          : "border-white/10 bg-white/[0.06]"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setTableViewMode("list")}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
                          tableViewMode === "list"
                            ? "bg-yellow-400 text-black"
                            : resolvedTheme === "light"
                              ? "text-slate-700 active:bg-[#fffaf1]"
                              : "text-slate-200 active:bg-white/[0.08]"
                        }`}
                      >
                        <LayoutGrid className="h-4 w-4" />
                        {t("tablesDashboard.viewMode.list", "List")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTableViewMode("floorplan")}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
                          tableViewMode === "floorplan"
                            ? "bg-yellow-400 text-black"
                            : resolvedTheme === "light"
                              ? "text-slate-700 active:bg-[#fffaf1]"
                              : "text-slate-200 active:bg-white/[0.08]"
                        }`}
                      >
                        <MapIcon className="h-4 w-4" />
                        {t("tablesDashboard.viewMode.floorPlan", "2D")}
                      </button>
                    </div>
                    {(
                      [
                        "all",
                        "available",
                        "occupied",
                        "reserved",
                        "cleaning",
                      ] as const
                    ).map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => setTableStatusFilter(status)}
                        className={`rounded-xl px-3 py-2 text-sm font-bold transition-all active:scale-95 ${
                          tableStatusFilter === status
                            ? "bg-yellow-400 text-black shadow-lg shadow-yellow-500/20"
                            : resolvedTheme === "light"
                              ? "bg-[#fffdf8] text-slate-700 ring-1 ring-amber-100/80 active:bg-[#fff7e8]"
                              : "bg-white/[0.06] text-slate-200 active:bg-white/[0.1]"
                        }`}
                      >
                        {status === "all"
                          ? t("tablesDashboard.all", "All")
                          : tableStatusConfig[status].label}
                        {status !== "all" ? (
                          <span className="ml-1 opacity-70">
                            {status === "available"
                              ? tableGridStats.available
                              : status === "occupied"
                                ? tableGridStats.occupied
                                : status === "reserved"
                                  ? tableGridStats.reserved
                                  : tableGridStats.cleaning}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>

                <div
                  className={`flex items-center gap-2 overflow-x-auto rounded-xl border p-1 backdrop-blur-xl scrollbar-hide ${
                    resolvedTheme === "light"
                      ? "border-amber-100/80 bg-[#fffdf8]"
                      : "border-white/10 bg-white/[0.055]"
                  }`}
                >
                  <span
                    className={`ml-2 mr-1 inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-bold tracking-wide ${
                      resolvedTheme === "light"
                        ? "text-slate-500"
                        : "text-slate-400"
                    }`}
                  >
                    <Layers className="h-3.5 w-3.5" />
                    {t("tablesDashboard.floor", "Floor")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTableFloorFilter("all")}
                    className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
                      effectiveTableFloorFilter === "all"
                        ? "bg-yellow-400 text-black"
                        : resolvedTheme === "light"
                          ? "text-slate-700 active:bg-[#fffaf1]"
                          : "text-slate-200 active:bg-white/[0.08]"
                    }`}
                  >
                    {getTableFloorLabel("all")}
                  </button>
                  {tableFloorOptions.map((floor) => (
                    <button
                      key={floor}
                      type="button"
                      onClick={() => setTableFloorFilter(floor)}
                      className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
                        effectiveTableFloorFilter === floor
                          ? "bg-yellow-400 text-black"
                          : resolvedTheme === "light"
                            ? "text-slate-700 active:bg-[#fffaf1]"
                            : "text-slate-200 active:bg-white/[0.08]"
                      }`}
                    >
                      {getTableFloorLabel(floor)}
                    </button>
                  ))}
                </div>
                </div>

                <div
                  data-testid="order-dashboard-table-grid-container"
                  className="min-h-0 flex-1 overflow-hidden"
                >
                  <div
                    ref={tableGridScrollRef}
                    data-testid="order-dashboard-table-scroll-region"
                    className="h-full min-h-0 overflow-y-auto overflow-x-hidden pb-28 pr-24 scrollbar-hide touch-scroll"
                  >
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
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 pb-3">
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
                      const isReservedTable =
                        !hasOpenCheck && displayStatus === "reserved";
                      // Cleaning/maintenance/unavailable tables are not ready for guests and must
                      // not offer guest order actions, even with no open check after payment.
                      const needsAttention =
                        !hasOpenCheck &&
                        (displayStatus === "cleaning" ||
                          displayStatus === "maintenance" ||
                          displayStatus === "unavailable");
                      const attentionActionLabel =
                        displayStatus === "cleaning"
                          ? t("tablesDashboard.markCleaned", "Mark cleaned")
                          : t("tablesDashboard.backInService", "Back in service");
                      const attentionStatusLabel =
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
                        <article
                          key={table.id}
                          className={`min-h-[180px] rounded-2xl border p-3 backdrop-blur-xl transition-all duration-200 ${visual.card}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div
                                className={`inline-flex items-center gap-1.5 text-xs font-bold tracking-wide ${
                                  resolvedTheme === "light"
                                    ? "text-slate-500"
                                    : "text-slate-400"
                                }`}
                              >
                                <Layers className="h-3.5 w-3.5" />
                                {getTableFloorLabel(getTableFloorValue(table))}
                              </div>
                              <div
                                className={`mt-1 truncate text-2xl font-black ${
                                  resolvedTheme === "light"
                                    ? "text-slate-950"
                                    : "text-white"
                                }`}
                              >
                                {formatTableDisplayNumber(table.tableNumber)}
                              </div>
                            </div>
                            <span
                              className={`shrink-0 rounded-xl border px-2.5 py-1 text-xs font-black ${visual.badge}`}
                            >
                              {visual.label}
                            </span>
                          </div>

                          {/* Compact one-line info strip (round 214 v3): the boxed Covers/Waiter tiles
                              were too tall and let the Greek waiter value wrap; this is a single row of
                              two chips (covers count + waiter), the waiter chip taking the remaining
                              width so a value like "Χωρίς ανάθεση" reads on one line without wrapping. */}
                          <div
                            className={`mt-2 flex items-center gap-1.5 text-xs ${
                              resolvedTheme === "light"
                                ? "text-slate-500"
                                : "text-slate-400"
                            }`}
                          >
                            <span
                              className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 font-bold ${
                                resolvedTheme === "light"
                                  ? "border-amber-100/80 bg-[#fffdf8]/80 text-slate-700"
                                  : "border-white/10 bg-black/20 text-slate-200"
                              }`}
                            >
                              <Users className="h-3.5 w-3.5 shrink-0" />
                              {guestCount}/{table.capacity}
                            </span>
                            <span
                              className={`inline-flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1 font-semibold ${
                                resolvedTheme === "light"
                                  ? "border-amber-100/80 bg-[#fffdf8]/80"
                                  : "border-white/10 bg-black/20"
                              } ${
                                table.currentWaiterName
                                  ? resolvedTheme === "light"
                                    ? "text-slate-900"
                                    : "text-white"
                                  : "text-slate-400"
                              }`}
                            >
                              <UserCheck className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{waiterName}</span>
                            </span>
                          </div>

                          {hasOpenCheck ? (
                            <div className="mt-4">
                              <div className="flex items-end justify-between gap-3">
                                <div>
                                  <div
                                    className={`text-[11px] font-black uppercase tracking-wide ${
                                      resolvedTheme === "light"
                                        ? "text-slate-500"
                                        : "text-slate-400"
                                    }`}
                                  >
                                    {t("tablesDashboard.due", "Due")}
                                  </div>
                                  <div
                                    className={`text-3xl font-black ${
                                      balance.due > 0
                                        ? "text-amber-600 dark:text-amber-300"
                                        : "text-emerald-600 dark:text-emerald-300"
                                    }`}
                                  >
                                    {formatCurrency(balance.due)}
                                  </div>
                                </div>
                                <div
                                  className={`text-right text-xs font-semibold ${
                                    resolvedTheme === "light"
                                      ? "text-slate-500"
                                      : "text-slate-400"
                                  }`}
                                >
                                  <div>
                                    {t("tablesDashboard.total", "Total")}{" "}
                                    {formatCurrency(balance.total)}
                                  </div>
                                  <div className="text-emerald-600 dark:text-emerald-300">
                                    {t("tablesDashboard.paid", "Paid")}{" "}
                                    {formatCurrency(balance.paid)}
                                  </div>
                                </div>
                              </div>
                              <div
                                className={`mt-3 h-2 overflow-hidden rounded-full ${
                                  resolvedTheme === "light"
                                    ? "bg-[#fffdf8]/80"
                                    : "bg-black/30"
                                }`}
                              >
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${visual.accent}`}
                                  style={{ width: `${paidPercent}%` }}
                                />
                              </div>
                            </div>
                          ) : null}
                          {/* The duplicate lower status line (Ready for guests / Needs cleaning) was
                              removed: the top status badge already carries Available/Cleaning/Out-of-
                              service, and the attention action button below conveys the cleaning CTA. */}

                          {occupiedSinceLabel || table.currentOrderId ? (
                            <div
                              className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${
                                resolvedTheme === "light"
                                  ? "text-slate-500"
                                  : "text-slate-400"
                              }`}
                            >
                              {occupiedSinceLabel ? (
                                <span className="inline-flex items-center gap-1 rounded-lg border border-zinc-400/20 bg-zinc-500/10 px-2 py-1 font-bold text-zinc-700 dark:text-zinc-200">
                                  <Clock3 className="h-3.5 w-3.5" />
                                  {occupiedSinceLabel}
                                </span>
                              ) : null}
                              {table.currentOrderId ? (
                                <span
                                  className={`inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1 font-semibold ${
                                    resolvedTheme === "light"
                                      ? "border-amber-100/80 bg-[#fffdf8]/70"
                                      : "border-white/10 bg-white/[0.04]"
                                  }`}
                                >
                                  <ReceiptText className="h-3.5 w-3.5 shrink-0" />
                                  <span className="truncate">
                                    {String(table.currentOrderId).slice(0, 10)}
                                  </span>
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {needsAttention ? (
                            <div className="mt-3 space-y-2">
                              <div
                                className={`inline-flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black ${
                                  resolvedTheme === "light"
                                    ? "border-amber-200 bg-amber-50/80 text-amber-800"
                                    : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                                }`}
                              >
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                {attentionStatusLabel}
                              </div>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleTableSelect(table);
                                }}
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3 py-2 text-sm font-black text-white transition-all active:scale-95 active:bg-amber-500"
                              >
                                <AlertTriangle className="h-4 w-4" />
                                {attentionActionLabel}
                              </button>
                            </div>
                          ) : (
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleTableSelect(table);
                                }}
                                className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-black transition-all active:scale-95 ${
                                  hasOpenCheck
                                    ? "bg-yellow-400 text-black active:bg-yellow-500"
                                    : "bg-emerald-600 text-white active:bg-emerald-500"
                                }`}
                              >
                                {hasOpenCheck ? (
                                  <WalletCards className="h-4 w-4" />
                                ) : (
                                  <Plus className="h-4 w-4" />
                                )}
                                {hasOpenCheck
                                  ? t("tablesDashboard.openCheck", "Open check")
                                  : t("tablesDashboard.newOrder", "New order")}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  // Open check -> Pay, reserved -> manage existing
                                  // reservation (both via TableActionModal); available
                                  // -> start a new reservation directly.
                                  if (hasOpenCheck || isReservedTable) {
                                    handleTableSelect(table);
                                  } else {
                                    handleTableReserve(table);
                                  }
                                }}
                                className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-black transition-all active:scale-95 ${
                                  resolvedTheme === "light"
                                    ? "border-amber-100/80 bg-[#fffdf8]/80 text-slate-700 active:bg-[#fffaf1]"
                                    : "border-white/10 bg-white/[0.06] text-slate-200 active:bg-white/[0.1]"
                                }`}
                              >
                                {hasOpenCheck ? (
                                  <Banknote className="h-4 w-4" />
                                ) : isReservedTable ? (
                                  <Pencil className="h-4 w-4" />
                                ) : (
                                  <CalendarPlus className="h-4 w-4" />
                                )}
                                {hasOpenCheck
                                  ? t("tablesDashboard.pay", "Pay")
                                  : isReservedTable
                                    ? t("tableActionModal.editReservation", {
                                        defaultValue: "Edit Reservation",
                                      })
                                    : t("tableActionModal.newReservation", {
                                        defaultValue: "New Reservation",
                                      })}
                              </button>
                            </div>
                          )}
                        </article>
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
            <RoomsView embedded />
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
            <AppointmentsView
              embedded
              openCreateSignal={servicesOpenCreateSignal}
            />
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

        {/* Floating Action Button for New Order */}
        <FloatingActionButton
          onClick={handleNewOrderClick}
          disabled={!isShiftActive}
          movable
          positionStorageKey="pos-orders-new-order-fab-position"
          className={`${
            !isShiftActive
              ? "cursor-not-allowed opacity-80"
              : resolvedTheme === "dark"
                ? "shadow-yellow-500/30"
                : ""
          }`}
          aria-label={
            !isShiftActive
              ? t(
                  "orders.startShiftFirst",
                  "Start a shift first to create orders",
                )
              : t("orders.newOrder")
          }
        />

        {/* Order Type Selection Modal - Glassmorphism style */}
        <LiquidGlassModal
          isOpen={showOrderTypeModal}
          onClose={() => setShowOrderTypeModal(false)}
          title={t("orderFlow.selectOrderType") || "Select Order Type"}
          className={`${orderTypeModalWidthClass} order-type-transparent-modal`}
          contentClassName="!p-0 !overflow-visible"
        >
          <div className="p-2">
            {isOrderTypeTransitioning ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
                <span className="ml-3 text-white/70">
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

                {/* Pickup Button - Green (always available) */}
                <button
                  type="button"
                  data-order-type-card="pickup"
                  onClick={() => handleOrderTypeSelect("pickup")}
                  aria-label={composeOrderTypeAriaLabel(pickupTitle, pickupDescription)}
                  className={`relative p-6 rounded-2xl border-2 border-[#34d399]/45 bg-[linear-gradient(135deg,rgba(52,211,153,0.16),rgba(22,163,74,0.06))] transition-transform duration-150 active:scale-95 ${orderTypeCardSpanClass(pickupCardVisibleIndex)}`}
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
                      const guest = room.activeFolio?.guestName || room.currentGuestName;
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
          isOpen={showMenuModal}
          onClose={handleMenuModalClose}
          selectedCustomer={getCustomerForMenu()}
          selectedAddress={getSelectedAddress()}
          orderType={selectedOrderType || "pickup"}
          deliveryZoneInfo={deliveryZoneInfo}
          onOrderComplete={handleOrderComplete}
          roomChargeContext={roomChargeContext}
        />

        {/* Split Payment Modal — rendered at OrderDashboard level so it
          survives MenuModal closing after order creation */}
        {splitPaymentData && (
          <SplitPaymentModal
            isOpen={true}
            onClose={handleSplitPaymentClose}
            orderId={splitPaymentData.orderId}
            orderTotal={splitPaymentData.orderTotal}
            existingPayments={splitPaymentData.existingPayments}
            items={splitPaymentData.items}
            initialMode={splitPaymentData.initialMode || "by-items"}
            isGhostOrder={splitPaymentData.isGhostOrder}
            collectionMode={splitPaymentData.collectionMode}
            allowDiscounts={splitPaymentData.kind !== "edit-settlement"}
            onSplitComplete={handleSplitComplete}
          />
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
                if (result?.success) {
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
            order={selectedOrderForApproval}
            onApprove={handleApproveOrder}
            onDecline={handleDeclineOrder}
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
          canEditPayment={canEditPaymentMethod}
          paymentEditHint={paymentEditIneligibilityReason}
          onClose={handleEditOptionsClose}
        />

        <EditPaymentMethodModal
          isOpen={showEditPaymentModal}
          orderNumber={editPaymentTarget?.orderNumber}
          currentMethod={editPaymentTarget?.currentMethod || "cash"}
          isSaving={isUpdatingPaymentMethod}
          onSave={handlePaymentMethodSave}
          onClose={handleEditPaymentClose}
        />

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
          onClose={handleEditMenuClose}
          orderType={editingOrderType}
          editMode={true}
          editOrderId={currentEditOrderId}
          editSupabaseId={currentEditSupabaseId}
          editOrderNumber={currentEditOrderNumber}
          initialCartItems={[]}
          onEditComplete={handleEditMenuComplete}
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

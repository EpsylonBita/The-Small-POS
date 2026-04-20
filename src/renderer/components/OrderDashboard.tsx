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
import { SplitPaymentModal } from "./modals/SplitPaymentModal";
import {
  SinglePaymentCollectionModal,
  type SinglePaymentCollectionResult,
} from "./modals/SinglePaymentCollectionModal";
import OrderDetailsModal from "./modals/OrderDetailsModal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import type {
  SplitPaymentCollectionMode,
  SplitPaymentResult,
} from "./modals/SplitPaymentModal";
import { OrderApprovalPanel } from "./order/OrderApprovalPanel";
import { OrderConflictBanner } from "./OrderConflictBanner";
import { LiquidGlassModal } from "./ui/pos-glass-components";
import { TableSelector, TableActionModal, ReservationForm } from "./tables";
import type { CreateReservationDto } from "./tables";
import { toLocalDateString } from "../utils/date";
import { reservationsService } from "../services/ReservationsService";
import { PrintPreviewModal } from "./modals/PrintPreviewModal";
import { FloatingActionButton } from "./ui/FloatingActionButton";
import { useTheme } from "../contexts/theme-context";
import { useI18n } from "../contexts/i18n-context";
import { useAcquiredModules } from "../hooks/useAcquiredModules";
import { useTables } from "../hooks/useTables";
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
import { openExternalUrl } from "../utils/electron-api";
import { getVisibleOrderNumber } from "../utils/orderNumberUtils";
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

interface PendingPickupConversion {
  isOpen: boolean;
  orders: Array<Pick<Order, "id" | "orderNumber" | "status">>;
  outForDeliveryCount: number;
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
}

type StatusTransitionTarget = Extract<Order["status"], "completed" | "delivered">;

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

export const OrderDashboard = memo<OrderDashboardProps>(
  ({ className = "", orderFilter }) => {
    const bridge = getBridge();
    const { t } = useI18n();
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
      convertToPickup,
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
    const { hasDeliveryModule, hasTablesModule } = useAcquiredModules();

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
    const { tables } = useTables({
      branchId: effectiveBranchId || "",
      organizationId: organizationId || "",
      enabled: Boolean(effectiveBranchId && organizationId),
    });

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

    // State for table order flow
    const [showTableSelector, setShowTableSelector] = useState(false);
    const [showTableActionModal, setShowTableActionModal] = useState(false);
    const [showReservationForm, setShowReservationForm] = useState(false);
    const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(
      null,
    );
    const [isOrderTypeTransitioning, setIsOrderTypeTransitioning] =
      useState(false);

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
    const [selectedOrderType, setSelectedOrderType] = useState<
      "pickup" | "delivery" | null
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

    // State for delivery flow
    const [showPhoneLookupModal, setShowPhoneLookupModal] = useState(false);
    const [showCustomerInfoModal, setShowCustomerInfoModal] = useState(false);
    const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
    const [customerModalMode, setCustomerModalMode] = useState<
      "new" | "edit" | "addAddress"
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
    const [pendingPickupConversion, setPendingPickupConversion] =
      useState<PendingPickupConversion>({
        isOpen: false,
        orders: [],
        outForDeliveryCount: 0,
      });
    const [pickupToDeliveryContext, setPickupToDeliveryContext] =
      useState<PickupToDeliveryContext | null>(null);

    // Bulk action loading state
    const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);

    // Refs for click-outside detection to auto-close bulk actions bar
    const bulkActionsBarRef = useRef<HTMLDivElement>(null);
    const orderGridRef = useRef<HTMLDivElement>(null);
    const alertTimeoutRef = useRef<number | null>(null);
    const alertingOrderIdRef = useRef<string | null>(null);
    const shiftRefreshArmedRef = useRef(false);
    const splitPaymentCompletedRef = useRef(false);
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
        resetPickupToDeliveryFlow();
        return;
      }
      setShowPhoneLookupModal(false);
    }, [pickupToDeliveryContext, resetPickupToDeliveryFlow]);

    const closeAddCustomerModal = useCallback(() => {
      if (pickupToDeliveryContext) {
        resetPickupToDeliveryFlow();
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
    const playExternalOrderAlert = useCallback(() => {
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
          alertTimeoutRef.current = window.setTimeout(tick, 2500);
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

    // Update computed values when dependencies change
    useEffect(() => {
      if (!orders) return;

      const baseOrders = orderFilter ? orders.filter(orderFilter) : orders;

      // Filter orders based on active tab and global filters
      let filtered = baseOrders;

      // Apply global filters first
      if (filter.status && filter.status !== "all") {
        filtered = filtered.filter((order) => order.status === filter.status);
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
          filtered = filtered.filter(
            (order) =>
              order.status === "pending" ||
              order.status === "confirmed" ||
              order.status === "preparing" ||
              order.status === "ready",
          );
          break;
        case "delivered":
          filtered = filtered.filter(
            (order) =>
              order.status === "delivered" || order.status === "completed",
          );
          break;
        case "canceled":
          filtered = filtered.filter((order) => order.status === "cancelled");
          break;
      }

      setFilteredOrders(filtered);

      // Calculate order counts for tabs
      const counts = {
        orders: 0,
        delivered: 0,
        canceled: 0,
        tables: 0, // Will be updated separately from tables data
      };

      baseOrders.forEach((order) => {
        switch (order.status) {
          case "pending":
          case "confirmed":
          case "preparing":
          case "ready":
            counts.orders++;
            break;
          case "delivered":
          case "completed":
            counts.delivered++;
            break;
          default:
            break;
          case "cancelled":
            counts.canceled++;
            break;
        }
      });

      setOrderCounts(counts);
    }, [orders, filter, activeTab, orderFilter]);

    // Handle tab change
    const handleTabChange = useCallback(
      (tab: TabId) => {
        setActiveTab(tab);
        clearBulkSelection();
        // Ensure global status filter doesn't hide tab contents
        try {
          setFilter({ status: "all" });
        } catch {}
      },
      [clearBulkSelection, setFilter],
    );

    // Update tables count when tables data changes
    useEffect(() => {
      if (tables) {
        setOrderCounts((prev) => ({
          ...prev,
          tables: tables.length,
        }));
      }
    }, [tables]);

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

    // Handle table selection from TableSelector
    const handleTableSelectorSelect = useCallback((table: RestaurantTable) => {
      setSelectedTable(table);
      setShowTableSelector(false);
      setShowTableActionModal(true);
    }, []);

    // Handle New Order action from TableActionModal
    const handleTableNewOrder = useCallback(() => {
      if (selectedTable) {
        setSelectedOrderType("pickup"); // Table orders use pickup pricing
        setOrderType("dine-in");
        setTableNumber(selectedTable.tableNumber.toString());
        setCustomerInfo({
          name:
            t("orderFlow.tableCustomer", {
              table: selectedTable.tableNumber,
            }) || `Table ${selectedTable.tableNumber}`,
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
        setShowTableActionModal(false);
        setShowReservationForm(true);
      }
    }, [selectedTable]);

    // Handle reservation form submission
    const handleReservationSubmit = useCallback(
      async (data: CreateReservationDto) => {
        if (!branchId || !organizationId) {
          toast.error(
            t("orderDashboard.missingContext") ||
              "Missing branch or organization context",
          );
          return;
        }

        try {
          // Set context for the service with actual IDs
          reservationsService.setContext(branchId, organizationId);

          // Format date and time from the Date object
          const reservationDate = toLocalDateString(data.reservationTime);
          const reservationTime = data.reservationTime
            .toTimeString()
            .slice(0, 5);

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
        } catch (error) {
          console.error("Failed to create reservation:", error);
          toast.error(
            t("orderDashboard.reservationFailed") ||
              "Failed to create reservation",
          );
        }
      },
      [t, branchId, organizationId],
    );

    // Handle reservation form cancel
    const handleReservationCancel = useCallback(() => {
      setShowReservationForm(false);
      setSelectedTable(null);
    }, []);

    // Handle table selection from Tables tab grid
    const handleTableSelect = useCallback((table: RestaurantTable) => {
      setSelectedTable(table);
      setShowTableActionModal(true);
    }, []);

    // Handle menu modal close
    const handleMenuModalClose = () => {
      setShowMenuModal(false);
      setSelectedOrderType(null);
      setPickupToDeliveryContext(null);
      // Reset all state
      setPhoneNumber("");
      setCustomerInfo(null);
      setExistingCustomer(null);
      setSpecialInstructions("");
      setTableNumber("");
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
            deliveryCity: resolvedAddress.city || undefined,
            deliveryPostalCode: resolvedAddress.postalCode || undefined,
            deliveryFloor: resolvedAddress.floor || undefined,
            deliveryNotes: resolvedAddress.notes || undefined,
            nameOnRinger: resolvedAddress.nameOnRinger || undefined,
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
          resetPickupToDeliveryFlow();

          try {
            await silentRefresh();
          } catch (refreshError) {
            console.debug(
              "[OrderDashboard] Silent refresh after pickup-to-delivery failed:",
              refreshError,
            );
            await loadOrders();
          }

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
      setCustomerModalMode("edit");
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
    ) => {
      if (isGhostOrder) {
        const printResult: any = await bridge.payments.printReceipt(orderId);
        console.log(
          "[OrderDashboard] Ghost receipt print result:",
          printResult,
        );
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

    // Handle order completion from menu modal
    const handleOrderComplete = async (orderData: any): Promise<void> => {
      const isSplitPayment = orderData.paymentData?.method === "pending";
      let createdOrderId: string | undefined;
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
            return; // Prevent order creation without address
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
        const totalDiscountAmount = Math.max(
          0,
          Number(
            orderData.total_discount_amount ??
              manualDiscountAmount + couponDiscountAmount,
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
        const initialPayment =
          !isGhostOrder &&
          !isSplitPayment &&
          (orderData.paymentData?.method === "cash" ||
            orderData.paymentData?.method === "card")
            ? {
                method: orderData.paymentData.method,
                amount: total,
                cashReceived:
                  orderData.paymentData.method === "cash"
                    ? orderData.paymentData?.cashReceived
                    : undefined,
                changeGiven:
                  orderData.paymentData.method === "cash"
                    ? orderData.paymentData?.change
                    : undefined,
                transactionRef: orderData.paymentData?.transactionId,
              }
            : undefined;
        const isTableOrder =
          orderType === "dine-in" || Boolean(tableNumber?.trim());
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
          order_type: selectedOrderType || "pickup",
          payment_method: isGhostOrder
            ? null
            : orderData.paymentData?.method || "cash",
          initialPayment,
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

        const result = await createOrder(orderToCreate);

        if (result.success) {
          createdOrderId = result.orderId;

          // Capture split payment data for the SplitPaymentModal (rendered in OrderDashboard).
          // This must happen before the finally block closes MenuModal.
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

          toast.success(t("orderDashboard.orderCreated"));
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

          if (result.orderId && !isSplitPayment) {
            if (initialPayment) {
              await silentRefresh().catch((err) => {
                console.debug(
                  "[OrderDashboard] Silent refresh after inline payment create failed:",
                  err,
                );
              });
            }
            finalizeCreatedOrderPayment(result.orderId, isGhostOrder).catch(
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
                  return;
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
            if (loyaltyCustomerId && !isGhostOrder) {
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
          } else {
            console.warn(
              "[OrderDashboard] No orderId in result, skipping auto-print",
            );
          }
        } else {
          toast.error(result.error || t("orderDashboard.orderCreateFailed"));
        }
      } catch (error) {
        console.error("Error creating order:", error);
        toast.error(t("orderDashboard.orderCreateFailed"));
      } finally {
        setShowMenuModal(false);
        setSelectedOrderType(null);
        setExistingCustomer(null);
        setCustomerInfo({ name: "", phone: "" });
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

        const itemsSubtotal = Number(
          nextItems
            .reduce((sum, item) => {
              const quantity = Number(item.quantity || 0);
              const explicitTotal =
                (item as any).total_price ??
                (item as any).totalPrice ??
                null;
              if (typeof explicitTotal === "number") {
                return sum + explicitTotal;
              }
              return sum + Number(item.unit_price ?? item.price ?? 0) * quantity;
            }, 0)
            .toFixed(2),
        );
        const discountAmount = Number(
          Number((order as any).discount_amount ?? (order as any).discountAmount ?? 0).toFixed(2),
        );
        const discountPercentage = Number(
          (order as any).discount_percentage ?? (order as any).discountPercentage ?? 0,
        );
        const tipAmount = Number((order as any).tip_amount ?? (order as any).tipAmount ?? 0);
        const taxRate = Number((order as any).tax_rate ?? 24);
        const deliveryFee =
          targetOrderType === "delivery"
            ? Number((order as any).delivery_fee ?? order.deliveryFee ?? 0)
            : 0;
        const taxableSubtotal = Math.max(0, itemsSubtotal - discountAmount);
        const taxAmount = Number((taxableSubtotal * (taxRate / 100)).toFixed(2));
        const totalAmount = Number(
          (taxableSubtotal + taxAmount + deliveryFee + tipAmount).toFixed(2),
        );

        const orderUpdates: Partial<EditSettlementOrderUpdates> = {
          orderType: targetOrderType,
        };

        if (targetOrderType === "delivery") {
          orderUpdates.tableNumber = null;
          orderUpdates.waiterId = null;
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
          financials: {
            totalAmount,
            subtotal: taxableSubtotal,
            taxAmount,
            deliveryFee,
            discountAmount,
            discountPercentage,
            tipAmount,
          },
          orderUpdates,
        };
      },
      [],
    );

    const openEditSettlementCollectionPrompt = useCallback(
      (preview: OrderEditSettlementPreview, request: EditSettlementRequest) => {
        const collectionMode: SplitPaymentCollectionMode | undefined = preview
          .deliverySettlement?.driverCashOwned
          ? {
              enabled: true,
              allowDriverShift: true,
              defaultCollectedBy: "driver_shift",
              label: t("splitPayment.collectedBy", {
                defaultValue: "Collected By",
              }),
              description: t("orderDashboard.deliveryDriverSettlement", {
                defaultValue:
                  "Choose whether the extra amount was settled by the driver or by the cashier.",
              }),
            }
          : undefined;

        setSplitPaymentData({
          kind: "edit-settlement",
          orderId: preview.orderId,
          orderTotal: preview.nextTotal,
          existingPayments: preview.completedPayments,
          items: buildSplitPaymentItems({
            items: request.items.map((item: any, index: number) => ({
              name: item.name || "Item",
              quantity: Number(item.quantity || 1),
              price: Number(
                item.unit_price ?? item.unitPrice ?? item.price ?? 0,
              ),
              totalPrice: Number(
                item.total_price ??
                  item.totalPrice ??
                  (item.unit_price ?? item.unitPrice ?? item.price ?? 0) *
                    (item.quantity || 1),
              ),
              itemIndex: Number(item.itemIndex ?? index),
            })),
            orderTotal: preview.nextTotal,
            adjustmentLabel: t("splitPayment.adjustment", {
              defaultValue: "Adjustment",
            }),
          }),
          isGhostOrder: preview.isGhostOrder,
          initialMode: "by-amount",
          collectionMode,
        });
      },
      [t],
    );

    const applySettlementAwareOrderEdit = useCallback(
      async (requests: EditSettlementRequest[]): Promise<void> => {
        const normalizedRequests = requests.map((request) => ({
          ...request,
          items: normalizeEditOrderItems(request.items),
        }));

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
          await bridge.orders.applyEditSettlement({
            orderId: request.orderId,
            items: request.items,
            orderNotes: request.orderNotes,
            financials: request.financials,
            orderUpdates: request.orderUpdates,
            action: { type: "mark_partial" },
          });
          const refreshedPreview = await bridge.orders.previewEditSettlement({
            orderId: request.orderId,
            items: request.items,
            orderNotes: request.orderNotes,
            financials: request.financials,
            orderUpdates: request.orderUpdates,
          });
          resetEditOrderState();
          clearBulkSelection();
          setPendingEditRefundSettlement(null);
          if (refreshedPreview?.requiredAction === "refund") {
            setPendingEditRefundSettlement({
              preview: refreshedPreview,
              request,
            });
            return;
          }

          if (refreshedPreview?.requiredAction === "collect") {
            openEditSettlementCollectionPrompt(refreshedPreview, request);
            toast.success(
              t("orderDashboard.orderEditAwaitingPayment", {
                defaultValue:
                  "Order changes saved. Collect the remaining balance to finish settlement.",
              }),
            );
            await silentRefresh().catch(() => {});
            return;
          }

          toast.success(
            t("orderDashboard.orderItemsUpdated", {
              count: 1,
            }),
          );
          await loadOrders();
          return;
        }

        if (
          normalizedRequests.length === 1 &&
          previews[0]?.requiredAction === "refund"
        ) {
          resetEditOrderState();
          clearBulkSelection();
          setPendingEditRefundSettlement({
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
        if (!blocker) {
          toast.error(
            payload.error ||
              payload.message ||
              t("orderDashboard.collectPaymentFailed", {
                defaultValue: "Payment collection is required before continuing.",
              }),
          );
          return false;
        }

        if (
          blocker.reasonCode === "split_payment_incomplete" ||
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
            orderNumber: getVisibleOrderNumber(order),
            targetStatus,
            method: resolvedMethod,
            blocker,
          });
          return true;
        }

        toast.error(
          payload.error ||
            payload.message ||
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

    const closePickupConversionConfirm = useCallback(() => {
      setPendingPickupConversion({
        isOpen: false,
        orders: [],
        outForDeliveryCount: 0,
      });
    }, []);

    const confirmPickupConversion = useCallback(async () => {
      const ordersToConvert = pendingPickupConversion.orders;
      closePickupConversionConfirm();

      if (ordersToConvert.length === 0) {
        return;
      }

      setIsBulkActionLoading(true);
      try {
        let successCount = 0;
        for (const ord of ordersToConvert) {
          const ok = await convertToPickup(ord.id);
          if (ok) {
            successCount++;
            continue;
          }

          toast.error(
            t("orderDashboard.convertToPickupFailed", {
              orderNumber: ord.orderNumber,
            }) || `Failed to convert ${ord.orderNumber}`,
          );
          return;
        }

        if (successCount > 0) {
          toast.success(
            t("orderDashboard.convertedToPickup", { count: successCount }) ||
              `Converted ${successCount} order(s) to pickup`,
          );
        }

        setSelectionType("pickup");
      } finally {
        setIsBulkActionLoading(false);
      }
    }, [
      closePickupConversionConfirm,
      convertToPickup,
      pendingPickupConversion.orders,
      t,
    ]);

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

      if (action === "pickup") {
        if (deliveryOrders.length === 0) {
          toast.error(
            t("orderDashboard.noDeliveryOrdersSelected") ||
              "Select delivery orders to convert to pickup",
          );
          return;
        }

        setPendingPickupConversion({
          isOpen: true,
          orders: deliveryOrders.map((order) => ({
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
          })),
          outForDeliveryCount: deliveryOrdersInTransit.length,
        });
        return;
      }

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
                if (
                  result.paymentIntegrityPayload &&
                  handlePaymentIntegrityBlocker(
                    order,
                    "completed",
                    result.paymentIntegrityPayload,
                  )
                ) {
                  return;
                }
                toast.error(
                  result.errorMessage ||
                    t("orderDashboard.markDeliveredFailed", {
                      orderNumber: order.orderNumber,
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
                if (
                  result.paymentIntegrityPayload &&
                  handlePaymentIntegrityBlocker(
                    order,
                    "delivered",
                    result.paymentIntegrityPayload,
                  )
                ) {
                  return;
                }
                toast.error(
                  result.errorMessage ||
                    t("orderDashboard.markDeliveredFailed", {
                      orderNumber: order.orderNumber,
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
        } else if (action === "return") {
          // Reactivate cancelled orders back to active (pending)
          const cancelledOrders = selectedOrderObjects.filter(
            (order) => order.status === "cancelled",
          );

          if (cancelledOrders.length === 0) {
            toast.error(t("orderDashboard.noCancelledOrdersSelected"));
          } else {
            for (const order of cancelledOrders) {
              const success = await updateOrderStatus(order.id, "pending");
              if (!success) {
                toast.error(
                  t("orderDashboard.returnToOrdersFailed", {
                    orderNumber: order.orderNumber,
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
      try {
        // Cancel all pending orders
        for (const orderId of pendingCancelOrders) {
          const success = await updateOrderStatus(orderId, "cancelled");
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
          deliveryNotes: customerInfo.notes?.trim() || null,
        };
        const submitCustomerInfoUpdate = (
          payload: { orderId: string } & typeof updatePayload,
        ) => {
          if (typeof bridge.orders.updateCustomerInfo === "function") {
            return bridge.orders.updateCustomerInfo(payload);
          }
          return bridge.invoke("order:update-customer-info", payload);
        };

        for (const orderId of targetOrderIds) {
          const result = await submitCustomerInfoUpdate({
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
          orderType: orderData.orderType as Order["orderType"],
          order_type: orderData.orderType as Order["order_type"],
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
        return { name: "", phone: "", address: "", notes: "" };

      const targetId = pendingEditOrders[0] || editingSingleOrder;
      const firstOrder = orders.find((order) => order.id === targetId) as any;
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
        notes:
          firstOrder?.deliveryNotes ||
          firstOrder?.delivery_notes ||
          firstOrder?.specialInstructions ||
          firstOrder?.special_instructions ||
          firstOrder?.notes ||
          "",
        coordinates: toLatLngCoordinates(
          firstOrder?.coordinates,
          firstOrder?.latitude,
          firstOrder?.longitude,
        ),
        latitude:
          typeof firstOrder?.latitude === "number" ? firstOrder.latitude : null,
        longitude:
          typeof firstOrder?.longitude === "number"
            ? firstOrder.longitude
            : null,
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
      <div className={`space-y-4 relative ${className}`}>
        {/* Order Conflict Banner */}
        {/* Conflict banner intentionally disabled: remote always wins */}

        {/* Order Tabs - Module dependent */}
        <OrderTabsBar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          orderCounts={orderCounts}
          showDeliveredTab={hasDeliveryModule}
          showTablesTab={hasTablesModule}
        />

        {/* Bulk Actions */}
        <div ref={bulkActionsBarRef}>
          <BulkActionsBar
            selectedCount={selectedOrders.length}
            selectionType={selectionType}
            canConvertPickupToDelivery={Boolean(selectedSinglePickupOrder)}
            deliverySelectionCanBeCompleted={deliverySelectionCanBeCompleted}
            activeTab={activeTab}
            onBulkAction={handleBulkAction}
            onClearSelection={handleClearSelection}
            isLoading={isBulkActionLoading}
          />
        </div>

        {/* Orders Grid or Tables Grid based on active tab */}
        {activeTab === "tables" ? (
          /* Tables Grid - shown when Tables tab is active */
          <div
            ref={orderGridRef}
            className={`rounded-xl p-4 ${
              resolvedTheme === "light"
                ? "bg-white/80 border border-gray-200/50"
                : "bg-white/5 border border-white/10"
            }`}
          >
            {tables.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <svg
                  className={`w-16 h-16 mb-4 ${resolvedTheme === "light" ? "text-gray-300" : "text-white/20"}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.87c1.355 0 2.697.055 4.024.165C17.155 8.51 18 9.473 18 10.608v2.513m-3-4.87v-1.5m-6 1.5v-1.5m12 9.75l-1.5.75a3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0L3 16.5m15-3.38a48.474 48.474 0 00-6-.37c-2.032 0-4.034.125-6 .37m12 0c.39.049.777.102 1.163.16 1.07.16 1.837 1.094 1.837 2.175v5.17c0 .62-.504 1.124-1.125 1.124H4.125A1.125 1.125 0 013 20.625v-5.17c0-1.08.768-2.014 1.837-2.174A47.78 47.78 0 016 13.12"
                  />
                </svg>
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
              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
                {tables.map((table) => {
                  const statusColors: Record<TableStatus, string> = {
                    available:
                      "border-green-500 bg-green-500/10 text-green-500",
                    occupied: "border-blue-500 bg-blue-500/10 text-blue-500",
                    reserved:
                      "border-yellow-500 bg-yellow-500/10 text-yellow-500",
                    cleaning: "border-gray-500 bg-gray-500/10 text-gray-500",
                    maintenance:
                      "border-orange-500 bg-orange-500/10 text-orange-500",
                    unavailable:
                      "border-slate-500 bg-slate-500/10 text-slate-500",
                  };
                  return (
                    <button
                      key={table.id}
                      onClick={() => handleTableSelect(table)}
                      className={`aspect-square p-3 rounded-xl border-2 transition-all hover:scale-105 active:scale-95 ${statusColors[table.status]}`}
                    >
                      <div className="h-full flex flex-col items-center justify-center">
                        <span className="text-2xl font-bold">
                          #{table.tableNumber}
                        </span>
                        <span className="text-xs mt-1 opacity-70">
                          {table.capacity} seats
                        </span>
                        <span className="text-[10px] mt-1 capitalize">
                          {table.status}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* Orders Grid - shown for Orders/Delivered/Canceled tabs */
          <div ref={orderGridRef}>
            <OrderGrid
              orders={filteredOrders}
              selectedOrders={selectedOrders}
              onToggleOrderSelection={handleToggleOrderSelection}
              onOrderDoubleClick={handleOrderDoubleClick}
              activeTab={activeTab as "orders" | "delivered" | "canceled"}
              storeMapOrigin={storeMapOrigin}
            />
          </div>
        )}

        {/* Floating Action Button for New Order */}
        <FloatingActionButton
          onClick={handleNewOrderClick}
          disabled={!isShiftActive}
          className={`!bottom-6 !right-6 ${
            !isShiftActive
              ? "cursor-not-allowed opacity-50"
              : resolvedTheme === "dark"
                ? "shadow-blue-500/30"
                : ""
          }`}
          title={
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
          className="!max-w-lg"
        >
          <div className="p-2">
            {isOrderTypeTransitioning ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
                <span className="ml-3 text-white/70">
                  {t("orderFlow.settingUpOrder") || "Setting up order..."}
                </span>
              </div>
            ) : (
              <div
                className={`grid gap-4 ${hasDeliveryModule && hasTablesModule ? "grid-cols-3" : hasDeliveryModule || hasTablesModule ? "grid-cols-2" : "grid-cols-1"}`}
              >
                {/* Delivery Button - Yellow (only if Delivery module acquired) */}
                {hasDeliveryModule && (
                  <button
                    onClick={() => handleOrderTypeSelect("delivery")}
                    className="group relative p-6 rounded-2xl border-2 border-yellow-400/30 bg-gradient-to-br from-yellow-500/10 to-yellow-600/5 hover:from-yellow-500/20 hover:to-yellow-600/10 hover:border-yellow-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-yellow-500/20"
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <svg
                          className="w-full h-full text-yellow-400 group-hover:text-yellow-300 transition-colors"
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
                        <h3 className="text-lg font-bold text-yellow-400 group-hover:text-yellow-300 transition-colors mb-1">
                          {t("orderFlow.deliveryOrder") || "Delivery Order"}
                        </h3>
                        <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                          {t("orderFlow.deliveryDescription", {
                            defaultValue: "Delivery to customer",
                          })}
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                {/* Pickup Button - Green (always available) */}
                <button
                  onClick={() => handleOrderTypeSelect("pickup")}
                  className="group relative p-6 rounded-2xl border-2 border-green-400/30 bg-gradient-to-br from-green-500/10 to-green-600/5 hover:from-green-500/20 hover:to-green-600/10 hover:border-green-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-green-500/20"
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      <svg
                        className="w-full h-full text-green-400 group-hover:text-green-300 transition-colors"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth="1.5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.75c0 .415.336.75.75.75z"
                        />
                      </svg>
                    </div>
                    <div className="text-center">
                      <h3 className="text-lg font-bold text-green-400 group-hover:text-green-300 transition-colors mb-1">
                        {t("orderFlow.pickupOrder") || "Pickup Order"}
                      </h3>
                      <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        {t("orderFlow.pickupDescription", {
                          defaultValue: "Pickup at store",
                        })}
                      </p>
                    </div>
                  </div>
                </button>

                {/* Table Button - Blue (only if Tables module acquired) */}
                {hasTablesModule && (
                  <button
                    onClick={() => handleOrderTypeSelect("dine-in")}
                    className="group relative p-6 rounded-2xl border-2 border-blue-400/30 bg-gradient-to-br from-blue-500/10 to-blue-600/5 hover:from-blue-500/20 hover:to-blue-600/10 hover:border-blue-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20"
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 flex items-center justify-center">
                        <svg
                          className="w-full h-full text-blue-400 group-hover:text-blue-300 transition-colors"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          strokeWidth="1.5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.87c1.355 0 2.697.055 4.024.165C17.155 8.51 18 9.473 18 10.608v2.513m-3-4.87v-1.5m-6 1.5v-1.5m12 9.75l-1.5.75a3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0L3 16.5m15-3.38a48.474 48.474 0 00-6-.37c-2.032 0-4.034.125-6 .37m12 0c.39.049.777.102 1.163.16 1.07.16 1.837 1.094 1.837 2.175v5.17c0 .62-.504 1.124-1.125 1.124H4.125A1.125 1.125 0 013 20.625v-5.17c0-1.08.768-2.014 1.837-2.174A47.78 47.78 0 016 13.12M12.265 3.11a.375.375 0 11-.53 0L12 2.845l.265.265zm-3 0a.375.375 0 11-.53 0L9 2.845l.265.265zm6 0a.375.375 0 11-.53 0L15 2.845l.265.265z"
                          />
                        </svg>
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-blue-400 group-hover:text-blue-300 transition-colors mb-1">
                          {t("orderFlow.tableOrder") || "Table Order"}
                        </h3>
                        <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                          {t("orderFlow.tableDescription") || "Dine-in order"}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        </LiquidGlassModal>

        {/* Table Selector Modal (for table orders) */}
        <TableSelector
          isOpen={showTableSelector}
          tables={tables}
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
            onClose={() => {
              setShowTableActionModal(false);
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
        <ConfirmDialog
          isOpen={pendingPickupConversion.isOpen}
          onClose={closePickupConversionConfirm}
          onConfirm={() => {
            void confirmPickupConversion();
          }}
          title={
            t("orderDashboard.confirmPickupConversionTitle", {
              defaultValue: "Convert delivery orders to pickup?",
            }) || "Convert delivery orders to pickup?"
          }
          message={
            t("orderDashboard.confirmPickupConversionMessage", {
              count: pendingPickupConversion.orders.length,
              defaultValue:
                "You are converting {{count}} delivery order(s) to pickup. Delivery assignment and driver handling will be removed.",
            }) ||
            `You are converting ${pendingPickupConversion.orders.length} delivery order(s) to pickup. Delivery assignment and driver handling will be removed.`
          }
          confirmText={t("orderDashboard.confirmPickupConversionConfirm", {
            defaultValue: "Convert to pickup",
          })}
          cancelText={t("common.actions.cancel")}
          variant="warning"
          isLoading={isBulkActionLoading}
          details={
            <div className="space-y-2">
              <p>
                {t("orderDashboard.confirmPickupConversionWarning", {
                  defaultValue:
                    "Delivery handling is removed for these orders.",
                })}
              </p>
              {pendingPickupConversion.outForDeliveryCount > 0 && (
                <p>
                  {t("orderDashboard.confirmPickupConversionTransitWarning", {
                    count: pendingPickupConversion.outForDeliveryCount,
                    defaultValue:
                      "{{count}} order(s) are already out for delivery and may return to ready after the conversion.",
                  })}
                </p>
              )}
            </div>
          }
        />

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
      </div>
    );
  },
);

OrderDashboard.displayName = "OrderDashboard";

export default OrderDashboard;

import { resolveAdjustmentAttribution } from '../utils/staffAttribution';
import { memo, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { LiquidGlassModal } from './ui/pos-glass-components';
import { MenuModal } from './modals/MenuModal';
import { EditSettlementDeltaModal } from './modals/EditSettlementDeltaModal';
import { commitMenuOrderEdit, menuEditRefundAction, previewMenuOrderEdit, type MenuOrderEditData, type MenuOrderEditLifecycle } from '../services/MenuOrderEdit';
import type { OrderEditSettlementPreview } from '../../lib/ipc-adapter';
import { resolveEditSettlementRefundAmount } from '../utils/editSettlementFinancials';
import { ProductCatalogModal } from './modals/ProductCatalogModal';
import { CustomerSearchModal } from './modals/CustomerSearchModal';
import { AddCustomerModal } from './modals/AddCustomerModal';
import { SplitPaymentModal } from './modals/SplitPaymentModal';
import type { SplitPaymentResult } from './modals/SplitPaymentModal';
import {
  OutstandingPaymentMethodModal,
  type OutstandingPaymentSelection,
} from './modals/OutstandingPaymentMethodModal';
import type { PaymentModalExistingOrder } from './modals/PaymentModal';
import { ZoneValidationAlert } from './delivery/ZoneValidationAlert';
import { FloatingActionButton } from './ui/FloatingActionButton';
import { TableSelector, TableActionModal, ReservationForm } from './tables';
import type { CreateReservationDto } from './tables';
import {
  reservationsService,
  type Reservation,
} from '../services/ReservationsService';
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
} from '../hooks/useOrderStore';
import { giftCardsApiService, type GiftCardScope } from '../services/GiftCardsApiService';
import type { GiftCardTenderEvent } from '../services/GiftCardCheckoutService';
import { useShift } from '../contexts/shift-context';
import { useOperationalShift } from '../contexts/cashier-gate-context';
import { useI18n } from '../contexts/i18n-context';
import { MODULE_IDS, useAcquiredModules } from '../hooks/useAcquiredModules';
import { useTables } from '../hooks/useTables';
import { useModules } from '../contexts/module-context';
import { useFeatures } from '../hooks/useFeatures';
import toast from 'react-hot-toast';
import { useDeliveryValidation } from '../hooks/useDeliveryValidation';
import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import type { RestaurantTable } from '../types/tables';
import { ActivityTracker } from '../services/ActivityTracker';
import { submitTableReservation } from '../utils/table-reservation-submit';
import { formatTableDisplayNumber } from '../utils/table-display';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { usePaymentPrintPrompt, type PaymentPrintPromptContext } from '../hooks/usePaymentPrintPrompt';
import { AlertTriangle } from 'lucide-react';
import TableOrderIcon from './icons/TableOrderIcon';
import PickupOrderIcon from './icons/PickupOrderIcon';
import { resolveDeliveryFee } from '../utils/delivery-fee';
import { toValidLatLng } from '../utils/coordinates';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials';
import { getBridge, offEvent, onEvent } from '../../lib';
import {
  announceUnsavedCheckoutChanged,
  notifyPaymentNotSaved,
} from '../utils/unsavedPayments';
import {
  notifyMoneySettingsUnavailable,
  resolveCheckoutTaxRate,
} from '../utils/checkoutMoneySettings';
import { PAYMENT_SET_ASIDE_TOAST_MS } from '../utils/paymentSetAside';
import { formatSetAsidePaymentMessage } from '../../lib/payment-integrity';
import { buildSplitPaymentItems } from '../utils/splitPaymentItems';
import type { SplitPaymentItem } from '../utils/splitPaymentItems';
import { resolvePersistedCustomerId } from '../utils/persisted-customer-id';
import { resolveOrderCompletionOutcome } from '../utils/orderCompletionOutcome';
import { getCheckoutDraftStore } from '../services/CheckoutDraftStore';
import { buildOrderServiceTableMetadata, tableHasOpenCheckReference } from '../utils/tableOrderFlow';
import { useCheckoutRequestId } from '../hooks/useCheckoutRequestId';
import { isCheckoutOutcomeUnknown, notifyCheckoutOutcomeUnknown } from '../utils/checkoutOutcome';
import {
  loadPersistedSplitDismissal,
  reconcileOutstandingPaymentAttempt,
  type PersistedSplitDismissalResolution,
} from '../utils/splitCheckoutRecovery';
import { resolveActiveCashierShift } from '../utils/active-cashier';
import { parseSpecialAddressInput } from '../utils/specialAddress';
import {
  hasValidSyncedPosMenuItemId,
  normalizePosOrderItems,
} from '../../shared/utils/pos-order-items';
import {
  resolveSelectedCustomerAddress,
  withMaterializedCustomerAddresses,
} from '../utils/customer-addresses';
import {
  MODAL_ZONE_VALIDATION_FIELD,
  MODAL_DESTINATION_UNCHANGED_FIELD,
  canKeepDeliveryZoneForCustomerEdit,
  planDeliveryAddressRepick,
  planDeliveryZoneHandoff,
  resolveHandoffCustomer,
} from '../utils/delivery-zone-handoff';


interface OrderFlowProps {
  className?: string;
  /** Force retail mode - always show ProductCatalogModal instead of MenuModal */
  forceRetailMode?: boolean;
  /** Hide the floating action button when a parent screen already owns the entry point */
  showFab?: boolean;
  /** Disable automatic draft restoration when a paired OrderDashboard owns it. */
  restoreDraftOnMount?: boolean;
}

interface Customer {
  id: string;
  phone: string;
  name: string;
  email?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  name_on_ringer?: string;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] };
  latitude?: number | null;
  longitude?: number | null;
  address_fingerprint?: string | null;
  version?: number;
  editAddressId?: string; // ID of address being edited
  addresses?: Array<{
    id: string;
    street_address: string;
    street?: string;
    city: string;
    postal_code?: string;
    floor_number?: string;
    notes?: string;
    delivery_notes?: string;
    name_on_ringer?: string;
    coordinates?:
      | { lat: number; lng: number }
      | { type: 'Point'; coordinates: [number, number] };
    latitude?: number | null;
    longitude?: number | null;
    address_fingerprint?: string | null;
    address_type: string;
    is_default: boolean;
    created_at: string;
    version?: number;
    is_legacy_fallback?: boolean;
  }>;
}

/**
 * Complete Order Flow Component
 * Handles the full order creation workflow from type selection to completion
 */
// Compose an order-type card's accessible name: title + description, but avoid repeating the title when the
// description is empty or equal (mirrors OrderDashboard's helper so both order-taking paths announce identically).
const composeOrderTypeAriaLabel = (title: string, description: string): string => {
  const cleanTitle = (title || '').trim();
  const cleanDescription = (description || '').trim();
  if (!cleanDescription || cleanDescription.toLowerCase() === cleanTitle.toLowerCase()) {
    return cleanTitle;
  }
  return `${cleanTitle}. ${cleanDescription}`;
};

const OrderFlow = memo<OrderFlowProps>(({ className = '', forceRetailMode = false, showFab = true, restoreDraftOnMount = true }) => {
  const bridge = getBridge();
  const { t } = useI18n();
  const { isFeatureEnabled } = useFeatures();
  const { askForPaymentPrint, shouldAskPaymentPrint, paymentPrintPromptModal } = usePaymentPrintPrompt();
  const canCreateOrders = isFeatureEnabled('orderCreation');

  // Modal states
  const [isOrderTypeModalOpen, setIsOrderTypeModalOpen] = useState(false);
  const [isCustomerSearchModalOpen, setIsCustomerSearchModalOpen] = useState(false);
  const [isAddCustomerModalOpen, setIsAddCustomerModalOpen] = useState(false);
  const [isMenuModalOpen, setIsMenuModalOpen] = useState(false);
  const [splitPaymentData, setSplitPaymentData] = useState<{
    orderId: string;
    orderTotal: number;
    items: SplitPaymentItem[];
    isGhostOrder: boolean;
    orderNumber?: string;
    orderType: 'pickup' | 'delivery';
    existingPayments?: any[];
    tipAmount?: number;
    tipRecipientRole?: 'waiter' | 'cashier' | 'driver';
    tipRecipientStaffId?: string;
    tipRecipientStaffShiftId?: string;
    recoverySession?: number;
    settlementGeneration?: string;
  } | null>(null);
  const [outstandingPaymentData, setOutstandingPaymentData] = useState<{
    orderId: string;
    orderTotal: number;
    outstandingAmount: number;
    items: SplitPaymentItem[];
    isGhostOrder: boolean;
    orderNumber?: string;
    orderType: 'pickup' | 'delivery';
    existingPayments: any[];
    tipAmount?: number;
    tipRecipientRole?: 'waiter' | 'cashier' | 'driver';
    tipRecipientStaffId?: string;
    tipRecipientStaffShiftId?: string;
    recoverySession?: number;
    settlementGeneration: string;
  } | null>(null);
  const [isProcessingOutstandingPayment, setIsProcessingOutstandingPayment] = useState(false);
  const [isReconcilingSplitClose, setIsReconcilingSplitClose] = useState(false);
  const splitPaymentCompletedRef = useRef<SplitPaymentResult | null>(null);
  const splitCloseRecoveryRef = useRef(false);

  // Customer modal mode: 'new' | 'edit' | 'addAddress' | 'editAddress'
  const [customerModalMode, setCustomerModalMode] = useState<'new' | 'edit' | 'addAddress' | 'editAddress'>('new');
  // Customer for editing or adding address in AddCustomerModal
  const [customerToEdit, setCustomerToEdit] = useState<Customer | null>(null);

  // Order flow states
  const [selectedOrderType, setSelectedOrderType] = useState<'pickup' | 'delivery' | 'dine-in' | null>(null);
  const [restoredEditContext, setRestoredEditContext] = useState<Record<string, any> | null>(null);
  const [recoveredEditPrompt, setRecoveredEditPrompt] = useState<{
    data: MenuOrderEditData; lifecycle: MenuOrderEditLifecycle; preview: OrderEditSettlementPreview;
    amount: number; resolve(): void; reject(error: Error): void;
  } | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<any>(null);
  const [deliveryZoneInfo, setDeliveryZoneInfo] = useState<DeliveryBoundaryValidationResponse | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isProcessingOrder, setIsProcessingOrder] = useState(false);
  // The store's tax rate, or null while it cannot be read (item H).
  const [taxRatePercentage, setTaxRatePercentage] = useState<number | null>(null);

  // Zone validation alert states
  const [showZoneAlert, setShowZoneAlert] = useState(false);
  const [overrideApproved, setOverrideApproved] = useState(false);

  // Order store for managing orders
  const { createOrder, silentRefresh, orders } = useOrderStore();

  // Shift context for linking orders to shifts
  const { staff, activeShift, isShiftActive } = useShift();
  const isOperationalShiftActive = useOperationalShift(isShiftActive);
  const { requestOverride } = useDeliveryValidation();

  // Module-based feature flags
  const { hasDeliveryModule, hasTablesModule, hasModule } = useAcquiredModules();
  const hasLoyaltyModule = hasModule(MODULE_IDS.LOYALTY);
  const hasReservationsModule = hasModule(MODULE_IDS.RESERVATIONS);

  // Get organizationId and businessType from module context (with credential cache fallback)
  const { organizationId: moduleOrgId, businessType } = useModules();
  const {
    branchId: resolvedIdentityBranchId,
    organizationId: resolvedIdentityOrganizationId,
    terminalId: resolvedIdentityTerminalId,
  } = useResolvedPosIdentity('branch+organization');

  // Check if this is a retail vertical (uses product catalog instead of menu)
  // forceRetailMode allows ProductCatalogView to force retail mode regardless of businessType
  const isRetailVertical = forceRetailMode || businessType === 'retail';
  
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

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  // Use module context organizationId if available, otherwise fall back to cache
  const organizationId = resolvedIdentityOrganizationId || moduleOrgId || localOrgId;
  const effectiveBranchId = resolvedIdentityBranchId || branchId || staff?.branchId || null;

  // Ordinary cash/card collection and the gift tender share one scope: the
  // resolved organization and this terminal's public id. A missing value fails
  // closed in the shared collection controller.
  const collectionScope = useMemo<GiftCardScope>(() => ({
    organizationId: resolvedIdentityOrganizationId ?? null,
    terminalId: resolvedIdentityTerminalId ?? null,
  }), [resolvedIdentityOrganizationId, resolvedIdentityTerminalId]);

  // Browser and native connectivity, as the gift card surfaces read it.
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  const [nativeOnline, setNativeOnline] = useState(true);
  useEffect(() => {
    let disposed = false;
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    const applyNativeStatus = (status: unknown) => {
      const flag = status && typeof status === 'object'
        ? (status as { isOnline?: unknown }).isOnline
        : undefined;
      if (!disposed && typeof flag === 'boolean') setNativeOnline(flag);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    onEvent('network:status', applyNativeStatus);
    void Promise.resolve()
      .then(() => getBridge().sync.getNetworkStatus())
      .then(applyNativeStatus)
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      offEvent('network:status', applyNativeStatus);
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

  useEffect(() => {
    const epoch = outstandingEpochRef.current;
    setOutstandingGiftCurrency(null);
    setGiftSettledOrderId(null);
    // A new target or scope never inherits an older target's processing state.
    setIsProcessingOutstandingPayment(false);
    if (outstandingTargetOrderId) {
      // Read fresh for every opened target; a failed read leaves no currency.
      void giftCardsApiService.getStatus()
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
    const remoteId = String(order?.supabase_id ?? order?.supabaseId ?? '').trim();
    return Boolean(remoteId) && (order?.sync_status ?? order?.syncStatus) === 'synced';
  }, [orders, outstandingTargetOrderId]);

  // Fetch tables for table orders - use actual IDs
  // Only enable fetching when both IDs are available
  const { tables, refetch: refetchTables, updateTableStatus } = useTables({
    branchId: effectiveBranchId || '', 
    organizationId: organizationId || '',
    enabled: Boolean(effectiveBranchId && organizationId)
  });

  // Table order flow states
  const [showTableSelector, setShowTableSelector] = useState(false);
  const [showTableActionModal, setShowTableActionModal] = useState(false);
  const [showReservationForm, setShowReservationForm] = useState(false);
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null);
  const [tableNumber, setTableNumber] = useState('');

  // Fetch tax rate from terminal settings; auto-updates on settings change.
  // Item H (fix review 30/09/2026): a stored rate, today's 24% when none is
  // stored, and null (checkout paused) when the settings could not be read or
  // the stored value is not a rate. Never an assumed 24% on a read error.
  const {
    getSetting,
    loaded: terminalSettingsLoaded,
    reload: reloadTerminalSettings,
  } = useTerminalSettings();
  useEffect(() => {
    const resolved = resolveCheckoutTaxRate({ loaded: terminalSettingsLoaded, getSetting });
    setTaxRatePercentage(resolved.available ? resolved.rate : null);
  }, [getSetting, terminalSettingsLoaded]);

  // Fix review 30/09/2026: one checkout id per cart, reused by every press
  // of Pay until the checkout ends, so a slow card terminal is never paid
  // twice.
  const { take: takeCheckoutRequestId, reset: resetCheckoutRequestId, restore: restoreCheckoutRequestId, dismiss: dismissCheckoutRequestId } =
    useCheckoutRequestId();

  // Reset all flow states
  const resetFlow = useCallback(() => {
    dismissCheckoutRequestId();
    setRestoredEditContext(null);
    setSelectedTable(null);
    setTableNumber('');
    setIsOrderTypeModalOpen(false);
    setIsCustomerSearchModalOpen(false);
    setIsAddCustomerModalOpen(false);
    setIsMenuModalOpen(false);
    setSplitPaymentData(null);
    setOutstandingPaymentData(null);
    setSelectedOrderType(null);
    setSelectedCustomer(null);
    setSelectedAddress(null);
    setDeliveryZoneInfo(null);
    setIsTransitioning(false);
    setShowZoneAlert(false);
    setOverrideApproved(false);
  }, [dismissCheckoutRequestId]);

  const restoreDraftContext = useCallback((context: Record<string, any>, renewal?: { previousCheckoutRequestId: string }) => {
    if (!['pickup', 'delivery', 'dine-in'].includes(context.orderType)) throw new Error('CHECKOUT_DRAFT_CONTEXT_INVALID');
    setSelectedOrderType(context.orderType);
    setSelectedCustomer(context.selectedCustomer || { id: 'pickup-customer', name: '', phone: '', email: '', addresses: [] });
    setSelectedAddress(context.selectedAddress || null);
    setSelectedTable(context.selectedTable || null);
    setTableNumber(context.tableNumber || '');
    setDeliveryZoneInfo(context.deliveryZoneInfo || null);
    setRestoredEditContext(context.editMode ? context : null);
    if (context.checkoutRequestId) restoreCheckoutRequestId(context.checkoutRequestId, { phase: context.checkoutPhase, editMode: context.editMode, renewedFrom: renewal?.previousCheckoutRequestId });
    setIsMenuModalOpen(true);
  }, [restoreCheckoutRequestId]);

  useEffect(() => {
    if (!restoreDraftOnMount || isRetailVertical || !organizationId || !effectiveBranchId || !resolvedIdentityTerminalId) return;
    let disposed = false;
    void getCheckoutDraftStore().then(owner => owner.load()).then(saved => {
      if (!disposed && saved && (saved.cartItems.length || saved.phase === 'checkout_pending')) {
        restoreDraftContext({ ...saved.context, checkoutRequestId: saved.checkoutRequestId, checkoutPhase: saved.phase });
      }
    }).catch(() => { /* The modal's durable read gate surfaces failure without replacing the cart. */ });
    return () => { disposed = true; };
  }, [organizationId, effectiveBranchId, resolvedIdentityTerminalId, isRetailVertical, restoreDraftOnMount, restoreDraftContext]);

  const acceptRecoveredDraftOrder = useCallback(async (order: any) => {
    const response = await bridge.orders.getById(order.id);
    const saved = (response as any)?.data || response;
    if (!saved?.id) throw new Error('CHECKOUT_DRAFT_ORDER_UNAVAILABLE');
    await silentRefresh();
    resetCheckoutRequestId();
    toast.success(t('modals.menu.draftRecovered', { defaultValue: 'The original order is saved. No new payment was started.' }));
  }, [bridge.orders, silentRefresh, resetCheckoutRequestId, t]);

  const preflightRecoveredEdit = useCallback(async (data: MenuOrderEditData) =>
    (await previewMenuOrderEdit(bridge.orders, data, bridge.sync)).preflight, [bridge.orders, bridge.sync]);

  const completeRecoveredEdit = useCallback(async (data: MenuOrderEditData, lifecycle?: MenuOrderEditLifecycle) => {
    if (data.action === 'edit_settlement') {
      if (!data.settlementAction) throw new Error('RECOVERY_ORIGINAL_REQUEST_REQUIRED');
      await commitMenuOrderEdit(bridge.orders, data, data.settlementAction);
      void silentRefresh().catch(() => undefined);
      return;
    }
    const { preflight, preview } = await previewMenuOrderEdit(bridge.orders, data, bridge.sync);
    if (preflight.kind !== 'settlement') {
      const result = await bridge.orders.updateItems(data.orderId, data.items, {
        clientEventId: data.client_event_id, expectedVersion: data.expected_version,
          expectedLocalVersion: data.renderer_local_version,
        tableSessionId: restoredEditContext?.tableSessionId || restoredEditContext?.table_session_id,
        orderUpdates: data.orderUpdates, financials: data.financials, orderNotes: data.notes,
      });
      if (result?.success === false) throw new Error(result.error || 'CHECKOUT_DRAFT_EDIT_NOT_APPLIED');
    } else {
      if (!lifecycle) throw new Error('CHECKOUT_DRAFT_EDIT_FREEZE_REQUIRED');
      if (preview.requiredAction === 'none') await commitMenuOrderEdit(bridge.orders, data, { type: 'none' }, lifecycle);
      else await new Promise<void>((resolve, reject) => setRecoveredEditPrompt({ data, lifecycle, preview,
        amount: preview.requiredAction === 'collect' ? Math.max(0, preview.nextTotal - preview.paidTotal) : resolveEditSettlementRefundAmount(preview), resolve, reject }));
    }
    void silentRefresh().catch(() => undefined);
  }, [bridge.orders, bridge.sync, restoredEditContext, silentRefresh]);

  const confirmRecoveredEdit = async (method: 'cash' | 'card') => {
    if (!recoveredEditPrompt) return;
    const pending = recoveredEditPrompt;
    try {
      const collectionAttribution = resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
        shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] });
      const action = pending.preview.requiredAction === 'collect'
        ? { type: 'collect' as const, payments: [{ orderId: pending.data.orderId, method, amount: pending.amount,
          ...collectionAttribution, paymentOrigin: 'manual' as const, collectedBy: 'cashier_drawer' as const }] }
        : menuEditRefundAction(pending.preview, pending.amount, method,
          t('orderDashboard.editSettlementRefundReason', { defaultValue: 'Edit settlement refund' }),
          { staffId: staff?.databaseStaffId || staff?.staffId, staffShiftId: activeShift?.id });
      await commitMenuOrderEdit(bridge.orders, pending.data, action, pending.lifecycle);
      setRecoveredEditPrompt(null);
      pending.resolve();
    } catch (error) {
      setRecoveredEditPrompt(null);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleStartNewOrder = useCallback(() => {
    resetFlow();
    setIsOrderTypeModalOpen(true);
  }, [resetFlow]);

  const handleSelectOrderType = useCallback(async (type: 'pickup' | 'delivery' | 'dine-in') => {
    setIsTransitioning(true);
    if (type !== 'dine-in') {
      setSelectedOrderType(type);
    }

    // Smooth transition with loading state
    await new Promise(resolve => setTimeout(resolve, 300));

    setIsOrderTypeModalOpen(false);

    if (type === 'pickup') {
      // For pickup orders, create a default customer and go directly to menu
      const pickupCustomer: Customer = {
        id: 'pickup-customer',
        name: '',
        phone: '',
        email: '',
        addresses: []
      };
      setSelectedCustomer(pickupCustomer);
      setIsMenuModalOpen(true);
    } else if (type === 'delivery') {
      // For delivery orders, show customer search modal
      setIsCustomerSearchModalOpen(true);
    } else if (type === 'dine-in') {
      // For table orders, show table selector
      setShowTableSelector(true);
    }

    setIsTransitioning(false);
  }, [t]);

  const handleCustomerSelected = useCallback((customer: Customer) => {
    const normalizedCustomer = withMaterializedCustomerAddresses(customer) as Customer;
    setSelectedCustomer(normalizedCustomer);
    setIsCustomerSearchModalOpen(false);

    const selectedAddress = resolveSelectedCustomerAddress(normalizedCustomer);
    if (selectedAddress) {
      setSelectedAddress(selectedAddress);
      setIsMenuModalOpen(true);
      return;
    }

    if (normalizedCustomer.address) {
      const legacyAddress = {
        street_address: normalizedCustomer.address,
        city: (normalizedCustomer as any).city || '',
        postal_code: normalizedCustomer.postal_code,
        floor_number: normalizedCustomer.floor_number,
        notes: normalizedCustomer.notes,
      };
      setSelectedAddress(legacyAddress);
      setIsMenuModalOpen(true);
    } else {
      // No addresses - for delivery orders, go back to search
      if (selectedOrderType === 'delivery') {
        toast.error(t('orderFlow.noAddressForDelivery'));
        setIsCustomerSearchModalOpen(true);
      } else {
        setIsMenuModalOpen(true);
      }
    }
  }, [selectedOrderType, t]);

  const [newCustomerInitialPhone, setNewCustomerInitialPhone] = useState<string>('');

  const handleAddNewCustomer = useCallback((phone: string) => {
    setIsCustomerSearchModalOpen(false);
    setNewCustomerInitialPhone((phone || '').trim());
    setCustomerToEdit(null);
    setCustomerModalMode('new');
    setIsAddCustomerModalOpen(true);
  }, []);

  const handleAddressSelected = useCallback((customer: Customer, address: any, validationResult?: DeliveryBoundaryValidationResponse) => {
    setSelectedCustomer(withMaterializedCustomerAddresses(customer) as Customer);
    setSelectedAddress(address);
    setDeliveryZoneInfo(validationResult || null);

    // Check if we can proceed directly to menu
    if (validationResult?.uiState?.canProceed) {
      // Validation passed, proceed to menu
      setIsMenuModalOpen(true);
    } else if (validationResult) {
      // Validation issues exist, show zone alert instead of proceeding
      setShowZoneAlert(true);
      toast(t('orderFlow.zoneValidationRequired'), {
        duration: 3000,
        icon: <AlertTriangle className="w-4 h-4 text-white" />,
        style: { background: '#f59e0b', color: 'white' }
      });
    } else {
      // No validation result (shouldn't happen), proceed with warning
      toast(t('orderFlow.noValidationResult'), {
        duration: 3000,
        icon: <AlertTriangle className="w-4 h-4 text-white" />,
        style: { background: '#f59e0b', color: 'white' }
      });
      setIsMenuModalOpen(true);
    }
  }, []);

  const handleAddNewAddress = useCallback((customer: Customer) => {
    // Use AddCustomerModal in 'addAddress' mode for full geocoding & all fields
    setCustomerToEdit(customer);
    setCustomerModalMode('addAddress');
    setIsCustomerSearchModalOpen(false);
    setIsAddCustomerModalOpen(true);
  }, []);

  const handleAddressAdded = useCallback((customer: Customer) => {
    // Address was added via AddCustomerModal - customer now has new address data
    const selectedAddressId = (customer as any).selected_address_id;
    const nextAddress =
      (selectedAddressId && customer.addresses?.find((address) => address.id === selectedAddressId)) ||
      customer.addresses?.find((address) => address.is_default) ||
      customer.addresses?.[0];

    setSelectedCustomer(customer);
    setSelectedAddress({
      street_address: nextAddress?.street_address || nextAddress?.street || customer.address || '',
      city: nextAddress?.city || customer.city || '',
      postal_code: nextAddress?.postal_code || customer.postal_code,
      floor_number: nextAddress?.floor_number || customer.floor_number,
      notes: nextAddress?.notes || nextAddress?.delivery_notes || customer.notes,
      name_on_ringer: nextAddress?.name_on_ringer || customer.name_on_ringer,
      // Strict: an address without coordinates keeps none (never (0,0)).
      ...(() => {
        const point = nextAddress
          ? toValidLatLng(nextAddress.coordinates, nextAddress.latitude, nextAddress.longitude)
          : toValidLatLng(customer.coordinates, customer.latitude, customer.longitude);
        return {
          coordinates: point ?? undefined,
          latitude: point?.lat ?? null,
          longitude: point?.lng ?? null,
        };
      })(),
    });
    setCustomerToEdit(null);
    setCustomerModalMode('new');
    setIsAddCustomerModalOpen(false);
    setIsMenuModalOpen(true);
    toast.success(t('orderFlow.addressAdded'));
  }, [t]);

  const handleEditCustomer = useCallback((customer: Customer) => {
    // Check if we're editing a specific address (editAddressId is set by CustomerSearchModal)
    if (customer.editAddressId) {
      // Edit address mode
      setCustomerToEdit(customer);
      setCustomerModalMode('editAddress');
    } else {
      // Edit customer mode
      setCustomerToEdit(customer);
      setCustomerModalMode('edit');
    }
    setIsCustomerSearchModalOpen(false);
    setIsAddCustomerModalOpen(true);
  }, []);

  // Opened from the menu's "delivery zone not checked" notice ("pick the
  // address again"): saving returns to the SAME menu (cart kept) with the
  // edited address; closing without saving keeps everything as it was.
  const menuAddressRepickRef = useRef(false);

  const handleRepickDeliveryAddress = useCallback(() => {
    const orderAddress =
      selectedAddress && typeof selectedAddress.id === 'string' && selectedAddress.id
        ? selectedAddress
        : selectedCustomer
          ? resolveSelectedCustomerAddress(selectedCustomer)
          : null;
    const repick = planDeliveryAddressRepick(selectedCustomer, orderAddress);
    if (repick.kind === 'edit_address') {
      menuAddressRepickRef.current = true;
      setCustomerToEdit(repick.customer as Customer);
      setCustomerModalMode('editAddress');
      setIsAddCustomerModalOpen(true);
      return;
    }
    // No saved address row: pick the customer's address again from search.
    setIsCustomerSearchModalOpen(true);
  }, [selectedAddress, selectedCustomer]);

  const handleCustomerAdded = useCallback((newCustomer: Customer) => {
    const handoff = resolveHandoffCustomer(newCustomer as any, {
      customerId: typeof selectedCustomer?.id === 'string' ? selectedCustomer.id : null,
      selectedAddressId: typeof selectedAddress?.id === 'string' ? selectedAddress.id : null,
    });
    const keepDeliveryZone = canKeepDeliveryZoneForCustomerEdit({
      customerId: handoff.customer.id,
      previousCustomerId: selectedCustomer?.id,
      address: handoff.address,
      previousAddress: selectedAddress,
      unchangedDestination: (newCustomer as any)[MODAL_DESTINATION_UNCHANGED_FIELD],
      zoneInfo: deliveryZoneInfo,
    });
    if (menuAddressRepickRef.current) {
      menuAddressRepickRef.current = false;
      // The order goes to the address that was just edited, and the modal's
      // own zone check is reused (never re-checked) when it ran one.
      const zonePlan = planDeliveryZoneHandoff({
        address: handoff.address,
        modalValidation: (newCustomer as any)?.[MODAL_ZONE_VALIDATION_FIELD],
        addressFromModal: handoff.addressFromModal,
      });
      setSelectedCustomer(handoff.customer as unknown as Customer);
      if (handoff.address) {
        setSelectedAddress(handoff.address);
      }
      // Anything but a reusable check: the menu checks the point itself, or
      // geolocates the address, or shows "zone not checked".
      if (!keepDeliveryZone) setDeliveryZoneInfo(zonePlan.kind === 'reuse' ? zonePlan.zoneInfo : null);
      setIsAddCustomerModalOpen(false);
      setCustomerToEdit(null);
      setCustomerModalMode('new');
      toast.success(t('orderFlow.addressUpdated', 'Address updated'));
      return;
    }

    const wasEditing = !!customerToEdit;
    const wasEditingAddress = customerModalMode === 'editAddress';
    const wasAddingAddress = customerModalMode === 'addAddress';
    
    setSelectedCustomer(handoff.customer as unknown as Customer);
    if (!keepDeliveryZone) setDeliveryZoneInfo(null);
    setIsAddCustomerModalOpen(false);
    setCustomerToEdit(null); // Clear edit state
    setCustomerModalMode('new'); // Reset mode

    if (wasEditingAddress || wasAddingAddress) {
      // After editing/adding an address, go back to customer search to show the same customer's addresses
      toast.success(wasEditingAddress ? t('orderFlow.addressUpdated', 'Address updated') : t('orderFlow.addressAdded'));
      setIsCustomerSearchModalOpen(true);
    } else if (wasEditing) {
      // After editing customer info, go back to customer search for address selection
      toast.success(t('orderFlow.customerUpdated'));
      setIsCustomerSearchModalOpen(true);
    } else {
      // New customer - proceed to menu
      if (newCustomer.addresses && newCustomer.addresses.length > 0) {
        setSelectedAddress(newCustomer.addresses[0]);
      }
      setIsMenuModalOpen(true);
      toast.success(t('orderFlow.customerAdded'));
    }
  }, [t, customerToEdit, customerModalMode, selectedAddress, selectedCustomer, deliveryZoneInfo]);

  const handleMenuModalClose = useCallback(() => {
    resetFlow();
  }, [resetFlow]);

  const finalizeCreatedOrderPayment = useCallback(async (
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
      const shouldPrint = await askForPaymentPrint({ orderId, ...promptContext });
      if (!shouldPrint) return;
    }

    // Ghost orders and prompt-controlled orders are not printed by Rust auto-print.
    if (isGhostOrder || autoPrintSuppressed) {
      await bridge.payments.printReceipt(orderId);
      if (isGhostOrder) return;
    }

    if (isGhostOrder) {
      return;
    }

    // Non-ghost orders: Rust auto-print already enqueued the correct receipt
    // (order_receipt for dine-in/takeout, delivery_slip for delivery).
    // Only fire fiscal print if enabled in settings.
    const fiscalEnabled = await bridge.settings.get('terminal', 'fiscal_print_enabled')
      .catch(() => true);
    if (fiscalEnabled === false || fiscalEnabled === 'false' || fiscalEnabled === '0') {
      return;
    }

    const fiscalResult: any = await bridge.ecr.fiscalPrint(orderId);
    if (fiscalResult?.skipped) {
      return;
    }
  }, [askForPaymentPrint, bridge]);

  const handleSplitClose = useCallback(async () => {
    const closingSplitPayment = splitPaymentData;
    splitPaymentCompletedRef.current = null;
    if (!closingSplitPayment) return;
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

      if (resolution.kind === 'settled') {
        setSplitPaymentData(null);
        resetFlow();
        return;
      }

      if (resolution.kind === 'partial') {
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
        ...closingSplitPayment,
        orderTotal: resolution.orderTotal,
        outstandingAmount: resolution.outstandingAmount,
        existingPayments: resolution.completedPayments,
        settlementGeneration: resolution.settlementGeneration!,
      });
      setSplitPaymentData(null);
    } catch (error) {
      console.error('[OrderFlow] Failed to reconcile dismissed split payment:', error);
      setSplitPaymentData(closingSplitPayment);
      toast.error(t('orderDashboard.collectPaymentFailed', {
        defaultValue: 'Failed to load the outstanding payment. Try again.',
      }));
    } finally {
      splitCloseRecoveryRef.current = false;
      setIsReconcilingSplitClose(false);
    }
  }, [bridge, resetFlow, silentRefresh, splitPaymentData, t]);

  const ordinaryRefusalText = useCallback((code: string) => (
    code === 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED'
      ? t('giftCardCheckout.refusal.scope', 'This terminal has no confirmed organization or terminal identity. Pair the POS again.')
      : t('giftCardCheckout.refusal.admission', 'Earlier gift card attempts must be checked first.')
  ), [t]);
  // Order whose ordinary write landed before its ledger could be read.
  const ordinaryLandedRef = useRef<string | null>(null);
  const outstandingPaymentDataRef = useRef(outstandingPaymentData);
  outstandingPaymentDataRef.current = outstandingPaymentData;

  // The Tender's receipt steps that keep a gift-paid order's receipt open;
  // any other native answer ends it.
  const giftReceiptPending = (nextAction: string): boolean =>
    nextAction === 'finalize' || nextAction === 'reconcile' || nextAction === 'recheck';

  // Original receipt context of orders the Tender reported fully paid by gift
  // card, kept per order and independent of the current UI target. Memory
  // only: after a restart the native journal governs.
  const giftBookedReceiptsRef = useRef(new Map<string, NonNullable<typeof outstandingPaymentData>>());

  // Gift adoption for the outstanding order. The Tender already booked the
  // money natively; the host only rereads the canonical ledger once per new
  // payment and never records, completes or prints anything for it.
  const handleOutstandingGiftEvent = useCallback((event: GiftCardTenderEvent) => {
    if (event.type === 'fiscal') {
      // The Tender's own receipt progress: a finished receipt ends its retained reentry.
      giftFiscalNextRef.current = { orderId: event.orderId, nextAction: event.fiscal.nextAction };
      if (!giftReceiptPending(event.fiscal.nextAction)) {
        setGiftReceiptRecoveries((current) => current.filter((entry) => entry.orderId !== event.orderId));
      }
      return;
    }
    if (event.type !== 'financial') return;
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
    if (event.adopted.length > 0 && coverage !== null && coverage.fullyCovered && coverage.outstandingCents === 0) {
      giftBookedReceiptsRef.current.set(orderId, pendingPayment);
    }
    giftEventQueueRef.current = giftEventQueueRef.current
      .then(async () => {
        if (freshPaymentIds.length > 0) await silentRefresh().catch(() => {});
        const settlement = await loadPersistedSplitDismissal(bridge, orderId, orderTotal);
        if (epoch !== outstandingEpochRef.current) return;
        if (settlement.kind === 'settled' && coverage !== null && coverage.fullyCovered && coverage.outstandingCents === 0) {
          // Keep the Tender mounted so its pending receipt action stays reachable.
          setGiftSettledOrderId(orderId);
          return;
        }
        const settlementGeneration = settlement.settlementGeneration;
        if (!settlementGeneration) return;
        setOutstandingPaymentData((current) => (current && current.orderId === orderId
          ? {
              ...current,
              orderTotal: settlement.orderTotal,
              outstandingAmount: settlement.outstandingAmount,
              existingPayments: settlement.completedPayments,
              settlementGeneration,
            }
          : current));
      })
      .catch(() => undefined);
  }, [bridge, collectionScope, silentRefresh]);

  const outstandingExistingOrder = useMemo<PaymentModalExistingOrder | undefined>(() => {
    const orderId = outstandingPaymentData?.orderId;
    if (!orderId) return undefined;
    return {
      orderId,
      orderSynced: outstandingOrderSynced,
      currency: outstandingGiftCurrency?.orderId === orderId ? outstandingGiftCurrency.currency : null,
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

  // Reopens a gift-paid order's own Tender, which reads native receipt state
  // and offers only the step native allows; nothing here collects money.
  const reenterGiftReceipt = useCallback((orderId: string) => {
    if (outstandingPaymentDataRef.current) return;
    const retained = giftReceiptRecoveries.find((entry) => entry.orderId === orderId);
    if (!retained) return;
    setGiftReceiptReentryOrderId(orderId);
    setOutstandingPaymentData({ ...retained, outstandingAmount: 0 });
  }, [giftReceiptRecoveries]);

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
      if (!reentry) resetFlow();
      return;
    }
    setSplitPaymentData({
      orderId: pendingPayment.orderId,
      orderTotal: pendingPayment.orderTotal,
      items: pendingPayment.items,
      isGhostOrder: pendingPayment.isGhostOrder,
      orderNumber: pendingPayment.orderNumber,
      orderType: pendingPayment.orderType,
      existingPayments: pendingPayment.existingPayments,
      tipAmount: pendingPayment.tipAmount,
      tipRecipientRole: pendingPayment.tipRecipientRole,
      tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
      tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
      recoverySession: (pendingPayment.recoverySession ?? 0) + 1,
    });
  }, [giftReceiptReentryOrderId, giftSettledOrderId, resetFlow]);

  const handleOutstandingPaymentSelect = useCallback(async (
    selection: OutstandingPaymentSelection,
  ): Promise<boolean | 'reconciliation-pending'> => {
    const pendingPayment = outstandingPaymentData;
    if (!pendingPayment) return false;

    if (selection.method === 'split') {
      setOutstandingPaymentData(null);
      setSplitPaymentData({
        orderId: pendingPayment.orderId,
        orderTotal: pendingPayment.orderTotal,
        items: pendingPayment.items,
        isGhostOrder: pendingPayment.isGhostOrder,
        orderNumber: pendingPayment.orderNumber,
        orderType: pendingPayment.orderType,
        existingPayments: pendingPayment.existingPayments,
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
          return claim.retained ? 'reconciliation-pending' : false;
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
              const settlement = await loadPersistedSplitDismissal(bridge, orderId, pendingPayment.orderTotal);
              return { completedPayments: settlement.completedPayments, value: settlement };
            })
          : null;
        if (probe?.status === 'unknown') return 'reconciliation-pending';
        const snapshot = probe?.status === 'completed' && probe.value
          ? probe.value
          : await loadPersistedSplitDismissal(bridge, orderId, pendingPayment.orderTotal).catch(() => null);
        if (!snapshot) return 'reconciliation-pending';
        latestResolution = snapshot;
        collectedHere = probe?.status === 'completed' || ordinaryLandedRef.current === orderId;
      } else {
        const owner = sendOwner;
        const run = await runOrdinaryCollection(owner, {
          method: paymentMethod,
          amount: pendingPayment.outstandingAmount,
          transactionRef: selection.transactionId ?? null,
          idempotencyKey: selection.idempotencyKey ?? selection.transactionId ?? null,
          settlementGeneration: pendingPayment.settlementGeneration,
          terminalTransactionId: null,
        }, async () => {
          const attempt = await reconcileOutstandingPaymentAttempt({
            recordPayment: () => bridge.payments.recordPayment({
              orderId,
              method: paymentMethod,
              amount: pendingPayment.outstandingAmount,
              cashReceived: paymentMethod === 'cash' ? selection.cashReceived : undefined,
              changeGiven: paymentMethod === 'cash' ? selection.change : undefined,
              transactionRef: selection.transactionId,
              idempotencyKey: selection.idempotencyKey ?? selection.transactionId,
                  currency: selection.currency,
                  metadata: selection.metadata,
              collectOutstandingBalance: true,
              expectedSettlementGeneration: pendingPayment.settlementGeneration,
              ...resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] }),
              collectedBy: ['cashier', 'manager'].includes(activeShift?.role_type ?? '') ? 'cashier_drawer' : undefined,
              tipAmount: pendingPayment.tipAmount,
              tipRecipientRole: pendingPayment.tipRecipientRole,
              tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
              tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
            }),
            bridge,
            orderId,
            fallbackOrderTotal: pendingPayment.orderTotal,
          });
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
          let verdict: OrdinaryCollectionVerdict = classifyOrdinaryWrite(facts);
          // Only the original's own row in the canonical ledger proves a lost reply booked.
          if (verdict === 'unknown' && 'settlement' in attempt
            && ledgerHasOriginalOrdinaryPayment(owner, attempt.settlement.completedPayments)) {
            verdict = 'completed';
          }
          return { verdict, value: attempt, code: facts.code };
        });
        if (run.status === 'refused') {
          toast.error(ordinaryRefusalText(run.code));
          return false;
        }
        const attempt = run.value;
        if (attempt?.kind === 'not_saved') {
          // The card was charged but its payment is not saved on this till (or
          // the tender was refused because one is not): never "Failed to
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
        if (run.status === 'unknown' || !attempt || attempt.kind === 'unknown') {
          if (run.status === 'completed') ordinaryLandedRef.current = orderId;
          if (epoch === outstandingEpochRef.current) {
            toast.error(t('orderDashboard.collectPaymentFailed', {
              defaultValue: 'Failed to collect payment',
            }));
          }
          return 'reconciliation-pending';
        }
        latestResolution = attempt.settlement;
        collectedHere = run.status === 'completed';
      }
      // A late result settles the original claim but never a newer screen,
      // checked again after the refresh: its target or scope may have changed.
      if (epoch !== outstandingEpochRef.current) return false;
      await silentRefresh().catch(() => {});
      if (epoch !== outstandingEpochRef.current) return false;

      if (latestResolution.kind === 'partial') {
        setOutstandingPaymentData(null);
        setSplitPaymentData({
          orderId: pendingPayment.orderId,
          orderTotal: latestResolution.orderTotal,
          items: pendingPayment.items,
          isGhostOrder: pendingPayment.isGhostOrder,
          orderNumber: pendingPayment.orderNumber,
          orderType: pendingPayment.orderType,
          existingPayments: latestResolution.completedPayments,
          tipAmount: pendingPayment.tipAmount,
          tipRecipientRole: pendingPayment.tipRecipientRole,
          tipRecipientStaffId: pendingPayment.tipRecipientStaffId,
          tipRecipientStaffShiftId: pendingPayment.tipRecipientStaffShiftId,
          recoverySession: (pendingPayment.recoverySession ?? 0) + 1,
          settlementGeneration: latestResolution.settlementGeneration,
        });
        toast.error(t('orderDashboard.collectPaymentFailed', {
          defaultValue: 'Failed to collect payment',
        }));
        return false;
      }

      if (latestResolution.kind !== 'settled') {
        setOutstandingPaymentData({
          ...pendingPayment,
          orderTotal: latestResolution.orderTotal,
          outstandingAmount: latestResolution.outstandingAmount,
          existingPayments: latestResolution.completedPayments,
          settlementGeneration: latestResolution.settlementGeneration!,
        });
        toast.error(t('orderDashboard.collectPaymentFailed', {
          defaultValue: 'Failed to collect payment',
        }));
        return false;
      }

      setOutstandingPaymentData(null);
      // Only this ordinary collection's own money gets its receipt here; a
      // gift-settled order's receipt belongs to the gift card Tender.
      if (collectedHere && giftSettledOrderId !== orderId) {
        void finalizeCreatedOrderPayment(pendingPayment.orderId, pendingPayment.isGhostOrder, {
          askBeforePrint,
          autoPrintSuppressed: askBeforePrint,
          amount: pendingPayment.outstandingAmount,
          orderNumber: pendingPayment.orderNumber || null,
        }).catch((error) => {
          console.warn('[OrderFlow] Recovered payment print failed:', error);
        });
      }
      if (ordinaryLandedRef.current === orderId) ordinaryLandedRef.current = null;
      resetFlow();
      return true;
    } catch {
      console.error('[OrderFlow] Failed to collect recovered payment');
      if (epoch === outstandingEpochRef.current) {
        toast.error(t('orderDashboard.collectPaymentFailed', {
          defaultValue: 'Failed to collect payment',
        }));
      }
      return false;
    } finally {
      // Ends a claim taken here only while nothing was sent under it; the
      // processing flag belongs to this target and scope only.
      if (claimedHere && sendOwner) releaseOrdinaryOwnerBeforeSend(sendOwner);
      if (epoch === outstandingEpochRef.current) setIsProcessingOutstandingPayment(false);
    }
  }, [activeShift?.id, bridge, collectionScope, finalizeCreatedOrderPayment, giftSettledOrderId, ordinaryRefusalText, outstandingPaymentData, resetFlow, shouldAskPaymentPrint, silentRefresh, staff?.staffId, t]);

  const handleSplitComplete = useCallback(async (result: SplitPaymentResult) => {
    splitPaymentCompletedRef.current = result;
    await silentRefresh().catch(() => {});
  }, [silentRefresh]);

  // Zone validation alert handlers
  const handleOverrideApproved = useCallback(() => {
    setOverrideApproved(true);
    setShowZoneAlert(false);
    setIsMenuModalOpen(true);
    toast.success(t('orderFlow.overrideApproved'));
  }, [t]);

  const handleChangeAddress = useCallback(() => {
    setShowZoneAlert(false);
    setDeliveryZoneInfo(null);
    setSelectedAddress(null);
    // Go back to customer search for address selection
    setIsCustomerSearchModalOpen(true);
  }, []);

  const handleSwitchToPickup = useCallback(() => {
    setShowZoneAlert(false);
    setDeliveryZoneInfo(null);
    setSelectedAddress(null);
    setSelectedOrderType('pickup');

    // Create pickup customer and proceed to menu
    const pickupCustomer: Customer = {
      id: 'pickup-customer',
      name: '',
      phone: '',
      email: '',
      addresses: []
    };
    setSelectedCustomer(pickupCustomer);
    setIsMenuModalOpen(true);
    toast.success(t('orderFlow.switchedToPickup'));
  }, [t]);

  // Handle table selection from TableSelector
  const handleTableSelectorSelect = useCallback((table: RestaurantTable) => {
    setEditingReservation(null);
    setSelectedTable(table);
    setShowTableSelector(false);
    setShowTableActionModal(true);
  }, []);

  // Handle New Order action from TableActionModal
  const handleTableNewOrder = useCallback(() => {
    if (selectedTable) {
      if (tableHasOpenCheckReference(selectedTable)) {
        toast.error(t('modals.menu.draftExistingTable'));
        return;
      }
      setSelectedOrderType('dine-in');
      setTableNumber(selectedTable.tableNumber.toString());
      const tableCustomer: Customer = {
        id: 'table-customer',
        name: t('orderFlow.tableCustomer', { table: formatTableDisplayNumber(selectedTable.tableNumber) }) || `Table ${formatTableDisplayNumber(selectedTable.tableNumber)}`,
        phone: '',
        email: '',
        addresses: []
      };
      setSelectedCustomer(tableCustomer);
      setShowTableActionModal(false);
      setIsMenuModalOpen(true);
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

  const handleTableEditReservation = useCallback(async () => {
    const reservationBranchId = effectiveBranchId || branchId;
    if (!selectedTable || !reservationBranchId || !organizationId) {
      toast.error(t('reservationForm.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }));
      return;
    }

    try {
      reservationsService.setContext(reservationBranchId, organizationId);
      const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
      if (!reservation) {
        toast.error(t('tableActionModal.reservationNotFound', { defaultValue: 'No active reservation found for this table' }));
        return;
      }

      setEditingReservation(reservation);
      setShowTableActionModal(false);
      setShowReservationForm(true);
    } catch (error) {
      console.error('Failed to load reservation for editing:', error);
      toast.error(t('tableActionModal.reservationLoadFailed', { defaultValue: 'Failed to load reservation' }));
    }
  }, [branchId, effectiveBranchId, organizationId, selectedTable, t]);

  const handleTableNoShowReservation = useCallback(async () => {
    const reservationBranchId = effectiveBranchId || branchId;
    if (!selectedTable || !reservationBranchId || !organizationId) {
      toast.error(t('reservationForm.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }));
      return;
    }

    try {
      reservationsService.setContext(reservationBranchId, organizationId);
      const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
      if (!reservation) {
        toast.error(t('tableActionModal.reservationNotFound', { defaultValue: 'No active reservation found for this table' }));
        return;
      }

      await reservationsService.updateStatus(reservation.id, 'no_show');
      await updateTableStatus(selectedTable.id, 'available');
      await refetchTables();
      toast.success(t('tableActionModal.noShowSuccess', { defaultValue: 'Reservation marked as no-show' }));
      setShowTableActionModal(false);
      setSelectedTable(null);
    } catch (error) {
      console.error('Failed to mark reservation no-show:', error);
      toast.error(t('tableActionModal.noShowFailed', { defaultValue: 'Failed to mark reservation as no-show' }));
    }
  }, [branchId, effectiveBranchId, organizationId, refetchTables, selectedTable, t, updateTableStatus]);

  const handleTableCancelReservation = useCallback(async () => {
    const reservationBranchId = effectiveBranchId || branchId;
    if (!selectedTable || !reservationBranchId || !organizationId) {
      toast.error(t('reservationForm.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }));
      return;
    }

    try {
      reservationsService.setContext(reservationBranchId, organizationId);
      const reservation = await reservationsService.getTodayReservationForTable(selectedTable.id);
      if (!reservation) {
        toast.error(t('tableActionModal.reservationNotFound', { defaultValue: 'No active reservation found for this table' }));
        return;
      }

      await reservationsService.cancelReservation(reservation.id,
        t('tableActionModal.cancelReason', { defaultValue: 'Cancelled from POS table actions' }),
      );
      await updateTableStatus(selectedTable.id, 'available');
      await refetchTables();
      toast.success(t('tableActionModal.cancelSuccess', { defaultValue: 'Reservation cancelled' }));
      setShowTableActionModal(false);
      setSelectedTable(null);
    } catch (error) {
      console.error('Failed to cancel reservation:', error);
      toast.error(t('tableActionModal.cancelFailed', { defaultValue: 'Failed to cancel reservation' }));
    }
  }, [branchId, effectiveBranchId, organizationId, refetchTables, selectedTable, t, updateTableStatus]);

  const handleTableSetAvailable = useCallback(async () => {
    if (!selectedTable) {
      return;
    }

    const success = await updateTableStatus(selectedTable.id, 'available');
    if (success) {
      toast.success(t('tableActionModal.setAvailableSuccess', { defaultValue: 'Table marked available' }));
      setShowTableActionModal(false);
      setSelectedTable(null);
      return;
    }

    toast.error(t('tableActionModal.setAvailableFailed', { defaultValue: 'Failed to mark table available' }));
  }, [selectedTable, t, updateTableStatus]);

  // Handle reservation form submission, through the helper the other table screens share.
  const handleReservationSubmit = useCallback(async (data: CreateReservationDto) => {
    try {
      const result = await submitTableReservation({
        data,
        editingReservation,
        branchId: effectiveBranchId || branchId,
        organizationId,
      });
      if (result === 'missing-context') {
        toast.error(t('reservationForm.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }));
        return;
      }

      toast.success(
        result === 'updated'
          ? t('reservationForm.toasts.updated', { defaultValue: 'Reservation updated successfully' })
          : t('reservationForm.toasts.created', { defaultValue: 'Reservation created successfully' }),
      );
      setShowReservationForm(false);
      setEditingReservation(null);
      setSelectedTable(null);
      await refetchTables();
    } catch (error) {
      console.error('Failed to save reservation:', error);
      const reservationUpdateError = error instanceof Error && error.message.trim()
        ? error.message
        : typeof error === 'string' && error.trim()
          ? error
          : null;
      toast.error(
        editingReservation
          ? reservationUpdateError ||
            t('reservationForm.toasts.updateFailed', {
              defaultValue: 'Failed to update reservation',
            })
          : t('reservationForm.toasts.createFailed', {
              defaultValue: 'Failed to create reservation',
            }),
      );
    }
  }, [t, branchId, effectiveBranchId, organizationId, editingReservation, refetchTables]);

  // Handle reservation form cancel
  const handleReservationCancel = useCallback(() => {
    setShowReservationForm(false);
    setEditingReservation(null);
    setSelectedTable(null);
  }, []);

  // Handle order completion from menu. Resolves false on failure so
  // MenuModal/PaymentModal keep the cart and skip their success toasts.
  const handleOrderComplete = useCallback(async (orderData: any): Promise<boolean> => {
    // Item H (fix review 30/09/2026): the store's tax rate could not be read.
    // Checkout is paused with "Try again": no order is priced or its tax split
    // on an assumed rate.
    if (taxRatePercentage === null) {
      notifyMoneySettingsUnavailable(t, reloadTerminalSettings);
      return false;
    }
    setIsProcessingOrder(true);
    let orderPersisted = false;
    const isSplitPayment = orderData.paymentData?.method === 'pending';
    const isGhostOrder = orderData.is_ghost === true;
    const ghostSource = isGhostOrder
      ? (typeof orderData.ghost_source === 'string' ? orderData.ghost_source : 'manual_code_x_1')
      : null;
    const ghostMetadata = isGhostOrder ? (orderData.ghost_metadata ?? null) : null;

    try {
      // Calculate delivery details
      let deliveryAddress = null;
      let deliveryFee = 0;
      let deliveryZoneId = null;
      let zoneName = null;
      let estimatedDeliveryTime = null;
      const effectiveDeliveryZoneInfo = orderData.deliveryZoneInfo ?? deliveryZoneInfo;
      const selectedAddressLabel =
        selectedAddress?.street_address || selectedAddress?.street || selectedAddress?.address || '';
      const selectedAddressCoordinates = parseSpecialAddressInput(selectedAddressLabel).shouldSkipZoneValidation
        ? null
        : toValidLatLng(
            selectedAddress?.coordinates,
            selectedAddress?.latitude,
            selectedAddress?.longitude,
          );

      if (selectedOrderType === 'delivery' && selectedAddress) {
        deliveryAddress = `${selectedAddress.street_address}, ${selectedAddress.city}`;
        if (selectedAddress.postal_code) {
          deliveryAddress += ` ${selectedAddress.postal_code}`;
        }
        if (selectedAddress.floor_number) {
          deliveryAddress += `, Floor: ${selectedAddress.floor_number}`;
        }

        deliveryFee = Number(orderData.deliveryFee ?? resolveDeliveryFee(effectiveDeliveryZoneInfo));

        if (effectiveDeliveryZoneInfo?.zone) {
          deliveryZoneId = effectiveDeliveryZoneInfo.zone.id;
          zoneName = effectiveDeliveryZoneInfo.zone.name;
          estimatedDeliveryTime = effectiveDeliveryZoneInfo.zone.estimatedTime;
        }
      }

      // Extract discount information
      const discountPercentage = orderData.discountPercentage || 0;
      const manualDiscountAmount = Number(orderData.discountAmount || 0);
      const loyaltyRedemption =
        hasLoyaltyModule &&
        orderData.loyalty_redemption &&
        typeof orderData.loyalty_redemption === 'object'
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
      const discountAmount = Math.max(
        0,
        Number(
          orderData.total_discount_amount ??
            manualDiscountAmount + loyaltyDiscountAmount,
        ),
      );

      // Prices are entered gross for Greece, so VAT is extracted from the discounted amount.
      const subtotalAfterDiscount = orderData.total; // Already includes discount
      const taxDivisor = 1 + taxRatePercentage / 100;
      const tax =
        taxDivisor > 0
          ? Math.round((subtotalAfterDiscount - subtotalAfterDiscount / taxDivisor) * 100) / 100
          : 0;
      const tipAmount = Math.max(
        0,
        Number(orderData.paymentData?.tipAmount ?? orderData.paymentData?.tip_amount ?? 0) || 0,
      );
      const requestedTipRecipientRole = String(
        orderData.paymentData?.tipRecipientRole || '',
      );
      const tipRecipientRole: 'waiter' | 'cashier' | 'driver' | undefined =
        tipAmount > 0 &&
        ['waiter', 'cashier', 'driver'].includes(requestedTipRecipientRole)
          ? (requestedTipRecipientRole as 'waiter' | 'cashier' | 'driver')
          : undefined;
      const actualWaiterId =
        selectedTable?.currentWaiterId || staff?.staffId || undefined;
      const actualWaiterShiftId =
        actualWaiterId && actualWaiterId === staff?.staffId
          ? activeShift?.id
          : undefined;
      const tipRecipientStaffId =
        tipRecipientRole === 'waiter' ? actualWaiterId : undefined;
      const tipRecipientStaffShiftId =
        tipRecipientRole === 'waiter' ? actualWaiterShiftId : undefined;
      const total_amount = subtotalAfterDiscount + deliveryFee + tipAmount;
      const paymentMethod = typeof orderData.paymentData?.method === 'string'
        ? orderData.paymentData.method
        : null;
      const isRoomChargePayment = paymentMethod === 'room_charge';
      const roomId =
        orderData.paymentData?.roomId ||
        orderData.paymentData?.room_id ||
        orderData.roomId ||
        orderData.room_id ||
        null;
      const initialPayment =
        !isGhostOrder &&
        !isSplitPayment &&
        (paymentMethod === 'cash' || paymentMethod === 'card' || paymentMethod === 'room_charge' || paymentMethod === 'twint')
          ? {
              method: paymentMethod,
              payment_method: paymentMethod,
              amount: total_amount,
              cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
              changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
              transactionRef: orderData.paymentData.transactionId,
              idempotencyKey: orderData.paymentData.idempotencyKey,
              currency: orderData.paymentData.currency,
              metadata: orderData.paymentData.metadata,
              ...resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] }),
              collectedBy: ['cashier', 'manager'].includes(activeShift?.role_type ?? '') ? 'cashier_drawer' : undefined,
              tipAmount,
              tipRecipientRole,
              tipRecipientStaffId,
              tipRecipientStaffShiftId,
            }
          : undefined;

      // Warn if no active shift
      if (!isOperationalShiftActive) {
        toast(t('orderFlow.noActiveShift'), {
          duration: 3000,
          icon: <AlertTriangle className="w-4 h-4 text-white" />,
          style: { background: '#f59e0b', color: 'white' }
        });
      }

      const normalizedItems = normalizePosOrderItems(orderData.items);
      const invalidItems = normalizedItems.filter(
        (item: any) => !hasValidSyncedPosMenuItemId(item),
      );
      if (invalidItems.length > 0) {
        toast.error(
          t(
            'orderFlow.invalidCartItems',
            'Order cannot be created because some cart items are not synced menu items. Sync menu and try again.'
          )
        );
        setIsProcessingOrder(false);
        return false;
      }

      const existingOrderId = orderData.paymentData?.existingOrderId;
      if (existingOrderId && (paymentMethod === 'cash' || paymentMethod === 'card' || paymentMethod === 'twint')) {
        // Existing-order guard: continue the modal's claim or take the order's
        // ordinary claim before the first await of this write.
        const givenOwner: OrdinaryCollectionOwner | null = orderData.paymentData?.ordinaryOwner ?? null;
        const fallbackClaim = givenOwner ? null : claimOrdinaryCollectionOwner(collectionScope, existingOrderId);
        if (fallbackClaim && !fallbackClaim.claimed) {
          toast.error(ordinaryRefusalText(fallbackClaim.code));
          setIsProcessingOrder(false);
          return false;
        }
        const fallbackOwner = givenOwner ?? (fallbackClaim?.claimed ? fallbackClaim.owner : null);
        if (!fallbackOwner) {
          setIsProcessingOrder(false);
          return false;
        }
        let askBeforeFallbackPrint = false;
        let fallbackRun: OrdinaryCollectionRun<any>;
        try {
          askBeforeFallbackPrint = await shouldAskPaymentPrint();
          fallbackRun = await runOrdinaryCollection<any>(fallbackOwner, {
            method: paymentMethod,
            amount: total_amount,
            transactionRef: orderData.paymentData.transactionId ?? null,
            idempotencyKey: orderData.paymentData.idempotencyKey ?? null,
            settlementGeneration: null,
            terminalTransactionId: null,
          }, async () => {
            let raw: unknown;
            let threw = false;
            try {
              raw = await bridge.payments.recordPayment({
                orderId: existingOrderId,
                method: paymentMethod,
                amount: total_amount,
                cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
                changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
                transactionRef: orderData.paymentData.transactionId,
                idempotencyKey: orderData.paymentData.idempotencyKey,
                currency: orderData.paymentData.currency,
                metadata: orderData.paymentData.metadata,
                ...resolveAdjustmentAttribution({ databaseStaffId: staff?.databaseStaffId,
                  shiftStaffOwnerId: activeShift?.staff_id, staffShiftId: activeShift?.id, candidateStaffIds: [staff?.staffId] }),
              collectedBy: ['cashier', 'manager'].includes(activeShift?.role_type ?? '') ? 'cashier_drawer' : undefined,
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
          });
        } finally {
          // Ends a claim taken here only while nothing was sent under it.
          if (!givenOwner) releaseOrdinaryOwnerBeforeSend(fallbackOwner);
        }
        if (fallbackRun.status === 'refused') {
          throw new Error(ordinaryRefusalText(fallbackRun.code));
        }
        const paymentResult: any = fallbackRun.value;
        if (fallbackRun.status === 'unknown') {
          throw new Error(t('orderDashboard.collectPaymentFailed', { defaultValue: 'Failed to collect payment' }));
        }
        if (fallbackRun.status !== 'completed') {
          throw new Error(paymentResult?.error || 'Failed to record payment');
        }
        await silentRefresh().catch(() => {});
        void finalizeCreatedOrderPayment(existingOrderId, isGhostOrder, {
          askBeforePrint: askBeforeFallbackPrint,
          autoPrintSuppressed: askBeforeFallbackPrint,
          amount: total_amount,
        })
          .catch((printError: any) => {
            const stage = printError?.stage;
            if (isGhostOrder || stage === 'receipt') {
              console.error('[OrderFlow] Fallback receipt print error:', printError);
              toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' }));
              return undefined;
            }

            console.warn('[OrderFlow] Fallback fiscal print error (non-blocking):', printError);
            toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' }));
          });
        setIsProcessingOrder(false);
        return true;
      }

      const clientRequestId = takeCheckoutRequestId(orderData.clientRequestId);
      const askBeforeReceiptPrint =
        !isSplitPayment && (Boolean(initialPayment) || isGhostOrder)
          ? await shouldAskPaymentPrint()
          : false;

      const orderToCreate = {
        // API required fields
        customer_id: resolvePersistedCustomerId(selectedCustomer?.id),
        customerId: resolvePersistedCustomerId(selectedCustomer?.id),
        clientRequestId,
        items: normalizedItems,
        branch_id: effectiveBranchId,
        organization_id: organizationId || null,

        // Use total_amount instead of total (matching shared types)
        total_amount: total_amount,
        subtotal: subtotalAfterDiscount,
        tax_amount: tax,
        country_code: 'GR',
        pricing_mode: 'tax_inclusive',
        delivery_fee: deliveryFee,

        // Discount fields (matching shared types)
        discount_percentage: discountPercentage,
        discount_amount: discountAmount,
        tip_amount: tipAmount,

        status: 'pending' as const,
        payment_method: isGhostOrder || paymentMethod === 'table' ? null : (paymentMethod || null),
        room_id: isRoomChargePayment ? roomId : null,
        roomId: isRoomChargePayment ? roomId : null,
        initialPayment,
        skipAutoPrint: askBeforeReceiptPrint,
        skip_auto_print: askBeforeReceiptPrint,
        is_ghost: isGhostOrder,
        ghost_source: ghostSource,
        ghost_metadata: ghostMetadata,
        delivery_address: deliveryAddress,
        delivery_address_id: selectedAddress?.id || null,
        delivery_city: selectedAddress?.city || null,
        delivery_postal_code: selectedAddress?.postal_code || null,
        delivery_floor: selectedAddress?.floor_number || null,
        delivery_notes: selectedAddress?.notes || selectedAddress?.delivery_notes || null,
        delivery_latitude: selectedAddressCoordinates?.lat ?? null,
        delivery_longitude: selectedAddressCoordinates?.lng ?? null,
        delivery_address_fingerprint:
          selectedAddress?.address_fingerprint || selectedCustomer?.address_fingerprint || null,
        name_on_ringer: selectedCustomer?.name_on_ringer || selectedAddress?.name_on_ringer || null,
        notes: orderData.notes || null,

        // Delivery orders stay neutral until explicitly assigned later
        driver_id: undefined,

        // Delivery zone metadata
        delivery_zone_id: deliveryZoneId,
        zone_name: zoneName,
        estimated_delivery_time: estimatedDeliveryTime,
        delivery_zone_validation: effectiveDeliveryZoneInfo ? JSON.stringify({
          deliveryAvailable: effectiveDeliveryZoneInfo.deliveryAvailable,
          requiresManagerApproval: effectiveDeliveryZoneInfo.uiState?.requiresManagerApproval || false,
          validatedAt: new Date().toISOString()
        }) : null,

        // Additional fields for local storage compatibility
        // orderNumber is generated by Rust (ORD-DDMMYYYY-NNNNN)
        customerName: selectedCustomer?.name || '',
        customerPhone: selectedCustomer?.phone || '',
        orderType: selectedOrderType as 'pickup' | 'delivery' | 'dine-in',
        order_type: selectedOrderType as 'pickup' | 'delivery' | 'dine-in',
        ...buildOrderServiceTableMetadata({ orderType: selectedOrderType, tableId: selectedTable?.id,
          tableNumber, tableSessionId: selectedTable?.tableSessionId, guestCount: selectedTable?.guestCount || 1 }),
        paymentStatus: (
          isSplitPayment
            ? 'pending'
            : (initialPayment ? 'completed' : 'pending')
        ) as 'pending' | 'completed' | 'processing' | 'failed' | 'refunded',
        paymentTransactionId: orderData.paymentData?.transactionId || undefined,
        estimatedTime: 15,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),

        // Shift-related fields
        staff_shift_id: selectedOrderType === 'delivery' ? undefined : (activeShift?.id || null),
        staff_id: selectedOrderType === 'delivery' ? undefined : (staff?.staffId || null)
      };

      try {
        const resolvedBranchId = effectiveBranchId || await bridge.terminalConfig.getBranchId();
        const resolvedTerminalId = staff?.terminalId || await bridge.terminalConfig.getTerminalId();
        if (!resolvedTerminalId) {
          throw new Error('Missing branch or terminal id');
        }
        const activeCashier = await resolveActiveCashierShift({
          branchId: resolvedBranchId,
          terminalId: resolvedTerminalId,
          activeShift,
          logContext: 'OrderFlow',
        });
        if (!activeCashier) {
          toast.error(t('orderFlow.noActiveCashierShift') || 'Cannot create orders until a cashier opens the day.');
          setIsProcessingOrder(false);
          return false;
        }
      } catch (err) {
        console.error('Failed to verify active cashier shift', err);
        toast.error(t('orderFlow.noActiveCashierShift') || 'Cannot create orders until a cashier opens the day.');
        setIsProcessingOrder(false);
        return false;
      }

      const result = await createOrder(orderToCreate);

      if (result.success) {
        orderPersisted = true;
        // The order exists: the next checkout is a new one.
        resetCheckoutRequestId();
        const displayOrderNumber = result.orderNumber || result.orderId || '';

        const roomCharge = (result as any).roomCharge;
        if (isRoomChargePayment && orderData.paymentData) orderData.paymentData.roomChargeApplied = roomCharge?.applied === true;
        if (isRoomChargePayment && roomCharge?.applied === false && result.orderId) {
          await silentRefresh().catch(() => {});
          orderData.paymentData.existingOrderId = result.orderId;
          orderData.paymentData.existingOrderNumber = result.orderNumber;
          orderData.paymentData.roomChargeFallback = true;
          orderData.paymentData.roomChargeFallbackReason =
            roomCharge.code || roomCharge.error || 'room_charge_not_applied';
          setIsProcessingOrder(false);
          return false;
        }

        toast.success(t('orderFlow.orderCreated', { orderNumber: displayOrderNumber }));

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
                if (!res?.success) {
                  throw new Error(res?.error || 'Loyalty redemption failed');
                }
              })
              .catch((error: any) => {
                console.warn('[OrderFlow] Loyalty redemption failed:', error);
                toast.error(
                  t('loyalty.redeemFailed', {
                    defaultValue: 'Order saved, but loyalty points were not redeemed',
                  }),
                );
              });
          }
        }

        // Track order + discount application
        try {
          ActivityTracker.trackOrderCreated(result.orderId || displayOrderNumber, total_amount)
          ActivityTracker.trackDiscount(Boolean(discountAmount), discountAmount, discountPercentage)
        } catch {}

        if (result.orderId && isSplitPayment) {
          setSplitPaymentData({
            orderId: result.orderId,
            orderTotal: total_amount,
            items: buildSplitPaymentItems({
              items: (orderData.items || []).map((item: any, index: number) => ({
                name: item.name || 'Item',
                quantity: item.quantity || 1,
                price: item.unitPrice || item.price || 0,
                totalPrice: item.totalPrice || ((item.unitPrice || item.price || 0) * (item.quantity || 1)),
                itemIndex: item.itemIndex ?? index,
              })),
              orderTotal: total_amount,
              deliveryFee,
              discountAmount,
              deliveryFeeLabel: t('payment.fields.deliveryFee', { defaultValue: 'Delivery Fee' }),
              discountLabel: t('modals.payment.discount', { defaultValue: 'Discount' }),
              adjustmentLabel: t('splitPayment.adjustment', { defaultValue: 'Adjustment' }),
            }),
            isGhostOrder,
            orderNumber: result.orderNumber,
            orderType: selectedOrderType === 'delivery' ? 'delivery' : 'pickup',
            tipAmount,
            tipRecipientRole,
            tipRecipientStaffId,
            tipRecipientStaffShiftId,
          });
          setIsMenuModalOpen(false);
          await silentRefresh().catch(() => {});
          return true;
        }

        if (initialPayment) {
          await silentRefresh().catch(() => {});
        }

        // Cash register / fiscal print (fire-and-forget, non-blocking)
        if (result.orderId) {
          finalizeCreatedOrderPayment(result.orderId, isGhostOrder, {
            askBeforePrint: askBeforeReceiptPrint,
            autoPrintSuppressed: askBeforeReceiptPrint,
            amount: total_amount,
            orderNumber: result.orderNumber || null,
          })
            .catch((printError: any) => {
              const stage = printError?.stage;
              if (isGhostOrder || stage === 'receipt') {
                console.error('[OrderFlow] Ghost receipt print error:', printError);
                toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' }));
                return undefined;
              }

              console.warn('[OrderFlow] Cash register print error (non-blocking):', printError);
              toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' }));
            });
        }

        // Additional success feedback for delivery orders
        if (selectedOrderType === 'delivery' && deliveryAddress) {
          setTimeout(() => {
            toast.success(t('orderFlow.deliveryTo', { address: deliveryAddress }), { duration: 4000 });
          }, 1000);
        }

        resetFlow();
        return true;
      } else if (result.paymentNotSaved) {
        // Item E: the card was charged and the order could not be saved
        // yet. The till holds the order and its payment; the checkout ends
        // here (a retry from this cart would be a new checkout and a second
        // charge) and the dashboard banner offers "Save payment again".
        notifyPaymentNotSaved(result, t);
        announceUnsavedCheckoutChanged();
        const outcome = resolveOrderCompletionOutcome({
          succeeded: false,
          orderPersisted,
          chargedNotSaved: true,
        });
        if (outcome.resetOrderUiState) {
          resetFlow();
        }
        return outcome.completionResult;
      } else if (isCheckoutOutcomeUnknown(result)) {
        // The payment has no answer yet (fix review 30/09/2026): the cart
        // and its checkout id stay, so Pay again checks the same payment.
        notifyCheckoutOutcomeUnknown(result, t);
        return false;
      } else {
        toast.error(t('orderFlow.orderFailed'));
        if ('error' in result) {
          console.error('Order creation failed:', result.error);
        }
        return false;
      }
    } catch (error) {
      console.error('Error creating order:', error);
      toast.error(t('orderFlow.orderFailed'));
      // If the order persisted before the throw, the cart must still clear —
      // retrying from a stale cart would duplicate the order.
      return resolveOrderCompletionOutcome({ succeeded: false, orderPersisted })
        .completionResult;
    } finally {
      setIsProcessingOrder(false);
    }
  }, [selectedCustomer, selectedOrderType, selectedAddress, deliveryZoneInfo, createOrder, resetFlow, activeShift, isOperationalShiftActive, staff, taxRatePercentage, reloadTerminalSettings, effectiveBranchId, organizationId, hasLoyaltyModule, t, silentRefresh, finalizeCreatedOrderPayment, shouldAskPaymentPrint, collectionScope, ordinaryRefusalText, takeCheckoutRequestId, resetCheckoutRequestId, selectedTable, tableNumber]);

  // Order-type chooser ergonomics aligned with the main OrderDashboard modal (Round 346): modal width + grid
  // scale to the number of visible cards (pickup always present; delivery/tables optional), and each card
  // exposes a localized title/description + composed aria-label.
  const visibleOrderTypeCardCount = 1 + (hasDeliveryModule ? 1 : 0) + (hasTablesModule ? 1 : 0);
  const orderTypeModalWidthClass =
    visibleOrderTypeCardCount === 3
      ? '!max-w-3xl'
      : visibleOrderTypeCardCount === 2
        ? '!max-w-xl'
        : '!max-w-lg';
  const orderTypeGridColsClass =
    visibleOrderTypeCardCount === 3
      ? 'grid-cols-1 sm:grid-cols-3'
      : visibleOrderTypeCardCount === 2
        ? 'grid-cols-2'
        : 'grid-cols-1';
  const deliveryTitle = t('orderFlow.deliveryOrder');
  const deliveryDescription = t('modals.orderTypeSelection.deliveryDescription');
  const pickupTitle = t('orderFlow.pickupOrder');
  const pickupDescription = t('modals.orderTypeSelection.pickupDescription');
  const tableTitle = t('orderFlow.tableOrder');
  const tableDescription = t('orderFlow.tableDescription');

  return (
    <div className={`order-flow ${className}`}>
      {/* Floating Action Button for New Order - hidden when order creation is disabled */}
      {showFab && canCreateOrders && (
        <FloatingActionButton
          onClick={handleStartNewOrder}
          disabled={!isOperationalShiftActive}
          aria-label={!isOperationalShiftActive ? t('orders.startShiftFirst', 'Start a shift first to create orders') : t('orderFlow.startNewOrder')}
          className={!isOperationalShiftActive ? 'bg-gray-400 cursor-not-allowed opacity-50' : ''}
        />
      )}

      {/* Order Type Selection Modal */}
      <LiquidGlassModal
        isOpen={isOrderTypeModalOpen}
        onClose={() => setIsOrderTypeModalOpen(false)}
        title={t('orderFlow.selectOrderType')}
        className={`${orderTypeModalWidthClass} order-type-transparent-modal`}
        contentClassName="!p-0 !overflow-visible"
      >
        <div className="p-2">
          {isTransitioning ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-b-yellow-500 dark:border-white/20 dark:border-b-yellow-400"></div>
              <span className="ml-3 liquid-glass-modal-text-muted">{t('orderFlow.settingUpOrder')}</span>
            </div>
          ) : (
            <div className={`grid gap-4 sm:gap-5 ${orderTypeGridColsClass}`}>
              {/* Delivery Button - Yellow (only if Delivery module acquired) */}
              {hasDeliveryModule && (
                <button
                  type="button"
                  data-order-type-card="delivery"
                  onClick={() => handleSelectOrderType('delivery')}
                  aria-label={composeOrderTypeAriaLabel(deliveryTitle, deliveryDescription)}
                  className="relative p-6 rounded-2xl border-2 border-[#facc15]/45 bg-[linear-gradient(135deg,rgba(250,204,21,0.16),rgba(234,179,8,0.06))] transition-transform duration-150 active:scale-95"
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      <svg className="w-full h-full text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
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
                onClick={() => handleSelectOrderType('pickup')}
                aria-label={composeOrderTypeAriaLabel(pickupTitle, pickupDescription)}
                className="relative p-6 rounded-2xl border-2 border-[#34d399]/45 bg-[linear-gradient(135deg,rgba(52,211,153,0.16),rgba(22,163,74,0.06))] transition-transform duration-150 active:scale-95"
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
                  onClick={() => handleSelectOrderType('dine-in')}
                  aria-label={composeOrderTypeAriaLabel(tableTitle, tableDescription)}
                  className="relative p-6 rounded-2xl border-2 border-[#60a5fa]/45 bg-[linear-gradient(135deg,rgba(96,165,250,0.16),rgba(37,99,235,0.06))] transition-transform duration-150 active:scale-95"
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
            </div>
          )}
        </div>
      </LiquidGlassModal>

      {/* Customer Search Modal */}
      <CustomerSearchModal
        isOpen={isCustomerSearchModalOpen}
        onClose={() => setIsCustomerSearchModalOpen(false)}
        onCustomerSelected={handleCustomerSelected}
        onAddNewCustomer={handleAddNewCustomer}
        onAddNewAddress={handleAddNewAddress}
        onEditCustomer={handleEditCustomer}
        initialCustomer={selectedCustomer}
      />

      {/* Add Customer Modal - also used for editing and adding new addresses */}
      <AddCustomerModal
        isOpen={isAddCustomerModalOpen}
        onClose={() => {
          // A re-pick closed without saving keeps the order's customer,
          // address and cart: only the editor state is reset.
          menuAddressRepickRef.current = false;
          setIsAddCustomerModalOpen(false);
          setCustomerToEdit(null);
          setCustomerModalMode('new');
        }}
        onCustomerAdded={customerModalMode === 'addAddress' ? handleAddressAdded : handleCustomerAdded}
        initialPhone={newCustomerInitialPhone}
        initialCustomer={customerToEdit || undefined}
        mode={customerModalMode}
      />



      {/* Zone Validation Alert - Displayed when delivery zone validation requires attention */}
      {showZoneAlert && deliveryZoneInfo && selectedAddress && (
        <LiquidGlassModal
          isOpen={showZoneAlert}
          onClose={() => setShowZoneAlert(false)}
          title={t('orderFlow.deliveryZoneValidation')}
          className="!max-w-lg"
        >
          <ZoneValidationAlert
            validationResult={deliveryZoneInfo}
            onOverride={() => {
              (async () => {
                const res = await requestOverride(t('orderFlow.overrideRequested'));
                if (res.approved) {
                  handleOverrideApproved();
                } else {
                  toast.error(res.message || t('orderFlow.overrideRequiresApproval'));
                }
              })();
            }}
            onChangeAddress={handleChangeAddress}
            onSwitchToPickup={handleSwitchToPickup}
          />
        </LiquidGlassModal>
      )}

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

      {/* Order Modal - Shows MenuModal for food verticals, ProductCatalogModal for retail */}
      {isMenuModalOpen && selectedOrderType && selectedCustomer && (
        isRetailVertical ? (
          <ProductCatalogModal
            isOpen={isMenuModalOpen}
            onClose={handleMenuModalClose}
            selectedCustomer={selectedCustomer}
            selectedAddress={selectedAddress}
            orderType={selectedOrderType === 'delivery' ? 'delivery' : 'pickup'}
            deliveryZoneInfo={deliveryZoneInfo}
            onOrderComplete={handleOrderComplete}
            isProcessingOrder={isProcessingOrder}
            onRepickDeliveryAddress={handleRepickDeliveryAddress}
          />
        ) : (
          <MenuModal
            draftContext={{ selectedTable, tableNumber, deliveryZoneInfo, ...restoredEditContext }}
            onDraftRestore={restoreDraftContext}
            onRecoveredOrder={acceptRecoveredDraftOrder}
            editMode={!!restoredEditContext}
            editOrderId={restoredEditContext?.editOrderId}
            editSupabaseId={restoredEditContext?.editSupabaseId}
            editSourceOrderType={restoredEditContext?.editSourceOrderType}
            editHeaders={restoredEditContext?.editHeaders}
            onEditPreflight={preflightRecoveredEdit}
            onEditComplete={completeRecoveredEdit}
            isOpen={isMenuModalOpen}
            onClose={handleMenuModalClose}
            selectedCustomer={selectedCustomer}
            selectedAddress={selectedAddress}
            orderType={selectedOrderType}
            deliveryZoneInfo={deliveryZoneInfo}
            onOrderComplete={handleOrderComplete}
            isProcessingOrder={isProcessingOrder}
            onRepickDeliveryAddress={handleRepickDeliveryAddress}
          />
        )
      )}

      <EditSettlementDeltaModal isOpen={recoveredEditPrompt !== null}
        mode={recoveredEditPrompt?.preview.requiredAction === 'refund' ? 'refund' : 'collect'}
        amount={recoveredEditPrompt?.amount ?? 0} onConfirm={confirmRecoveredEdit}
        onCancel={() => { recoveredEditPrompt?.reject(new Error('EDIT_SETTLEMENT_CANCELLED')); setRecoveredEditPrompt(null); }} />

      {splitPaymentData && (
        <SplitPaymentModal
          isOpen={true}
          onClose={handleSplitClose}
          key={`${splitPaymentData.orderId}:${splitPaymentData.recoverySession ?? 0}`}
          orderId={splitPaymentData.orderId}
          orderTotal={splitPaymentData.orderTotal}
          items={splitPaymentData.items}
          existingPayments={splitPaymentData.existingPayments}
          initialMode="by-items"
          isGhostOrder={splitPaymentData.isGhostOrder}
          isReconciliationPending={isReconcilingSplitClose}
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
            <div key={entry.orderId} role="status" className="liquid-glass-modal-card flex items-center gap-3 rounded-2xl px-4 py-3 text-sm">
              <span className="liquid-glass-modal-text">
                {entry.orderNumber ? `#${entry.orderNumber} · ` : ''}
                {t('giftCardCheckout.refusal.fiscalPending', 'A receipt for this order is still pending. Check the receipt first.')}
              </span>
              <button type="button" className="liquid-glass-modal-button" onClick={() => reenterGiftReceipt(entry.orderId)}>
                {t('giftCardCheckout.checkAgain', 'Check again')}
              </button>
            </div>
          ))}
        </div>
      )}
      {paymentPrintPromptModal}
    </div>
  );
});

OrderFlow.displayName = 'OrderFlow';

export default OrderFlow;

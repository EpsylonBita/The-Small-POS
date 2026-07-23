import { memo, useState, useCallback, useEffect } from 'react';
import { LiquidGlassModal } from './ui/pos-glass-components';
import { MenuModal } from './modals/MenuModal';
import { ProductCatalogModal } from './modals/ProductCatalogModal';
import { CustomerSearchModal } from './modals/CustomerSearchModal';
import { AddCustomerModal } from './modals/AddCustomerModal';
import { SplitPaymentModal } from './modals/SplitPaymentModal';
import type { SplitPaymentResult } from './modals/SplitPaymentModal';
import { ZoneValidationAlert } from './delivery/ZoneValidationAlert';
import { FloatingActionButton } from './ui/FloatingActionButton';
import { TableSelector, TableActionModal, ReservationForm } from './tables';
import type { CreateReservationDto } from './tables';
import {
  buildChangedReservationUpdate,
  reservationsService,
  type Reservation,
} from '../services/ReservationsService';
import { useOrderStore } from '../hooks/useOrderStore';
import { useShift } from '../contexts/shift-context';
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
import { toLocalDateString } from '../utils/date';
import { formatTableDisplayNumber } from '../utils/table-display';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { usePaymentPrintPrompt, type PaymentPrintPromptContext } from '../hooks/usePaymentPrintPrompt';
import { AlertTriangle } from 'lucide-react';
import TableOrderIcon from './icons/TableOrderIcon';
import PickupOrderIcon from './icons/PickupOrderIcon';
import { resolveDeliveryFee } from '../utils/delivery-fee';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials';
import { getBridge, offEvent, onEvent } from '../../lib';
import { buildSplitPaymentItems } from '../utils/splitPaymentItems';
import type { SplitPaymentItem } from '../utils/splitPaymentItems';
import { resolvePersistedCustomerId } from '../utils/persisted-customer-id';
import { resolveOrderCompletionOutcome } from '../utils/orderCompletionOutcome';
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


interface OrderFlowProps {
  className?: string;
  /** Force retail mode - always show ProductCatalogModal instead of MenuModal */
  forceRetailMode?: boolean;
  /** Hide the floating action button when a parent screen already owns the entry point */
  showFab?: boolean;
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

const toLatLngCoordinates = (
  coordinates:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null
    | undefined,
  latitude?: number | null,
  longitude?: number | null,
): { lat: number; lng: number } | null => {
  if (
    coordinates &&
    'lat' in coordinates &&
    Number.isFinite(coordinates.lat) &&
    Number.isFinite(coordinates.lng)
  ) {
    return { lat: Number(coordinates.lat), lng: Number(coordinates.lng) };
  }
  if (
    coordinates &&
    'type' in coordinates &&
    coordinates.type === 'Point' &&
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
    return { lat: Number(latitude), lng: Number(longitude) };
  }
  return null;
};

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

const OrderFlow = memo<OrderFlowProps>(({ className = '', forceRetailMode = false, showFab = true }) => {
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
  } | null>(null);

  // Customer modal mode: 'new' | 'edit' | 'addAddress' | 'editAddress'
  const [customerModalMode, setCustomerModalMode] = useState<'new' | 'edit' | 'addAddress' | 'editAddress'>('new');
  // Customer for editing or adding address in AddCustomerModal
  const [customerToEdit, setCustomerToEdit] = useState<Customer | null>(null);

  // Order flow states
  const [selectedOrderType, setSelectedOrderType] = useState<'pickup' | 'delivery' | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<any>(null);
  const [deliveryZoneInfo, setDeliveryZoneInfo] = useState<DeliveryBoundaryValidationResponse | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isProcessingOrder, setIsProcessingOrder] = useState(false);
  const [taxRatePercentage, setTaxRatePercentage] = useState<number>(24); // Default Greek VAT

  // Zone validation alert states
  const [showZoneAlert, setShowZoneAlert] = useState(false);
  const [overrideApproved, setOverrideApproved] = useState(false);

  // Order store for managing orders
  const { createOrder, silentRefresh } = useOrderStore();

  // Shift context for linking orders to shifts
  const { staff, activeShift, isShiftActive } = useShift();
  const { requestOverride } = useDeliveryValidation();

  // Module-based feature flags
  const { hasDeliveryModule, hasTablesModule, hasModule } = useAcquiredModules();
  const hasLoyaltyModule = hasModule(MODULE_IDS.LOYALTY);

  // Get organizationId and businessType from module context (with credential cache fallback)
  const { organizationId: moduleOrgId, businessType } = useModules();
  const {
    branchId: resolvedIdentityBranchId,
    organizationId: resolvedIdentityOrganizationId,
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

  // Fetch tax rate from terminal settings; auto-updates on settings change
  const { getSetting } = useTerminalSettings();
  useEffect(() => {
    const rawRate = getSetting<number | string>('tax', 'tax_rate_percentage', 24);
    const rate = Number(rawRate);
    if (Number.isFinite(rate) && rate >= 0 && rate <= 100) {
      setTaxRatePercentage(rate);
    } else {
      setTaxRatePercentage(24);
    }
  }, [getSetting]);

  // Reset all flow states
  const resetFlow = useCallback(() => {
    setIsOrderTypeModalOpen(false);
    setIsCustomerSearchModalOpen(false);
    setIsAddCustomerModalOpen(false);
    setIsMenuModalOpen(false);
    setSplitPaymentData(null);
    setSelectedOrderType(null);
    setSelectedCustomer(null);
    setSelectedAddress(null);
    setDeliveryZoneInfo(null);
    setIsTransitioning(false);
    setShowZoneAlert(false);
    setOverrideApproved(false);
  }, []);

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
      coordinates:
        nextAddress?.coordinates ||
        customer.coordinates ||
        (Number.isFinite(customer.latitude) && Number.isFinite(customer.longitude)
          ? { lat: Number(customer.latitude), lng: Number(customer.longitude) }
          : undefined),
      latitude: nextAddress?.latitude ?? customer.latitude ?? null,
      longitude: nextAddress?.longitude ?? customer.longitude ?? null,
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

  const handleCustomerAdded = useCallback((newCustomer: Customer) => {
    const wasEditing = !!customerToEdit;
    const wasEditingAddress = customerModalMode === 'editAddress';
    const wasAddingAddress = customerModalMode === 'addAddress';
    
    setSelectedCustomer(newCustomer);
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
  }, [t, customerToEdit, customerModalMode]);

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

  const handleSplitClose = useCallback(() => {
    setSplitPaymentData(null);
    resetFlow();
    void silentRefresh().catch(() => {});
  }, [resetFlow, silentRefresh]);

  const handleSplitComplete = useCallback(async (_result: SplitPaymentResult) => {
    setSplitPaymentData(null);
    resetFlow();
    await silentRefresh().catch(() => {});
  }, [resetFlow, silentRefresh]);

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
      setSelectedOrderType('pickup'); // Table orders use pickup pricing
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
      toast.error(t('orderFlow.missingContext') || 'Missing branch or organization context');
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
      toast.error(t('orderFlow.missingContext') || 'Missing branch or organization context');
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
      toast.error(t('orderFlow.missingContext') || 'Missing branch or organization context');
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

  // Handle reservation form submission
  const handleReservationSubmit = useCallback(async (data: CreateReservationDto) => {
    const reservationBranchId = effectiveBranchId || branchId;
    if (!reservationBranchId || !organizationId) {
      toast.error(t('orderFlow.missingContext') || 'Missing branch or organization context');
      return;
    }
    
    try {
      // Set context for the service with actual IDs
      reservationsService.setContext(reservationBranchId, organizationId);
      
      // Format date and time from the Date object
      const reservationDate = toLocalDateString(data.reservationTime);
      const reservationTime = data.reservationTime.toTimeString().slice(0, 5);

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

        toast.success(t('orderFlow.reservationUpdated', { defaultValue: 'Reservation updated successfully' }));
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
      
      toast.success(t('orderFlow.reservationCreated') || 'Reservation created successfully');
      setShowReservationForm(false);
      setSelectedTable(null);
      await refetchTables();
    } catch (error) {
      console.error('Failed to create reservation:', error);
      const reservationUpdateError = error instanceof Error && error.message.trim()
        ? error.message
        : typeof error === 'string' && error.trim()
          ? error
          : null;
      toast.error(
        editingReservation
          ? reservationUpdateError ||
            t('orderFlow.reservationUpdateFailed', {
              defaultValue: 'Failed to update reservation',
            })
          : t('orderFlow.reservationFailed', {
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
        : toLatLngCoordinates(
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
        (paymentMethod === 'cash' || paymentMethod === 'card' || paymentMethod === 'room_charge')
          ? {
              method: paymentMethod,
              payment_method: paymentMethod,
              amount: total_amount,
              cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
              changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
              transactionRef: orderData.paymentData.transactionId,
              staffId: selectedOrderType === 'delivery' ? undefined : staff?.staffId,
              staffShiftId: selectedOrderType === 'delivery' ? undefined : activeShift?.id,
              tipAmount,
              tipRecipientRole,
              tipRecipientStaffId,
              tipRecipientStaffShiftId,
            }
          : undefined;

      // Warn if no active shift
      if (!isShiftActive) {
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
      if (existingOrderId && (paymentMethod === 'cash' || paymentMethod === 'card')) {
        const askBeforeFallbackPrint = await shouldAskPaymentPrint();
        const paymentResult: any = await bridge.payments.recordPayment({
          orderId: existingOrderId,
          method: paymentMethod,
          amount: total_amount,
          cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
          changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
          transactionRef: orderData.paymentData.transactionId,
          staffId: selectedOrderType === 'delivery' ? undefined : staff?.staffId,
          staffShiftId: selectedOrderType === 'delivery' ? undefined : activeShift?.id,
          tipAmount,
          tipRecipientRole,
          tipRecipientStaffId,
          tipRecipientStaffShiftId,
        });
        if (paymentResult?.success === false) {
          throw new Error(paymentResult.error || 'Failed to record payment');
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

      const clientRequestId =
        globalThis.crypto?.randomUUID?.() ??
        `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
        payment_method: isGhostOrder ? null : (paymentMethod || null),
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
        orderType: selectedOrderType as 'pickup' | 'delivery',
        paymentStatus: (
          isSplitPayment
            ? 'pending'
            : (orderData.paymentData ? 'completed' : 'pending')
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
        const displayOrderNumber = result.orderNumber || result.orderId || '';

        const roomCharge = (result as any).roomCharge;
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
  }, [selectedCustomer, selectedOrderType, selectedAddress, deliveryZoneInfo, createOrder, resetFlow, activeShift, isShiftActive, staff, taxRatePercentage, effectiveBranchId, organizationId, hasLoyaltyModule, t, silentRefresh, finalizeCreatedOrderPayment, shouldAskPaymentPrint]);

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
          disabled={!isShiftActive}
          aria-label={!isShiftActive ? t('orders.startShiftFirst', 'Start a shift first to create orders') : t('orderFlow.startNewOrder')}
          className={!isShiftActive ? 'bg-gray-400 cursor-not-allowed opacity-50' : ''}
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
        <div>
          {isTransitioning ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
              <span className="ml-3 text-white/70">{t('orderFlow.settingUpOrder')}</span>
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
            orderType={selectedOrderType}
            deliveryZoneInfo={deliveryZoneInfo}
            onOrderComplete={handleOrderComplete}
            isProcessingOrder={isProcessingOrder}
          />
        ) : (
          <MenuModal
            isOpen={isMenuModalOpen}
            onClose={handleMenuModalClose}
            selectedCustomer={selectedCustomer}
            selectedAddress={selectedAddress}
            orderType={selectedOrderType}
            deliveryZoneInfo={deliveryZoneInfo}
            onOrderComplete={handleOrderComplete}
            isProcessingOrder={isProcessingOrder}
          />
        )
      )}

      {splitPaymentData && (
        <SplitPaymentModal
          isOpen={true}
          onClose={handleSplitClose}
          orderId={splitPaymentData.orderId}
          orderTotal={splitPaymentData.orderTotal}
          items={splitPaymentData.items}
          initialMode="by-items"
          isGhostOrder={splitPaymentData.isGhostOrder}
          onSplitComplete={handleSplitComplete}
        />
      )}
      {paymentPrintPromptModal}
    </div>
  );
});

OrderFlow.displayName = 'OrderFlow';

export default OrderFlow;

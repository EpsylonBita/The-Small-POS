import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import { useOrderStore } from '../hooks/useOrderStore';
import { useShift } from '../contexts/shift-context';
import type { OrderItem } from '../types/orders';
import type { Customer, CustomerInfo } from '../types/customer';
import OrderGrid from './OrderGrid';
import OrderTabsBar, { type TabId } from './OrderTabsBar';
import BulkActionsBar from './BulkActionsBar';
import DriverAssignmentModal from './modals/DriverAssignmentModal';
import OrderCancellationModal from './modals/OrderCancellationModal';
import EditOptionsModal from './modals/EditOptionsModal';
import EditPaymentMethodModal from './modals/EditPaymentMethodModal';
import { EditCustomerInfoModal } from './modals/EditCustomerInfoModal';
import EditOrderItemsModal from './modals/EditOrderItemsModal';
import { CustomerSearchModal } from './modals/CustomerSearchModal';
import { CustomerInfoModal } from './modals/CustomerInfoModal';
import { AddCustomerModal } from './modals/AddCustomerModal';
import { MenuModal } from './modals/MenuModal';
import { OrderApprovalPanel } from './order/OrderApprovalPanel';
import { OrderConflictBanner } from './OrderConflictBanner';
import { LiquidGlassModal } from './ui/pos-glass-components';
import { TableSelector, TableActionModal, ReservationForm } from './tables';
import type { CreateReservationDto } from './tables';
import { reservationsService } from '../services/ReservationsService';
import { PrintPreviewModal } from './modals/PrintPreviewModal';
import { Plus } from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useI18n } from '../contexts/i18n-context';
import { useAcquiredModules } from '../hooks/useAcquiredModules';
import { useTables } from '../hooks/useTables';
import { useModules } from '../contexts/module-context';
import toast from 'react-hot-toast';
import { OrderDashboardSkeleton } from './skeletons';
import { ErrorDisplay } from './error';
import type { Order } from '../types/orders';
import type { RestaurantTable, TableStatus } from '../types/tables';
import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import { useDeliveryValidation } from '../hooks/useDeliveryValidation';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { openExternalUrl } from '../utils/electron-api';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials';
import { couponRedemptionService } from '../services/CouponRedemptionService';
import { getBridge, offEvent, onEvent } from '../../lib';

interface OrderDashboardProps {
  className?: string;
  orderFilter?: (order: Order) => boolean;
}

export const OrderDashboard = memo<OrderDashboardProps>(({ className = '', orderFilter }) => {
  const bridge = getBridge();
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const {
    orders,
    pendingExternalOrders,
    filter,
    setFilter,
    isLoading,
    updateOrderStatus,
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
    createOrder
  } = useOrderStore();

  const scopedPendingExternalOrders = React.useMemo(() => (
    orderFilter ? pendingExternalOrders.filter(orderFilter) : pendingExternalOrders
  ), [pendingExternalOrders, orderFilter]);

  // Module-based feature flags
  const { hasDeliveryModule, hasTablesModule } = useAcquiredModules();

  // Delivery validation hook
  const { validateAddress: validateDeliveryAddress } = useDeliveryValidation();

  // Get organizationId from module context (with terminal cache fallback)
  const { organizationId: moduleOrgId } = useModules();
  const {
    branchId: resolvedIdentityBranchId,
    organizationId: resolvedIdentityOrganizationId,
  } = useResolvedPosIdentity('branch+organization');

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
  const effectiveBranchId = resolvedIdentityBranchId || branchId;

  // Fetch tables for the Tables tab - use actual IDs
  // Only enable fetching when both IDs are available
  const { tables } = useTables({
    branchId: effectiveBranchId || '',
    organizationId: organizationId || '',
    enabled: Boolean(effectiveBranchId && organizationId)
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
  const [selectionType, setSelectionType] = useState<'pickup' | 'delivery' | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('orders');

  // State for table order flow
  const [showTableSelector, setShowTableSelector] = useState(false);
  const [showTableActionModal, setShowTableActionModal] = useState(false);
  const [showReservationForm, setShowReservationForm] = useState(false);
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [isOrderTypeTransitioning, setIsOrderTypeTransitioning] = useState(false);

  // State for modals
  const [showDriverModal, setShowDriverModal] = useState(false);
  const [pendingDeliveryOrders, setPendingDeliveryOrders] = useState<string[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [pendingCancelOrders, setPendingCancelOrders] = useState<string[]>([]);
  const [showApprovalPanel, setShowApprovalPanel] = useState(false);
  const [selectedOrderForApproval, setSelectedOrderForApproval] = useState<Order | null>(null);
  const [isViewOnlyMode, setIsViewOnlyMode] = useState(true); // View-only mode for order details (no approve/decline)

  // State for edit modals
  const [showEditOptionsModal, setShowEditOptionsModal] = useState(false);
  const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
  const [showEditOrderModal, setShowEditOrderModal] = useState(false);
  const [showEditMenuModal, setShowEditMenuModal] = useState(false); // New: Menu-based edit modal
  const [showEditPaymentModal, setShowEditPaymentModal] = useState(false);
  const [isUpdatingPaymentMethod, setIsUpdatingPaymentMethod] = useState(false);
  const [editPaymentTarget, setEditPaymentTarget] = useState<{
    orderId: string;
    orderNumber?: string;
    currentMethod: 'cash' | 'card';
    paymentStatus: string;
  } | null>(null);
  const [pendingEditOrders, setPendingEditOrders] = useState<string[]>([]);
  const [editingSingleOrder, setEditingSingleOrder] = useState<string | null>(null);
  const [editingOrderType, setEditingOrderType] = useState<'pickup' | 'delivery'>('pickup'); // Track order type for editing
  // Store edit order details separately to persist while modal is open
  const [currentEditOrderId, setCurrentEditOrderId] = useState<string | undefined>(undefined);
  const [currentEditOrderNumber, setCurrentEditOrderNumber] = useState<string | undefined>(undefined);
  const [currentEditSupabaseId, setCurrentEditSupabaseId] = useState<string | undefined>(undefined);

  // State for new order flow
  const [showOrderTypeModal, setShowOrderTypeModal] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [selectedOrderType, setSelectedOrderType] = useState<'pickup' | 'delivery' | null>(null);

  // State for delivery flow
  const [showPhoneLookupModal, setShowPhoneLookupModal] = useState(false);
  const [showCustomerInfoModal, setShowCustomerInfoModal] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [customerModalMode, setCustomerModalMode] = useState<'new' | 'edit' | 'addAddress'>('new');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [existingCustomer, setExistingCustomer] = useState<Customer | null>(null);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [orderType, setOrderType] = useState<'dine-in' | 'pickup' | 'delivery'>('pickup');
  const [tableNumber, setTableNumber] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [isValidatingAddress, setIsValidatingAddress] = useState(false);
  const [addressValid, setAddressValid] = useState(false);
  const [deliveryZoneInfo, setDeliveryZoneInfo] = useState<DeliveryBoundaryValidationResponse | null>(null);

  // Receipt preview state
  const [receiptPreviewHtml, setReceiptPreviewHtml] = useState<string | null>(null);
  const [showReceiptPreview, setShowReceiptPreview] = useState(false);
  const [receiptPreviewOrderId, setReceiptPreviewOrderId] = useState<string | null>(null);
  const [receiptPreviewPrinting, setReceiptPreviewPrinting] = useState(false);

  // Bulk action loading state
  const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);

  // Refs for click-outside detection to auto-close bulk actions bar
  const bulkActionsBarRef = useRef<HTMLDivElement>(null);
  const orderGridRef = useRef<HTMLDivElement>(null);
  const alertTimeoutRef = useRef<number | null>(null);
  const alertingOrderIdRef = useRef<string | null>(null);
  const shiftRefreshArmedRef = useRef(false);

  // Ref to track if menu modals are open (used in interval callback to avoid re-creating interval)
  const isMenuModalOpenRef = React.useRef(false);
  useEffect(() => {
    isMenuModalOpenRef.current = showMenuModal || showEditMenuModal;
  }, [showMenuModal, showEditMenuModal]);

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
      const isInsideModal = (target as Element).closest?.('[role="dialog"], .modal, [data-modal]');
      if (isInsideModal) {
        return;
      }

      // Check if click is on the FAB (new order button)
      const isOnFab = (target as Element).closest?.('button.fixed');
      if (isOnFab) {
        return;
      }

      // Clear selection when clicking outside
      setSelectedOrders([]);
      setSelectionType(null);
    };

    // Use mousedown for immediate response (before any other click handlers)
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [selectedOrders.length]);

  // Shift activation refresh (event-driven steady state)
  // We avoid continuous polling and perform a single silent refresh when a
  // shift becomes active (or when blocked modals close after activation).
  const { isShiftActive } = useShift();
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
        console.warn('[OrderDashboard] Coupon redemption retry failed:', error);
      });
    };

    processCouponQueue();
    const intervalId = window.setInterval(processCouponQueue, 30000);
    window.addEventListener('online', processCouponQueue);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', processCouponQueue);
    };
  }, []);

  // Auto-open approval panel for external pending orders (queue)
  const playExternalOrderAlert = useCallback(() => {
    try {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.value = 0.18;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      oscillator.start();
      setTimeout(() => {
        oscillator.stop();
        ctx.close();
      }, 450);
    } catch (error) {
      console.warn('[OrderDashboard] Failed to play order alert sound:', error);
    }
  }, []);

  const startAlertLoop = useCallback((orderId: string) => {
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
  }, [playExternalOrderAlert]);

  const stopAlertLoop = useCallback(() => {
    if (alertTimeoutRef.current) {
      clearTimeout(alertTimeoutRef.current);
      alertTimeoutRef.current = null;
    }
    alertingOrderIdRef.current = null;
  }, []);

  useEffect(() => {
    if (!scopedPendingExternalOrders || scopedPendingExternalOrders.length === 0) {
      stopAlertLoop();
      return;
    }

    const nextOrder = scopedPendingExternalOrders[0];
    if (!nextOrder) return;

    if (!showApprovalPanel || (isViewOnlyMode && selectedOrderForApproval?.id !== nextOrder.id)) {
      setSelectedOrderForApproval(nextOrder);
      setIsViewOnlyMode(false);
      setShowApprovalPanel(true);
    }
  }, [scopedPendingExternalOrders, showApprovalPanel, isViewOnlyMode, selectedOrderForApproval, stopAlertLoop]);

  useEffect(() => {
    const activeOrderId = showApprovalPanel && !isViewOnlyMode ? selectedOrderForApproval?.id : null;
    if (!activeOrderId) {
      stopAlertLoop();
      return;
    }

    if (alertingOrderIdRef.current !== activeOrderId || !alertTimeoutRef.current) {
      startAlertLoop(activeOrderId);
    }
  }, [showApprovalPanel, isViewOnlyMode, selectedOrderForApproval, startAlertLoop, stopAlertLoop]);

  useEffect(() => () => {
    stopAlertLoop();
  }, [stopAlertLoop]);

  // Update computed values when dependencies change
  useEffect(() => {
    if (!orders) return;

    const baseOrders = orderFilter ? orders.filter(orderFilter) : orders;

    // Filter orders based on active tab and global filters
    let filtered = baseOrders;

    // Apply global filters first
    if (filter.status && filter.status !== 'all') {
      filtered = filtered.filter(order => order.status === filter.status);
    }

    if (filter.orderType && filter.orderType !== 'all') {
      filtered = filtered.filter(order => order.orderType === filter.orderType);
    }

    if (filter.searchTerm) {
      const searchTerm = filter.searchTerm.toLowerCase();
      filtered = filtered.filter(order =>
        order.orderNumber.toLowerCase().includes(searchTerm) ||
        order.customerName?.toLowerCase().includes(searchTerm) ||
        order.customerPhone?.includes(searchTerm)
      );
    }

    // Apply tab-specific filters
    switch (activeTab) {
      case 'orders':
        filtered = filtered.filter(order =>
          order.status === 'pending' ||
          order.status === 'confirmed' ||
          order.status === 'preparing' ||
          order.status === 'ready'
        );
        break;
      case 'delivered':
        filtered = filtered.filter(order => order.status === 'delivered' || order.status === 'completed');
        break;
      case 'canceled':
        filtered = filtered.filter(order => order.status === 'cancelled');
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

    baseOrders.forEach(order => {
      switch (order.status) {
        case 'pending':
        case 'confirmed':
        case 'preparing':
        case 'ready':
          counts.orders++;
          break;
        case 'delivered':
        case 'completed':
          counts.delivered++;
          break;
        default:
          break;
        case 'cancelled':
          counts.canceled++;
          break;
      }
    });

    setOrderCounts(counts);
  }, [orders, filter, activeTab, orderFilter]);

  // Handle tab change
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setSelectedOrders([]); // Clear selection when changing tabs
    // Ensure global status filter doesn't hide tab contents
    try { setFilter({ status: 'all' }); } catch { }
  }, [setFilter]);

  // Update tables count when tables data changes
  useEffect(() => {
    if (tables) {
      setOrderCounts(prev => ({
        ...prev,
        tables: tables.length,
      }));
    }
  }, [tables]);

  // Handle order selection
  const handleToggleOrderSelection = (orderId: string) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const type: 'pickup' | 'delivery' = order.orderType === 'delivery' ? 'delivery' : 'pickup';

    setSelectedOrders(prev => {
      const isSelected = prev.includes(orderId);

      if (isSelected) {
        const next = prev.filter(id => id !== orderId);
        if (next.length === 0) setSelectionType(null);
        return next;
      }

      // Enforce mutually exclusive selection by order type
      if (!selectionType) {
        setSelectionType(type);
        return [...prev, orderId];
      }

      if (selectionType !== type) {
        toast.error(selectionType === 'delivery'
          ? t('orderDashboard.bulkPickupDisabled') || 'Pickup orders cannot be selected while Delivery selection is active.'
          : t('orderDashboard.bulkDeliveryDisabled') || 'Delivery orders cannot be selected while Pickup selection is active.'
        );
        return prev; // ignore selection of other type
      }

      return [...prev, orderId];
    });
  };

  // Handle order double-click for editing
  const handleOrderDoubleClick = (orderId: string) => {
    setPendingEditOrders([orderId]);
    setEditingSingleOrder(orderId);
    setShowEditOptionsModal(true);
  };

  // Handle order approval
  const handleApproveOrder = async (orderId: string, estimatedTime?: number) => {
    try {
      await approveOrder(orderId, estimatedTime);
      await loadOrders();
      setShowApprovalPanel(false);
      setSelectedOrderForApproval(null);
      setIsViewOnlyMode(true);
    } catch (error) {
      toast.error(t('orderDashboard.approveOrderFailed'));
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
      toast.error(t('orderDashboard.declineOrderFailed'));
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
        toast.success(t('orderDashboard.driverAssigned', { count: successCount }));
      }
      if (failureCount > 0) {
        toast.error(t('orderDashboard.driverAssignFailed'));
      }
      setPendingDeliveryOrders([]);
      setShowDriverModal(false);
      await loadOrders();
    } catch (error) {
      toast.error(t('orderDashboard.driverAssignFailed'));
    }
  };

  // Handle new order FAB click
  const handleNewOrderClick = () => {
    setShowOrderTypeModal(true);
  };

  // Handle order type selection (supports pickup, delivery, and dine-in/table)
  const handleOrderTypeSelect = async (type: 'pickup' | 'delivery' | 'dine-in') => {
    setIsOrderTypeTransitioning(true);

    // Smooth transition
    await new Promise(resolve => setTimeout(resolve, 300));

    setShowOrderTypeModal(false);
    setIsOrderTypeTransitioning(false);

    if (type === 'pickup') {
      setSelectedOrderType('pickup');
      setOrderType('pickup');
      // For pickup orders, go directly to menu with basic customer info
      setCustomerInfo({
        name: '',
        phone: '',
        email: '',
        address: {
          street: '',
          city: '',
          postalCode: ''
        },
        notes: ''
      });
      setShowMenuModal(true);
    } else if (type === 'delivery') {
      setSelectedOrderType('delivery');
      setOrderType('delivery');
      // For delivery orders, start with phone lookup
      setShowPhoneLookupModal(true);
    } else if (type === 'dine-in') {
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
      setSelectedOrderType('pickup'); // Table orders use pickup pricing
      setOrderType('dine-in');
      setTableNumber(selectedTable.tableNumber.toString());
      setCustomerInfo({
        name: t('orderFlow.tableCustomer', { table: selectedTable.tableNumber }) || `Table ${selectedTable.tableNumber}`,
        phone: '',
        email: '',
        address: {
          street: '',
          city: '',
          postalCode: ''
        },
        notes: ''
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
  const handleReservationSubmit = useCallback(async (data: CreateReservationDto) => {
    if (!branchId || !organizationId) {
      toast.error(t('orderDashboard.missingContext') || 'Missing branch or organization context');
      return;
    }

    try {
      // Set context for the service with actual IDs
      reservationsService.setContext(branchId, organizationId);

      // Format date and time from the Date object
      const reservationDate = data.reservationTime.toISOString().split('T')[0];
      const reservationTime = data.reservationTime.toTimeString().slice(0, 5);

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

      toast.success(t('orderDashboard.reservationCreated') || 'Reservation created successfully');
      setShowReservationForm(false);
      setSelectedTable(null);
    } catch (error) {
      console.error('Failed to create reservation:', error);
      toast.error(t('orderDashboard.reservationFailed') || 'Failed to create reservation');
    }
  }, [t, branchId, organizationId]);

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
    // Reset all state
    setPhoneNumber('');
    setCustomerInfo(null);
    setExistingCustomer(null);
    setSpecialInstructions('');
    setTableNumber('');
    setAddressValid(false);
    setDeliveryZoneInfo(null);
    setShowPhoneLookupModal(false);
    setShowCustomerInfoModal(false);
  };

  // Handler for clicking on customer card - select and proceed directly to menu
  const handleCustomerSelectedDirect = async (customer: any) => {
    console.log('[handleCustomerSelectedDirect] Called with customer:', JSON.stringify({
      id: customer?.id,
      name: customer?.name,
      address: customer?.address,
      addresses: customer?.addresses
    }, null, 2));
    console.log('[handleCustomerSelectedDirect] Current orderType:', orderType);

    // Map customer data to form
    const defaultAddress = customer.addresses && customer.addresses.length > 0
      ? customer.addresses[0]
      : null;
    console.log('[handleCustomerSelectedDirect] defaultAddress:', JSON.stringify(defaultAddress, null, 2));

    // For delivery orders, validate that customer has an address
    if (orderType === 'delivery') {
      const hasAddress = defaultAddress?.street_address || defaultAddress?.street || customer.address;
      console.log('[handleCustomerSelectedDirect] Delivery check - hasAddress:', hasAddress);
      if (!hasAddress) {
        console.log('[handleCustomerSelectedDirect] No address - opening addAddress modal');
        toast.error(t('orderDashboard.customerNoAddress') || 'This customer has no delivery address. Please add an address first.');
        // Keep the modal open and prompt to add address
        setExistingCustomer(customer);
        setCustomerModalMode('addAddress');
        setShowPhoneLookupModal(false);
        setShowAddCustomerModal(true);
        return;
      }

      // Validate delivery zone for the address
      try {
        const addressString = [
          defaultAddress?.street_address || defaultAddress?.street || customer.address || '',
          defaultAddress?.city || customer.city || '',
          defaultAddress?.postal_code || customer.postal_code || ''
        ].filter(Boolean).join(', ');

        if (addressString) {
          const validationResult = await validateDeliveryAddress(addressString, 0);
          if (validationResult) {
            setDeliveryZoneInfo(validationResult);
          }
        }
      } catch (error) {
        console.error('[OrderDashboard] Error validating delivery zone:', error);
        // Continue without zone info - validation will happen in PaymentModal
      }
    } else {
      // Clear delivery zone info for non-delivery orders
      setDeliveryZoneInfo(null);
    }

    setExistingCustomer(customer);

    setCustomerInfo({
      name: customer.name,
      phone: customer.phone,
      email: customer.email || '',
      address: defaultAddress ? {
        street: defaultAddress.street_address || customer.address || '',
        city: defaultAddress.city || '',
        postalCode: defaultAddress.postal_code || customer.postal_code || '',
        coordinates: defaultAddress.coordinates || undefined,
      } : {
        street: customer.address || '',
        city: customer.city || '',
        postalCode: customer.postal_code || '',
      },
      notes: defaultAddress?.notes || customer.notes || '',
    });

    if (defaultAddress?.notes) {
      setSpecialInstructions(defaultAddress.notes);
    }

    // Close search modal and go directly to menu
    setShowPhoneLookupModal(false);
    setShowMenuModal(true);
  };

  // Handler for "Add Address" button - open modal to add new address only
  const handleAddNewAddress = (customer: any) => {
    setExistingCustomer(customer);
    setCustomerModalMode('addAddress');
    setShowPhoneLookupModal(false);
    setShowAddCustomerModal(true);
  };

  // Handler for "Edit Customer" button - open modal for full edit
  const handleEditCustomer = (customer: any) => {
    setExistingCustomer(customer);
    setCustomerModalMode('edit');
    setShowPhoneLookupModal(false);
    setShowAddCustomerModal(true);
  };

  // Handler for adding new customer from search modal
  const handleAddNewCustomer = (phone: string) => {
    setExistingCustomer(null);
    setCustomerModalMode('new');
    setPhoneNumber(phone); // Keep track of phone
    setShowPhoneLookupModal(false);
    setShowAddCustomerModal(true);
  };

  const handleNewCustomerAdded = async (customer: any) => {
    console.log('[handleNewCustomerAdded] Called with customer:', JSON.stringify({
      id: customer?.id,
      name: customer?.name,
      address: customer?.address,
      addresses: customer?.addresses,
      selected_address_id: customer?.selected_address_id
    }, null, 2));
    console.log('[handleNewCustomerAdded] Current orderType:', orderType);

    // Map customer data to customerInfo state
    const defaultAddress = customer.addresses && customer.addresses.length > 0
      ? customer.addresses[0]
      : null;
    console.log('[handleNewCustomerAdded] defaultAddress:', JSON.stringify(defaultAddress, null, 2));

    // For delivery orders, validate that customer has an address
    if (orderType === 'delivery') {
      const hasAddress = defaultAddress?.street_address || defaultAddress?.street || customer.address;
      console.log('[handleNewCustomerAdded] Delivery check - hasAddress:', hasAddress);
      if (!hasAddress) {
        console.log('[handleNewCustomerAdded] No address found - keeping addAddress modal open');
        toast.error(t('orderDashboard.customerNoAddress') || 'This customer has no delivery address. Please add an address first.');
        // Keep the add customer modal open in addAddress mode
        setExistingCustomer(customer);
        setCustomerModalMode('addAddress');
        return;
      }

      // Validate delivery zone for the address
      try {
        const addressString = [
          defaultAddress?.street_address || defaultAddress?.street || customer.address || '',
          defaultAddress?.city || customer.city || '',
          defaultAddress?.postal_code || customer.postal_code || ''
        ].filter(Boolean).join(', ');

        if (addressString) {
          const validationResult = await validateDeliveryAddress(addressString, 0);
          if (validationResult) {
            setDeliveryZoneInfo(validationResult);
          }
        }
      } catch (error) {
        console.error('[OrderDashboard] Error validating delivery zone:', error);
        // Continue without zone info - validation will happen in PaymentModal
      }
    } else {
      // Clear delivery zone info for non-delivery orders
      setDeliveryZoneInfo(null);
    }

    // Store the customer info and proceed to menu
    console.log('[handleNewCustomerAdded] Setting existingCustomer to:', customer?.name);
    setExistingCustomer(customer);

    const customerInfoData = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || '',
      address: defaultAddress ? {
        street: defaultAddress.street_address || customer.address || '',
        city: defaultAddress.city || customer.city || '',
        postalCode: defaultAddress.postal_code || customer.postal_code || '',
        coordinates: defaultAddress.coordinates || customer.coordinates || undefined,
      } : {
        street: customer.address || '',
        city: customer.city || '',
        postalCode: customer.postal_code || '',
        coordinates: customer.coordinates || undefined,
      },
      notes: defaultAddress?.notes || customer.notes || '',
    };
    console.log('[handleNewCustomerAdded] Setting customerInfo to:', JSON.stringify(customerInfoData, null, 2));
    setCustomerInfo(customerInfoData);

    if (defaultAddress?.notes || customer.notes) {
      setSpecialInstructions(defaultAddress?.notes || customer.notes || '');
    }

    // Close add customer modal and open menu modal
    console.log('[handleNewCustomerAdded] Opening MenuModal');
    setShowAddCustomerModal(false);
    setShowMenuModal(true);
  };

  // Handler for saving customer info from modal (New Order Flow)
  const handleNewOrderCustomerInfoSave = (info: any) => {
    console.log('[handleNewOrderCustomerInfoSave] Called with info:', JSON.stringify(info, null, 2));
    // Update local state
    const customerInfoData = {
      name: info.name,
      phone: info.phone,
      email: info.email,
      address: {
        street: info.address || '',
        city: '', // info.address is single string in modal often, might need parsing or just store as street
        postalCode: '',
        coordinates: info.coordinates
      },
      notes: ''
    };
    console.log('[handleNewOrderCustomerInfoSave] Setting customerInfo:', JSON.stringify(customerInfoData, null, 2));
    setCustomerInfo(customerInfoData);

    // Close customer info modal and open menu modal
    console.log('[handleNewOrderCustomerInfoSave] Opening MenuModal');
    setShowCustomerInfoModal(false);
    setShowMenuModal(true);
  };

  // Handle customer info submission
  const handleCustomerInfoSubmit = () => {
    // Validate required fields
    if (!customerInfo?.name.trim()) {
      toast.error(t('orderDashboard.nameRequired'));
      return;
    }

    if (!customerInfo?.phone.trim()) {
      toast.error(t('orderDashboard.phoneRequired'));
      return;
    }

    // For delivery orders, validate address
    if (orderType === 'delivery') {
      if (!customerInfo?.address?.street.trim()) {
        toast.error(t('orderDashboard.addressRequired'));
        return;
      }
      if (!customerInfo?.address?.city.trim()) {
        toast.error(t('orderDashboard.cityRequired'));
        return;
      }
      if (!customerInfo?.address?.postalCode.trim()) {
        toast.error(t('orderDashboard.postalCodeRequired'));
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
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Mock validation - in real app, this would validate against a real service
      const isValid = customerInfo?.address?.street.trim() &&
        customerInfo?.address?.city.trim() &&
        customerInfo?.address?.postalCode.trim();
      setAddressValid(!!isValid);

      if (isValid) {
        toast.success(t('orderDashboard.addressValidated'));
      } else {
        toast.error(t('orderDashboard.addressValidationFailed'));
      }
      return !!isValid;
    } catch (error) {
      console.error('Address validation failed:', error);
      toast.error(t('orderDashboard.addressValidationError'));
      setAddressValid(false);
      return false;
    } finally {
      setIsValidatingAddress(false);
    }
  };

  // Helper functions for menu modal
  const getCustomerForMenu = () => {
    console.log('[getCustomerForMenu] BUILD v2026.01.05.1 - existingCustomer:', !!existingCustomer, 'customerInfo:', !!customerInfo);
    if (existingCustomer) {
      const result = {
        id: existingCustomer.id,
        name: existingCustomer.name,
        phone: existingCustomer.phone,
        email: existingCustomer.email
      };
      console.log('[getCustomerForMenu] Returning from existingCustomer:', result);
      return result;
    } else if (customerInfo) {
      const result = {
        id: 'new',
        name: customerInfo.name,
        phone: customerInfo.phone,
        email: customerInfo.email
      };
      console.log('[getCustomerForMenu] Returning from customerInfo:', result);
      return result;
    }
    console.log('[getCustomerForMenu] Returning null');
    return null;
  };

  const getSelectedAddress = () => {
    // First check the customer_addresses array
    if (existingCustomer?.addresses && existingCustomer.addresses.length > 0) {
      const defaultAddress = existingCustomer.addresses.find(addr => addr.is_default) || existingCustomer.addresses[0];
      // Handle both snake_case (from API) and camelCase field names
      const streetValue = (defaultAddress as any).street_address || defaultAddress.street;
      if (streetValue) {
        console.log('[getSelectedAddress] Found address from existingCustomer.addresses:', streetValue);
        return {
          street: streetValue,
          street_address: streetValue, // Include both for compatibility
          city: defaultAddress.city,
          postalCode: defaultAddress.postal_code,
          floor: (defaultAddress as any).floor_number || (defaultAddress as any).floor,
          notes: defaultAddress.delivery_notes || (defaultAddress as any).notes,
          nameOnRinger: (defaultAddress as any).name_on_ringer
        };
      }
    }
    // Then check address directly on the customer object (legacy/fallback)
    if ((existingCustomer as any)?.address) {
      const addrValue = (existingCustomer as any).address;
      const streetValue = typeof addrValue === 'string' ? addrValue : (addrValue?.street_address || addrValue?.street || '');
      if (streetValue) {
        console.log('[getSelectedAddress] Found address from existingCustomer.address:', streetValue);
        return {
          street: streetValue,
          street_address: streetValue,
          city: (existingCustomer as any).city || '',
          postalCode: (existingCustomer as any).postal_code || '',
          floor: (existingCustomer as any).floor || '',
          notes: (existingCustomer as any).notes || '',
          nameOnRinger: (existingCustomer as any).name_on_ringer || ''
        };
      }
    }
    // Finally check customerInfo state
    if (customerInfo?.address) {
      const streetValue = customerInfo.address.street || (customerInfo.address as any).street_address || '';
      if (streetValue) {
        console.log('[getSelectedAddress] Found address from customerInfo.address:', streetValue);
        return {
          street: streetValue,
          street_address: streetValue,
          city: customerInfo.address.city,
          postalCode: customerInfo.address.postalCode,
          floor: (customerInfo.address as any).floor || '',
          notes: customerInfo.notes,
          nameOnRinger: (customerInfo as any).nameOnRinger || ''
        };
      }
    }
    console.log('[getSelectedAddress] No address found. existingCustomer:', !!existingCustomer, 'customerInfo:', !!customerInfo);
    return null;
  };

  // Handle order completion from menu modal
  const handleOrderComplete = async (orderData: any) => {
    try {
      console.log('[OrderDashboard.handleOrderComplete] orderData:', orderData);
      console.log('[OrderDashboard.handleOrderComplete] orderData.items with notes:', orderData.items?.map((item: any) => ({
        name: item.name,
        notes: item.notes,
        special_instructions: item.special_instructions
      })));
      console.log('[OrderDashboard.handleOrderComplete] orderData.address:', orderData.address);
      console.log('[OrderDashboard.handleOrderComplete] existingCustomer:', existingCustomer);
      console.log('[OrderDashboard.handleOrderComplete] existingCustomer?.address:', (existingCustomer as any)?.address);
      console.log('[OrderDashboard.handleOrderComplete] customerInfo:', customerInfo);
      console.log('[OrderDashboard.handleOrderComplete] customerInfo?.address:', customerInfo?.address);
      console.log('[OrderDashboard.handleOrderComplete] getSelectedAddress():', getSelectedAddress());
      console.log('[OrderDashboard.handleOrderComplete] selectedOrderType:', selectedOrderType);

      // Build delivery address string from multiple address sources
      let deliveryAddress: string | null = null;
      let deliveryCity: string | null = null;
      let deliveryPostalCode: string | null = null;
      let deliveryFloor: string | null = null;
      let deliveryNotes: string | null = null;
      let nameOnRinger: string | null = null;
      
      if (selectedOrderType === 'delivery') {
        // Priority order for address resolution:
        // 1. orderData.address (from MenuModal)
        // 2. getSelectedAddress() (from state)
        // 3. existingCustomer.address (legacy field from customers table)
        // 4. customerInfo.address (from state)
        const addr = orderData.address || getSelectedAddress();
        const legacyCustomerAddress = (existingCustomer as any)?.address;
        const customerInfoAddress = customerInfo?.address;

        console.log('[OrderDashboard.handleOrderComplete] addr:', addr);
        console.log('[OrderDashboard.handleOrderComplete] legacyCustomerAddress:', legacyCustomerAddress);
        console.log('[OrderDashboard.handleOrderComplete] customerInfoAddress:', customerInfoAddress);

        if (addr) {
          // Handle both string addresses and structured address objects
          if (typeof addr === 'string') {
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
              deliveryAddress = parts.filter(Boolean).join(', ');
            }
          }
        }

        // Fallback to legacy customer.address field if no structured address found
        if (!deliveryAddress && legacyCustomerAddress) {
          if (typeof legacyCustomerAddress === 'string') {
            deliveryAddress = legacyCustomerAddress;
          } else if (legacyCustomerAddress.street || legacyCustomerAddress.street_address) {
            const parts: string[] = [];
            const streetValue = legacyCustomerAddress.street_address || legacyCustomerAddress.street;
            if (streetValue) {
              parts.push(streetValue);
              if (!deliveryAddress) deliveryAddress = streetValue;
            }
            if (legacyCustomerAddress.city) {
              parts.push(legacyCustomerAddress.city);
              if (!deliveryCity) deliveryCity = legacyCustomerAddress.city;
            }
            const postalValue = legacyCustomerAddress.postal_code || legacyCustomerAddress.postalCode;
            if (postalValue) {
              parts.push(postalValue);
              if (!deliveryPostalCode) deliveryPostalCode = postalValue;
            }
            if (!deliveryAddress) deliveryAddress = parts.filter(Boolean).join(', ');
          }
        }

        // Fallback to customerInfo.address from state
        if (!deliveryAddress && customerInfoAddress) {
          if (typeof customerInfoAddress === 'string') {
            deliveryAddress = customerInfoAddress;
          } else if (customerInfoAddress.street) {
            const parts: string[] = [];
            if (customerInfoAddress.street) {
              parts.push(customerInfoAddress.street);
              if (!deliveryAddress) deliveryAddress = customerInfoAddress.street;
            }
            if (customerInfoAddress.city) {
              parts.push(customerInfoAddress.city);
              if (!deliveryCity) deliveryCity = customerInfoAddress.city;
            }
            if (customerInfoAddress.postalCode) {
              parts.push(customerInfoAddress.postalCode);
              if (!deliveryPostalCode) deliveryPostalCode = customerInfoAddress.postalCode;
            }
            if (!deliveryAddress) deliveryAddress = parts.filter(Boolean).join(', ');
          }
        }

        console.log('[OrderDashboard.handleOrderComplete] deliveryAddress built:', deliveryAddress);
        console.log('[OrderDashboard.handleOrderComplete] Individual fields:', { deliveryCity, deliveryPostalCode, deliveryFloor, deliveryNotes, nameOnRinger });

        // Final fallback: Query customer from database if we have customerId but no address yet
        if (!deliveryAddress && (existingCustomer?.id || orderData.customer?.id)) {
          const customerId = existingCustomer?.id || orderData.customer?.id;
          console.log('[OrderDashboard.handleOrderComplete] Attempting database fallback for customerId:', customerId);
          try {
            const dbCustomer = (await bridge.customers.lookupById(customerId)) as any;
            if (dbCustomer) {
              console.log('[OrderDashboard.handleOrderComplete] Database customer found:', dbCustomer);
              // Check customer.addresses array first
              if (Array.isArray(dbCustomer.addresses) && dbCustomer.addresses.length > 0) {
                const addr = dbCustomer.addresses.find((a: any) => a.is_default) || dbCustomer.addresses[0];
                const parts: string[] = [];
                const streetValue = addr.street_address || addr.street;
                if (streetValue) {
                  parts.push(streetValue);
                  if (!deliveryAddress) deliveryAddress = streetValue;
                }
                if (addr.city) {
                  parts.push(addr.city);
                  if (!deliveryCity) deliveryCity = addr.city;
                }
                if (addr.postal_code) {
                  parts.push(addr.postal_code);
                  if (!deliveryPostalCode) deliveryPostalCode = addr.postal_code;
                }
                // Extract additional fields
                if (addr.floor_number || addr.floor) {
                  if (!deliveryFloor) deliveryFloor = String(addr.floor_number || addr.floor);
                }
                if (addr.delivery_notes || addr.notes) {
                  if (!deliveryNotes) deliveryNotes = addr.delivery_notes || addr.notes;
                }
                if (addr.name_on_ringer) {
                  if (!nameOnRinger) nameOnRinger = addr.name_on_ringer;
                }
                if (!deliveryAddress) deliveryAddress = parts.filter(Boolean).join(', ');
                console.log('[OrderDashboard.handleOrderComplete] Database fallback address from addresses[]:', deliveryAddress);
              }
              // Check legacy customer.address field
              else if (dbCustomer.address) {
                if (typeof dbCustomer.address === 'string') {
                  deliveryAddress = dbCustomer.address;
                } else if (typeof dbCustomer.address === 'object') {
                  const parts: string[] = [];
                  const streetValue = dbCustomer.address.street_address || dbCustomer.address.street;
                  if (streetValue) {
                    parts.push(streetValue);
                    if (!deliveryAddress) deliveryAddress = streetValue;
                  }
                  if (dbCustomer.address.city) {
                    parts.push(dbCustomer.address.city);
                    if (!deliveryCity) deliveryCity = dbCustomer.address.city;
                  }
                  if (dbCustomer.address.postal_code) {
                    parts.push(dbCustomer.address.postal_code);
                    if (!deliveryPostalCode) deliveryPostalCode = dbCustomer.address.postal_code;
                  }
                  if (!deliveryAddress) deliveryAddress = parts.filter(Boolean).join(', ');
                }
                console.log('[OrderDashboard.handleOrderComplete] Database fallback address from customer.address:', deliveryAddress);
              }
            }
          } catch (err) {
            console.error('[OrderDashboard.handleOrderComplete] Database fallback failed:', err);
          }
        }

        // Validate that delivery orders have an address - show error if still missing
        if (!deliveryAddress) {
          console.error('[OrderDashboard.handleOrderComplete] ❌ No address found for delivery order!');
          console.error('[OrderDashboard.handleOrderComplete] Available sources:', {
            orderDataAddress: orderData.address,
            selectedAddress: getSelectedAddress(),
            existingCustomerAddress: legacyCustomerAddress,
            customerInfoAddress: customerInfoAddress,
            customerId: existingCustomer?.id || orderData.customer?.id
          });
          toast.error(t('orderDashboard.addressRequired'));
          return; // Prevent order creation without address
        }
      }

      // Calculate totals
      // Note: item.totalPrice already includes quantity (from MenuModal), so don't multiply again
      // If item.totalPrice is not available, use (price * quantity) as fallback
      const subtotal = orderData.items?.reduce((sum: number, item: any) => {
        if (item.totalPrice !== undefined && item.totalPrice !== null) {
          // totalPrice already includes quantity
          return sum + item.totalPrice;
        }
        // Fallback: multiply price by quantity
        return sum + ((item.price || 0) * (item.quantity || 1));
      }, 0) || orderData.total || 0;
      const manualDiscountAmount = Number(orderData.discountAmount || 0);
      const couponDiscountAmount = Math.max(0, Number(orderData.coupon_discount_amount || 0));
      const totalDiscountAmount = Math.max(
        0,
        Number(orderData.total_discount_amount ?? (manualDiscountAmount + couponDiscountAmount))
      );
      const discountPercentage = orderData.discountPercentage || 0;
      const manualDiscountMode: 'percentage' | 'fixed' | null =
        orderData.manualDiscountMode || (discountPercentage > 0 ? 'percentage' : null);
      const manualDiscountValue =
        orderData.manualDiscountValue ??
        (manualDiscountMode === 'percentage' ? discountPercentage : manualDiscountAmount);
      const couponId = typeof orderData.coupon_id === 'string' ? orderData.coupon_id : null;
      const couponCode = typeof orderData.coupon_code === 'string' ? orderData.coupon_code : null;
      const isGhostOrder =
        orderData.is_ghost === true ||
        orderData.isGhost === true ||
        orderData.ghost === true;
      const ghostSource = isGhostOrder
        ? (typeof orderData.ghost_source === 'string' ? orderData.ghost_source : 'ghost_mode_toggle')
        : null;
      const ghostMetadata = isGhostOrder
        ? (orderData.ghost_metadata ?? {
          trigger: 'ghost_mode_toggle',
          bypass_reason: 'ghost_mode_enabled',
        })
        : null;

      // Get delivery fee from delivery zone info if available, otherwise use 0
      let deliveryFee = 0;
      if (selectedOrderType === 'delivery') {
        if (orderData.deliveryZoneInfo?.zone?.deliveryFee !== undefined) {
          deliveryFee = orderData.deliveryZoneInfo.zone.deliveryFee;
        }
      }

      const total = subtotal - totalDiscountAmount + deliveryFee;

      // Create order object
      const orderToCreate = {
        customer_id: orderData.customer?.id !== 'pickup-customer' ? orderData.customer?.id : null,
        customer_name: orderData.customer?.name || orderData.customer?.full_name || customerInfo?.name || existingCustomer?.name || t('customer.defaultCustomer'),
        customer_phone: orderData.customer?.phone_number || orderData.customer?.phone || customerInfo?.phone || existingCustomer?.phone || '',
        items: orderData.items?.map((item: any) => ({
          id: item.id || item.menuItemId || item.menu_item_id,
          menu_item_id: item.menuItemId || item.menu_item_id || item.id,
          // Preserve menuItemId for sync service mapping (camelCase)
          menuItemId: item.menuItemId || item.menu_item_id || item.id,
          // Preserve category_id for analytics (if available from menu item spread)
          category_id: item.category_id || null,
          // Preserve categoryName for receipt printing and order display
          categoryName: item.categoryName || null,
          name: item.name || item.title || item.menu_item_name || 'Item',
          quantity: item.quantity || 1,
          // unitPrice = price per item with customizations (without quantity multiplication)
          // totalPrice = total price for this line (unitPrice * quantity)
          price: item.unitPrice || item.price || 0,
          unit_price: item.unitPrice || item.price || 0,
          unitPrice: item.unitPrice || item.price || 0,
          original_unit_price:
            item.originalUnitPrice || item.original_unit_price || item.unitPrice || item.price || 0,
          originalUnitPrice:
            item.originalUnitPrice || item.original_unit_price || item.unitPrice || item.price || 0,
          is_price_overridden:
            item.isPriceOverridden === true ||
            item.is_price_overridden === true ||
            Math.abs(
              (item.unitPrice || item.price || 0) -
                (item.originalUnitPrice || item.original_unit_price || item.unitPrice || item.price || 0)
            ) > 0.0001,
          isPriceOverridden:
            item.isPriceOverridden === true ||
            item.is_price_overridden === true ||
            Math.abs(
              (item.unitPrice || item.price || 0) -
                (item.originalUnitPrice || item.original_unit_price || item.unitPrice || item.price || 0)
            ) > 0.0001,
          totalPrice: item.totalPrice || ((item.unitPrice || item.price || 0) * (item.quantity || 1)),
          total_price: item.totalPrice || ((item.unitPrice || item.price || 0) * (item.quantity || 1)),
          customizations: item.customizations || null,
          notes: item.notes || item.special_instructions || null
        })) || [],
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
        status: 'pending' as const,
        order_type: selectedOrderType || 'pickup',
        payment_method: orderData.paymentData?.method || 'cash',
        // Full delivery address fields for proper sync to Supabase
        delivery_address: deliveryAddress,
        delivery_city: deliveryCity,
        delivery_postal_code: deliveryPostalCode,
        delivery_floor: deliveryFloor,
        delivery_notes: deliveryNotes,
        name_on_ringer: nameOnRinger,
        notes: orderData.notes || null
      };

      console.log('[OrderDashboard] Creating order with data:', orderToCreate);

      const result = await createOrder(orderToCreate);

      if (result.success) {
        toast.success(t('orderDashboard.orderCreated'));
        // Refresh orders in background - don't block UI
        silentRefresh().catch(err => console.debug('[OrderDashboard] Background refresh error:', err));

        if (!isGhostOrder && couponId && result.orderId) {
          couponRedemptionService
            .redeemOrQueue({
              couponId,
              couponCode,
              orderId: result.orderId,
              discountAmount: couponDiscountAmount,
            })
            .catch((error) => {
              console.warn('[OrderDashboard] Failed to enqueue coupon redemption retry:', error);
            });
        }

        if (result.orderId) {
          if (isGhostOrder) {
            bridge.payments.printReceipt(result.orderId)
              .then((printResult: any) => console.log('[OrderDashboard] Ghost receipt print result:', printResult))
              .catch((printError: any) => console.error('[OrderDashboard] Ghost receipt print error:', printError));
          } else {
            // Cash register / fiscal print (fire-and-forget, non-blocking)
            bridge.ecr.fiscalPrint(result.orderId)
              .then((r: any) => { if (r?.skipped) return; console.log('[OrderDashboard] Fiscal print result:', r); })
              .catch((e: any) => console.warn('[OrderDashboard] Cash register print error (non-blocking):', e));
          }

          // Auto-earn loyalty points (fire-and-forget, non-blocking)
          const loyaltyCustomerId = orderToCreate.customer_id;
          if (loyaltyCustomerId && !isGhostOrder) {
            bridge.loyalty.earnPoints({
              customerId: loyaltyCustomerId,
              orderId: result.orderId,
              amount: total,
            }).then((res: any) => {
              if (res?.success && res?.pointsEarned > 0) {
                toast.success(t('loyalty.pointsEarned', { points: res.pointsEarned, defaultValue: '+{{points}} loyalty points earned' }));
              }
            }).catch(() => {}); // Non-blocking
          }
        } else {
          console.warn('[OrderDashboard] No orderId in result, skipping auto-print');
        }
      } else {
        toast.error(result.error || t('orderDashboard.orderCreateFailed'));
      }
    } catch (error) {
      console.error('Error creating order:', error);
      toast.error(t('orderDashboard.orderCreateFailed'));
    } finally {
      setShowMenuModal(false);
      setSelectedOrderType(null);
      setExistingCustomer(null);
      setCustomerInfo({ name: '', phone: '' });
    }
  };

  // Handle bulk actions
  const handleBulkAction = async (action: string) => {
    setIsBulkActionLoading(true);
    try {
      if (action === 'view') {
        if (selectedOrders.length === 1) {
          const ord = orders.find(o => o.id === selectedOrders[0]);
          if (ord) {
            setSelectedOrderForApproval(ord); // reuse approval panel state container for viewing
            setIsViewOnlyMode(true); // View mode - only print button, no approve/decline
            setShowApprovalPanel(true);
          }
        }
        return;
      }

      if (action === 'receipt') {
        if (selectedOrders.length === 1) {
          try {
            const result = await bridge.payments.getReceiptPreview(selectedOrders[0]);
            const html = (result as any)?.html ?? (result as any)?.data?.html;
            if ((result as any)?.success !== false && html) {
              setReceiptPreviewHtml(html);
              setReceiptPreviewOrderId(selectedOrders[0]);
              setShowReceiptPreview(true);
            } else {
              toast.error((result as any)?.error || 'Failed to generate receipt preview');
            }
          } catch (err) {
            console.error('Receipt preview failed:', err);
            toast.error('Failed to generate receipt preview');
          }
        }
        return;
      }

      if (action === 'assign') {
        // Driver assignment for delivery orders
        const selectedOrderObjects = orders.filter(order => selectedOrders.includes(order.id));
        const deliveryOrders = selectedOrderObjects.filter(order => order.orderType === 'delivery');
        if (deliveryOrders.length === 0) {
          toast.error(t('orderDashboard.noDeliveryOrdersSelected') || 'Select delivery orders to assign driver');
          return;
        }
        setPendingDeliveryOrders(deliveryOrders.map(o => o.id));
        setShowDriverModal(true);
        return;
      }

      if (action === 'pickup') {
        // Convert selected delivery orders to pickup
        const selectedOrderObjects = orders.filter(order => selectedOrders.includes(order.id));
        const deliveryOrders = selectedOrderObjects.filter(order => order.orderType === 'delivery');
        if (deliveryOrders.length === 0) {
          toast.error(t('orderDashboard.noDeliveryOrdersSelected') || 'Select delivery orders to convert to pickup');
          return;
        }
        let successCount = 0;
        for (const ord of deliveryOrders) {
          const ok = await convertToPickup(ord.id);
          if (ok) successCount++;
          else {
            toast.error(t('orderDashboard.convertToPickupFailed', { orderNumber: ord.orderNumber }) || `Failed to convert ${ord.orderNumber}`);
            return;
          }
        }
        if (successCount > 0) {
          toast.success(t('orderDashboard.convertedToPickup', { count: successCount }) || `Converted ${successCount} order(s) to pickup`);
        }
        // Switch selection context to pickup so Delivered button appears
        setSelectionType('pickup');
        return;
      }

      if (action === 'delivered') {
        // Get the selected order objects
        const selectedOrderObjects = orders.filter(order => selectedOrders.includes(order.id));

        // Separate delivery orders from pickup orders
        const deliveryOrders = selectedOrderObjects.filter(order => order.orderType === 'delivery');
        const pickupOrders = selectedOrderObjects.filter(order => order.orderType !== 'delivery');

        // Handle pickup orders immediately (mark as completed)
        if (pickupOrders.length > 0) {
          for (const order of pickupOrders) {
            const success = await updateOrderStatus(order.id, 'completed');
            if (!success) {
              toast.error(t('orderDashboard.markDeliveredFailed', { orderNumber: order.orderNumber }));
              return;
            }
          }
          toast.success(t('orderDashboard.pickupDelivered', { count: pickupOrders.length }));
        }

        // Handle delivery orders - ask for driver assignment first
        if (deliveryOrders.length > 0) {
          setPendingDeliveryOrders(deliveryOrders.map(order => order.id));
          setShowDriverModal(true);
        } else if (pickupOrders.length > 0) {
          // If only pickup orders, clear selection
          setSelectedOrders([]);
        }
      } else if (action === 'return') {
        // Reactivate cancelled orders back to active (pending)
        const selectedOrderObjects = orders.filter(order => selectedOrders.includes(order.id));
        const cancelledOrders = selectedOrderObjects.filter(order => order.status === 'cancelled');

        if (cancelledOrders.length === 0) {
          toast.error(t('orderDashboard.noCancelledOrdersSelected'));
        } else {
          for (const order of cancelledOrders) {
            const success = await updateOrderStatus(order.id, 'pending');
            if (!success) {
              toast.error(t('orderDashboard.returnToOrdersFailed', { orderNumber: order.orderNumber }));
              return;
            }
          }
          toast.success(t('orderDashboard.returnedToOrders', { count: cancelledOrders.length }));
          setSelectedOrders([]);
          await loadOrders();
        }
      } else if (action === 'map') {
        // Open selected delivery addresses in Google Maps (browser)
        const selectedOrderObjects = orders.filter(order => selectedOrders.includes(order.id));
        const addresses = selectedOrderObjects
          .filter(order => order.orderType === 'delivery')
          .map(order => (order as any).delivery_address || (order as any).address || (order as any).deliveryAddress)
          .filter(addr => !!addr)
          .map(addr => String(addr));

        if (addresses.length === 0) {
          toast.error(t('orderDashboard.noAddressesForMap'));
        } else {
          try {
            for (const addr of addresses) {
              const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
              const opened = await openExternalUrl(url);
              if (!opened) throw new Error('Failed to open external map URL');
            }
            toast.success(t('orderDashboard.openedInMaps', { count: addresses.length }));
          } catch (e) {
            console.error('Failed to open Google Maps:', e);
            toast.error(t('orderDashboard.mapOpenFailed'));
          }
        }
      } else if (action === 'cancel') {
        // Handle cancel action - show cancellation modal
        if (selectedOrders.length > 0) {
          setPendingCancelOrders(selectedOrders);
          setShowCancelModal(true);
        } else {
          toast.error(t('orderDashboard.noOrdersForCancel'));
        }
      } else if (action === 'edit') {
        // Handle edit action - show edit options modal
        if (selectedOrders.length > 0) {
          setPendingEditOrders(selectedOrders);
          setEditingSingleOrder(null);
          setShowEditOptionsModal(true);
        } else {
          toast.error(t('orderDashboard.noOrdersForEdit'));
        }
      }
    } finally {
      setIsBulkActionLoading(false);
    }

  };

  // Handle clearing selection
  const handleClearSelection = () => {
    setSelectedOrders([]);
    setSelectionType(null);
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
        const success = await updateOrderStatus(orderId, 'cancelled');
        if (!success) {
          const order = orders.find(o => o.id === orderId);
          toast.error(t('orderDashboard.cancelOrderFailed', { orderNumber: order?.orderNumber }));
          return;
        }
      }

      toast.success(t('orderDashboard.ordersCancelled', { count: pendingCancelOrders.length }));

      // Close modal and clear selections
      setShowCancelModal(false);
      setPendingCancelOrders([]);
      setSelectedOrders([]);
    } catch (error) {
      console.error('Failed to cancel orders:', error);
      toast.error(t('orderDashboard.cancelFailed'));
    }
  };

  // Handle cancel modal close
  const handleCancelModalClose = () => {
    setShowCancelModal(false);
    setPendingCancelOrders([]);
  };

  // Handle edit options
  const handleEditInfo = () => {
    setShowEditOptionsModal(false);
    setShowEditCustomerModal(true);
  };

  const editablePaymentOrder = React.useMemo(() => {
    if (pendingEditOrders.length !== 1) return null;
    return orders.find(order => order.id === pendingEditOrders[0]) || null;
  }, [pendingEditOrders, orders]);

  const editablePaymentMethod = React.useMemo<'cash' | 'card' | null>(() => {
    if (!editablePaymentOrder) return null;
    const method = String(
      (editablePaymentOrder as any).payment_method ||
      (editablePaymentOrder as any).paymentMethod ||
      ''
    )
      .trim()
      .toLowerCase();
    return method === 'cash' || method === 'card' ? method : null;
  }, [editablePaymentOrder]);

  const paymentEditIneligibilityReason = React.useMemo(() => {
    if (pendingEditOrders.length !== 1) {
      return t('orderDashboard.paymentMethodEditUnavailable');
    }

    if (!editablePaymentOrder) {
      return t('orderDashboard.paymentMethodEditUnavailable');
    }

    const status = String((editablePaymentOrder as any).status || '')
      .trim()
      .toLowerCase();
    if (status === 'cancelled' || status === 'canceled') {
      return t('orderDashboard.paymentMethodEditUnavailable');
    }

    if (!editablePaymentMethod) {
      return t('orderDashboard.paymentMethodEditUnavailable');
    }

    return undefined;
  }, [pendingEditOrders.length, editablePaymentOrder, editablePaymentMethod, t]);

  const canEditPaymentMethod = !paymentEditIneligibilityReason;

  const handleEditPayment = () => {
    if (!canEditPaymentMethod) {
      toast.error(paymentEditIneligibilityReason || t('orderDashboard.paymentMethodEditUnavailable'));
      return;
    }

    if (!editablePaymentOrder || !editablePaymentMethod) {
      toast.error(t('orderDashboard.paymentMethodEditUnavailable'));
      return;
    }

    const paymentStatus = String(
      (editablePaymentOrder as any).payment_status ||
      (editablePaymentOrder as any).paymentStatus ||
      'pending'
    )
      .trim()
      .toLowerCase() || 'pending';

    setEditPaymentTarget({
      orderId: editablePaymentOrder.id,
      orderNumber: (editablePaymentOrder as any).order_number || (editablePaymentOrder as any).orderNumber,
      currentMethod: editablePaymentMethod,
      paymentStatus,
    });
    setShowEditOptionsModal(false);
    setShowEditPaymentModal(true);
  };

  const handleEditOrder = () => {
    setShowEditOptionsModal(false);

    // Get the order being edited to determine its type
    if (pendingEditOrders.length > 0) {
      const orderToEdit = orders.find(order => order.id === pendingEditOrders[0]);
      if (orderToEdit) {
        // Store the order ID, supabase ID, and number before opening the modal
        // This ensures they persist even if pendingEditOrders gets cleared
        setCurrentEditOrderId(orderToEdit.id);
        setCurrentEditSupabaseId(orderToEdit.supabase_id || (orderToEdit as any).supabaseId);
        setCurrentEditOrderNumber(orderToEdit.order_number || orderToEdit.orderNumber);

        console.log('[OrderDashboard] handleEditOrder - orderId:', orderToEdit.id, 'supabaseId:', orderToEdit.supabase_id, 'orderNumber:', orderToEdit.order_number || orderToEdit.orderNumber);

        // Determine order type - handle both camelCase and snake_case
        const orderTypeValue = (orderToEdit.orderType || (orderToEdit as any).order_type || 'pickup') as string;
        // Map dine-in to pickup for menu display purposes
        const menuOrderType = (orderTypeValue === 'dine-in' || orderTypeValue === 'dine_in')
          ? 'pickup'
          : (orderTypeValue === 'delivery' ? 'delivery' : 'pickup');
        setEditingOrderType(menuOrderType);
      }
    }

    // Open the menu-based edit modal instead of the simple edit modal
    setShowEditMenuModal(true);
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

  const handlePaymentMethodSave = async (nextMethod: 'cash' | 'card') => {
    if (!editPaymentTarget) {
      toast.error(t('orderDashboard.paymentMethodEditUnavailable'));
      return;
    }

    if (editPaymentTarget.currentMethod === nextMethod) {
      toast.success(t('orderDashboard.paymentMethodNoChange'));
      return;
    }

    setIsUpdatingPaymentMethod(true);
    try {
      const result: any = await bridge.payments.updatePaymentStatus(
        editPaymentTarget.orderId,
        editPaymentTarget.paymentStatus,
        nextMethod
      );
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to update payment method');
      }

      toast.success(t('orderDashboard.paymentMethodUpdated'));
      await loadOrders();
      setShowEditPaymentModal(false);
      setEditPaymentTarget(null);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
      setSelectedOrders([]);
    } catch (error) {
      console.error('Failed to update payment method:', error);
      toast.error(t('orderDashboard.paymentMethodUpdateFailed'));
    } finally {
      setIsUpdatingPaymentMethod(false);
    }
  };

  // Handle customer info edit
  const handleCustomerInfoSave = async (customerInfo: { name: string; phone: string; email?: string; address?: string }) => {
    try {
      // Update customer info for all pending edit orders
      for (const orderId of pendingEditOrders) {
        // Here you would typically call an API to update the order
        // await updateOrderCustomerInfo(orderId, customerInfo);
      }

      toast.success(t('orderDashboard.customerInfoUpdated', { count: pendingEditOrders.length }));

      // Close modal and clear state
      setShowEditCustomerModal(false);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
      setSelectedOrders([]);
    } catch (error) {
      console.error('Failed to update customer info:', error);
      toast.error(t('orderDashboard.customerInfoFailed'));
    }
  };

  const handleEditCustomerClose = () => {
    setShowEditCustomerModal(false);
    setPendingEditOrders([]);
    setEditingSingleOrder(null);
  };

  // Handle order items edit
  const handleOrderItemsSave = async (items: OrderItem[], orderNotes?: string) => {
    try {
      // Update order items for all pending edit orders
      for (const orderId of pendingEditOrders) {
        const result = await bridge.invoke('order:update-items', {
          orderId,
          items,
          orderNotes
        });

        if (!result?.success) {
          throw new Error(result?.error || 'Failed to update order items');
        }
      }

      toast.success(t('orderDashboard.orderItemsUpdated', { count: pendingEditOrders.length }));

      // Refresh orders to show updated data
      await loadOrders();

      // Close modal and clear state
      setShowEditOrderModal(false);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
      setSelectedOrders([]);
    } catch (error) {
      console.error('Failed to update order items:', error);
      toast.error(t('orderDashboard.orderItemsFailed'));
    }
  };

  const handleEditOrderClose = () => {
    setShowEditOrderModal(false);
    setPendingEditOrders([]);
    setEditingSingleOrder(null);
  };

  // Handle menu-based order edit completion
  const handleEditMenuComplete = async (orderData: {
    orderId: string;
    items: any[];
    total: number;
    notes?: string;
  }) => {
    try {
      const result = await bridge.invoke('order:update-items', {
        orderId: orderData.orderId,
        items: orderData.items,
        orderNotes: orderData.notes
      });

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to update order items');
      }

      toast.success(t('orderDashboard.orderItemsUpdated', { count: 1 }));

      // Refresh orders to show updated data
      await loadOrders();

      // Close modal and clear state
      setShowEditMenuModal(false);
      setPendingEditOrders([]);
      setEditingSingleOrder(null);
      setSelectedOrders([]);
      // Clear the persisted edit order details
      setCurrentEditOrderId(undefined);
      setCurrentEditOrderNumber(undefined);
      setCurrentEditSupabaseId(undefined);
    } catch (error) {
      console.error('Failed to update order items:', error);
      toast.error(t('orderDashboard.orderItemsFailed'));
    }
  };

  const handleEditMenuClose = () => {
    setShowEditMenuModal(false);
    setPendingEditOrders([]);
    setEditingSingleOrder(null);
    // Clear the persisted edit order details
    setCurrentEditOrderId(undefined);
    setCurrentEditOrderNumber(undefined);
    setCurrentEditSupabaseId(undefined);
  };

  // Get customer info for the first selected order (for editing)
  const getSelectedOrderCustomerInfo = () => {
    if (pendingEditOrders.length === 0) return { name: '', phone: '', address: '', notes: '' };

    const firstOrder = orders.find(order => order.id === pendingEditOrders[0]);
    return {
      name: firstOrder?.customerName || '',
      phone: firstOrder?.customerPhone || '',
      address: '', // Add address field to order type if needed
      notes: firstOrder?.notes || ''
    };
  };

  // Get order items for the first selected order (for editing)
  const getSelectedOrderItems = () => {
    if (pendingEditOrders.length === 0) {
      console.log('[OrderDashboard] getSelectedOrderItems: No pending edit orders');
      return [];
    }

    const firstOrder = orders.find(order => order.id === pendingEditOrders[0]);
    console.log('[OrderDashboard] getSelectedOrderItems: firstOrder:', firstOrder?.id, 'items:', firstOrder?.items?.length, firstOrder?.items);
    return firstOrder?.items || [];
  };

  // Get order number for the first selected order (for display in edit modal)
  // Requirements: 7.7 - Display same order_number in edit modal as shown in grid
  const getSelectedOrderNumber = (): string | undefined => {
    if (pendingEditOrders.length === 0) return undefined;

    const firstOrder = orders.find(order => order.id === pendingEditOrders[0]);
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
  const handleResolveConflict = async (conflictId: string, strategy: string) => {
    try {
      await resolveConflict(conflictId, strategy as 'accept_local' | 'accept_remote' | 'merge');
      toast.success(t('orderDashboard.conflictResolved'));
    } catch (error) {
      toast.error(t('orderDashboard.conflictFailed'));
      console.error('Conflict resolution error:', error);
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
          showDetails={process.env.NODE_ENV === 'development'}
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
          activeTab={activeTab}
          onBulkAction={handleBulkAction}
          onClearSelection={handleClearSelection}
          isLoading={isBulkActionLoading}
        />
      </div>

      {/* Orders Grid or Tables Grid based on active tab */}
      {activeTab === 'tables' ? (
        /* Tables Grid - shown when Tables tab is active */
        <div ref={orderGridRef} className={`rounded-xl p-4 ${resolvedTheme === 'light'
          ? 'bg-white/80 border border-gray-200/50'
          : 'bg-white/5 border border-white/10'
          }`}>
          {tables.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <svg className={`w-16 h-16 mb-4 ${resolvedTheme === 'light' ? 'text-gray-300' : 'text-white/20'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.87c1.355 0 2.697.055 4.024.165C17.155 8.51 18 9.473 18 10.608v2.513m-3-4.87v-1.5m-6 1.5v-1.5m12 9.75l-1.5.75a3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0L3 16.5m15-3.38a48.474 48.474 0 00-6-.37c-2.032 0-4.034.125-6 .37m12 0c.39.049.777.102 1.163.16 1.07.16 1.837 1.094 1.837 2.175v5.17c0 .62-.504 1.124-1.125 1.124H4.125A1.125 1.125 0 013 20.625v-5.17c0-1.08.768-2.014 1.837-2.174A47.78 47.78 0 016 13.12" />
              </svg>
              <p className={`text-lg font-medium ${resolvedTheme === 'light' ? 'text-gray-500' : 'text-white/50'}`}>
                {t('tables.noTables') || 'No tables configured'}
              </p>
              <p className={`text-sm mt-1 ${resolvedTheme === 'light' ? 'text-gray-400' : 'text-white/30'}`}>
                {t('tables.configureInAdmin') || 'Configure tables in the Admin Dashboard'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
              {tables.map((table) => {
                const statusColors: Record<TableStatus, string> = {
                  available: 'border-green-500 bg-green-500/10 text-green-500',
                  occupied: 'border-blue-500 bg-blue-500/10 text-blue-500',
                  reserved: 'border-yellow-500 bg-yellow-500/10 text-yellow-500',
                  cleaning: 'border-gray-500 bg-gray-500/10 text-gray-500',
                  maintenance: 'border-orange-500 bg-orange-500/10 text-orange-500',
                  unavailable: 'border-slate-500 bg-slate-500/10 text-slate-500',
                };
                return (
                  <button
                    key={table.id}
                    onClick={() => handleTableSelect(table)}
                    className={`aspect-square p-3 rounded-xl border-2 transition-all hover:scale-105 active:scale-95 ${statusColors[table.status]}`}
                  >
                    <div className="h-full flex flex-col items-center justify-center">
                      <span className="text-2xl font-bold">#{table.tableNumber}</span>
                      <span className="text-xs mt-1 opacity-70">{table.capacity} seats</span>
                      <span className="text-[10px] mt-1 capitalize">{table.status}</span>
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
            activeTab={activeTab as 'orders' | 'delivered' | 'canceled'}
          />
        </div>
      )}

      {/* Floating Action Button for New Order */}
      <button
        onClick={handleNewOrderClick}
        disabled={!isShiftActive}
        className={`fixed bottom-6 right-6 w-16 h-16 rounded-full shadow-lg transition-all duration-300 z-50 ${!isShiftActive
          ? 'bg-gray-400 cursor-not-allowed opacity-50'
          : resolvedTheme === 'light'
            ? 'bg-blue-600 hover:bg-blue-700 text-white hover:scale-110 active:scale-95'
            : 'bg-blue-500 hover:bg-blue-600 text-white hover:scale-110 active:scale-95'
          }`}
        title={!isShiftActive ? t('orders.startShiftFirst', 'Start a shift first to create orders') : t('orders.newOrder')}
      >
        <Plus size={24} className="mx-auto" />
      </button>

      {/* Order Type Selection Modal - Glassmorphism style */}
      <LiquidGlassModal
        isOpen={showOrderTypeModal}
        onClose={() => setShowOrderTypeModal(false)}
        title={t('orderFlow.selectOrderType') || 'Select Order Type'}
        className="!max-w-lg"
      >
        <div className="p-2">
          {isOrderTypeTransitioning ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
              <span className="ml-3 text-white/70">{t('orderFlow.settingUpOrder') || 'Setting up order...'}</span>
            </div>
          ) : (
            <div className={`grid gap-4 ${hasDeliveryModule && hasTablesModule ? 'grid-cols-3' : hasDeliveryModule || hasTablesModule ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {/* Delivery Button - Yellow (only if Delivery module acquired) */}
              {hasDeliveryModule && (
                <button
                  onClick={() => handleOrderTypeSelect('delivery')}
                  className="group relative p-6 rounded-2xl border-2 border-yellow-400/30 bg-gradient-to-br from-yellow-500/10 to-yellow-600/5 hover:from-yellow-500/20 hover:to-yellow-600/10 hover:border-yellow-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-yellow-500/20"
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      <svg className="w-full h-full text-yellow-400 group-hover:text-yellow-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <h3 className="text-lg font-bold text-yellow-400 group-hover:text-yellow-300 transition-colors mb-1">
                        {t('orderFlow.deliveryOrder') || 'Delivery Order'}
                      </h3>
                      <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        {t('orderFlow.deliveryDescription', { defaultValue: 'Delivery to customer' })}
                      </p>
                    </div>
                  </div>
                </button>
              )}

              {/* Pickup Button - Green (always available) */}
              <button
                onClick={() => handleOrderTypeSelect('pickup')}
                className="group relative p-6 rounded-2xl border-2 border-green-400/30 bg-gradient-to-br from-green-500/10 to-green-600/5 hover:from-green-500/20 hover:to-green-600/10 hover:border-green-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-green-500/20"
              >
                <div className="flex flex-col items-center gap-3">
                  <div className="w-16 h-16 flex items-center justify-center">
                    <svg className="w-full h-full text-green-400 group-hover:text-green-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.75c0 .415.336.75.75.75z" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <h3 className="text-lg font-bold text-green-400 group-hover:text-green-300 transition-colors mb-1">
                      {t('orderFlow.pickupOrder') || 'Pickup Order'}
                    </h3>
                    <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        {t('orderFlow.pickupDescription', { defaultValue: 'Pickup at store' })}
                    </p>
                  </div>
                </div>
              </button>

              {/* Table Button - Blue (only if Tables module acquired) */}
              {hasTablesModule && (
                <button
                  onClick={() => handleOrderTypeSelect('dine-in')}
                  className="group relative p-6 rounded-2xl border-2 border-blue-400/30 bg-gradient-to-br from-blue-500/10 to-blue-600/5 hover:from-blue-500/20 hover:to-blue-600/10 hover:border-blue-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20"
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      <svg className="w-full h-full text-blue-400 group-hover:text-blue-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.87c1.355 0 2.697.055 4.024.165C17.155 8.51 18 9.473 18 10.608v2.513m-3-4.87v-1.5m-6 1.5v-1.5m12 9.75l-1.5.75a3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0L3 16.5m15-3.38a48.474 48.474 0 00-6-.37c-2.032 0-4.034.125-6 .37m12 0c.39.049.777.102 1.163.16 1.07.16 1.837 1.094 1.837 2.175v5.17c0 .62-.504 1.124-1.125 1.124H4.125A1.125 1.125 0 013 20.625v-5.17c0-1.08.768-2.014 1.837-2.174A47.78 47.78 0 016 13.12M12.265 3.11a.375.375 0 11-.53 0L12 2.845l.265.265zm-3 0a.375.375 0 11-.53 0L9 2.845l.265.265zm6 0a.375.375 0 11-.53 0L15 2.845l.265.265z" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <h3 className="text-lg font-bold text-blue-400 group-hover:text-blue-300 transition-colors mb-1">
                        {t('orderFlow.tableOrder') || 'Table Order'}
                      </h3>
                      <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        {t('orderFlow.tableDescription') || 'Dine-in order'}
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
          onClose={() => setShowPhoneLookupModal(false)}
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
          onClose={() => {
            setShowAddCustomerModal(false);
            setExistingCustomer(null);
            setCustomerModalMode('new');
          }}
          onCustomerAdded={handleNewCustomerAdded}
          initialPhone={phoneNumber}
          initialCustomer={existingCustomer ? {
            id: existingCustomer.id,
            phone: existingCustomer.phone || '',
            name: existingCustomer.name,
            email: existingCustomer.email,
            address: existingCustomer.addresses?.[0]?.street || (existingCustomer as any).address,
            city: existingCustomer.addresses?.[0]?.city || (existingCustomer as any).city,
            postal_code: existingCustomer.addresses?.[0]?.postal_code || (existingCustomer as any).postal_code,
            floor_number: existingCustomer.addresses?.[0]?.floor_number || (existingCustomer as any).floor_number,
            notes: existingCustomer.addresses?.[0]?.delivery_notes || (existingCustomer as any).notes,
            name_on_ringer: (existingCustomer as any).name_on_ringer,
          } : undefined}
          mode={customerModalMode}
        />
      )}

      {/* Customer Info Modal (New Order Flow) */}
      {showCustomerInfoModal && (
        <CustomerInfoModal
          isOpen={showCustomerInfoModal}
          onClose={() => setShowCustomerInfoModal(false)}
          onSave={handleNewOrderCustomerInfoSave}
          initialData={customerInfo ? {
            name: customerInfo.name,
            phone: customerInfo.phone,
            address: customerInfo.address?.street || '',
            coordinates: customerInfo.address?.coordinates,
          } : {
            name: '',
            phone: phoneNumber,
            address: '',
          }}
          orderType={orderType === 'delivery' ? 'delivery' : orderType === 'pickup' ? 'pickup' : 'dine-in'}
        />
      )}

      {/* Menu Modal */}
      <MenuModal
        isOpen={showMenuModal}
        onClose={handleMenuModalClose}
        selectedCustomer={getCustomerForMenu()}
        selectedAddress={getSelectedAddress()}
        orderType={selectedOrderType || 'pickup'}
        deliveryZoneInfo={deliveryZoneInfo}
        onOrderComplete={handleOrderComplete}
      />

      {/* Order Approval Panel */}
      {showApprovalPanel && selectedOrderForApproval && (
        <OrderApprovalPanel
          order={selectedOrderForApproval}
          onApprove={handleApproveOrder}
          onDecline={handleDeclineOrder}
          onClose={() => {
            setShowApprovalPanel(false);
            setSelectedOrderForApproval(null);
            setIsViewOnlyMode(true); // Reset to view-only mode
          }}
          viewOnly={isViewOnlyMode}
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
        onEditPayment={handleEditPayment}
        canEditPayment={canEditPaymentMethod}
        paymentEditHint={paymentEditIneligibilityReason}
        onClose={handleEditOptionsClose}
      />

      <EditPaymentMethodModal
        isOpen={showEditPaymentModal}
        orderNumber={editPaymentTarget?.orderNumber}
        currentMethod={editPaymentTarget?.currentMethod || 'cash'}
        isSaving={isUpdatingPaymentMethod}
        onSave={handlePaymentMethodSave}
        onClose={handleEditPaymentClose}
      />

      <EditCustomerInfoModal
        isOpen={showEditCustomerModal}
        orderCount={pendingEditOrders.length}
        initialCustomerInfo={getSelectedOrderCustomerInfo()}
        onSave={handleCustomerInfoSave}
        onClose={handleEditCustomerClose}
      />

      <EditOrderItemsModal
        isOpen={showEditOrderModal}
        orderCount={pendingEditOrders.length}
        orderId={pendingEditOrders.length > 0 ? pendingEditOrders[0] : undefined}
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
            const result: any = await bridge.payments.printReceipt(receiptPreviewOrderId);
            if (result?.success === false) {
              throw new Error(result?.error || 'Failed to queue receipt print');
            }
            toast.success(t('orderDashboard.receiptQueued') || 'Receipt print queued');
          } catch (error: any) {
            console.error('[OrderDashboard] Failed to print receipt from preview:', error);
            toast.error(error?.message || 'Failed to print receipt');
          } finally {
            setReceiptPreviewPrinting(false);
          }
        }}
        title={t('orderDashboard.receiptPreview') || 'Receipt Preview'}
        previewHtml={receiptPreviewHtml || ''}
        isPrinting={receiptPreviewPrinting}
      />
    </div>
  );
});

OrderDashboard.displayName = 'OrderDashboard';

export default OrderDashboard;

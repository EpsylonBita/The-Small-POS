import { memo, useState, useCallback, useEffect } from 'react';
import { POSGlassModal } from './ui/pos-glass-components';
import { MenuModal } from './modals/MenuModal';
import { ProductCatalogModal } from './modals/ProductCatalogModal';
import { CustomerSearchModal } from './modals/CustomerSearchModal';
import { AddCustomerModal } from './modals/AddCustomerModal';
import { AddressSelectionModal } from './modals/AddressSelectionModal';
import { ZoneValidationAlert } from './delivery/ZoneValidationAlert';
import { FloatingActionButton } from './ui/FloatingActionButton';
import { TableSelector, TableActionModal, ReservationForm } from './tables';
import type { CreateReservationDto } from './tables';
import { reservationsService } from '../services/ReservationsService';
import { useOrderStore } from '../hooks/useOrderStore';
import { useShift } from '../contexts/shift-context';
import { useI18n } from '../contexts/i18n-context';
import { useAcquiredModules } from '../hooks/useAcquiredModules';
import { useTables } from '../hooks/useTables';
import { useModules } from '../contexts/module-context';
import { useFeatures } from '../hooks/useFeatures';
import toast from 'react-hot-toast';
import { useDeliveryValidation } from '../hooks/useDeliveryValidation';
import type { DeliveryBoundaryValidationResponse } from '../../../../shared/types/delivery-validation';
import type { RestaurantTable } from '../types/tables';
import { ActivityTracker } from '../services/ActivityTracker';
import { useTerminalSettings } from '../hooks/useTerminalSettings';


interface OrderFlowProps {
  className?: string;
  /** Force retail mode - always show ProductCatalogModal instead of MenuModal */
  forceRetailMode?: boolean;
}

interface Customer {
  id: string;
  phone: string;
  name: string;
  email?: string;
  address?: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  name_on_ringer?: string;
  addresses?: Array<{
    id: string;
    street_address: string;
    city: string;
    postal_code?: string;
    floor_number?: string;
    notes?: string;
    address_type: string;
    is_default: boolean;
    created_at: string;
  }>;
}

/**
 * Complete Order Flow Component
 * Handles the full order creation workflow from type selection to completion
 */
const OrderFlow = memo<OrderFlowProps>(({ className = '', forceRetailMode = false }) => {
  const { t } = useI18n();
  const { isFeatureEnabled } = useFeatures();
  const canCreateOrders = isFeatureEnabled('orderCreation');

  // Modal states
  const [isOrderTypeModalOpen, setIsOrderTypeModalOpen] = useState(false);
  const [isCustomerSearchModalOpen, setIsCustomerSearchModalOpen] = useState(false);
  const [isAddCustomerModalOpen, setIsAddCustomerModalOpen] = useState(false);
  const [isAddressSelectionModalOpen, setIsAddressSelectionModalOpen] = useState(false);
  const [isMenuModalOpen, setIsMenuModalOpen] = useState(false);

  // Customer modal mode: 'new' | 'edit' | 'addAddress'
  const [customerModalMode, setCustomerModalMode] = useState<'new' | 'edit' | 'addAddress'>('new');
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
  const { createOrder } = useOrderStore();

  // Shift context for linking orders to shifts
  const { staff, activeShift, isShiftActive } = useShift();
  const { requestOverride } = useDeliveryValidation();

  // Module-based feature flags
  const { hasDeliveryModule, hasTablesModule } = useAcquiredModules();

  // Get organizationId and businessType from module context (with localStorage fallback)
  const { organizationId: moduleOrgId, businessType } = useModules();

  // Check if this is a retail vertical (uses product catalog instead of menu)
  // forceRetailMode allows ProductCatalogView to force retail mode regardless of businessType
  const isRetailVertical = forceRetailMode || businessType === 'retail';
  
  // Get branchId and organizationId from localStorage (set during terminal setup)
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  useEffect(() => {
    const storedBranchId = localStorage.getItem('branch_id');
    const storedOrgId = localStorage.getItem('organization_id');
    setBranchId(storedBranchId);
    setLocalOrgId(storedOrgId);
  }, []);

  // Use module context organizationId if available, otherwise fall back to localStorage
  const organizationId = moduleOrgId || localOrgId;

  // Fetch tables for table orders - use actual IDs
  // Only enable fetching when both IDs are available
  const { tables } = useTables({ 
    branchId: branchId || '', 
    organizationId: organizationId || '',
    enabled: Boolean(branchId && organizationId)
  });

  // Table order flow states
  const [showTableSelector, setShowTableSelector] = useState(false);
  const [showTableActionModal, setShowTableActionModal] = useState(false);
  const [showReservationForm, setShowReservationForm] = useState(false);
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [tableNumber, setTableNumber] = useState('');

  // Fetch tax rate from terminal settings; auto-updates on settings change
  const { getSetting } = useTerminalSettings();
  useEffect(() => {
    const rate = getSetting<number>('tax', 'tax_rate_percentage', 24);
    if (typeof rate === 'number' && rate >= 0 && rate <= 100) {
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
    setIsAddressSelectionModalOpen(false);
    setIsMenuModalOpen(false);
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
        name: t('orderFlow.walkInCustomer'),
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
    setSelectedCustomer(customer);
    setIsCustomerSearchModalOpen(false);

    // Check if a specific address was already selected (from CustomerSearchModal)
    const selectedAddressId = (customer as any).selected_address_id;
    if (selectedAddressId && customer.addresses) {
      const selectedAddr = customer.addresses.find((a: any) => a.id === selectedAddressId);
      if (selectedAddr) {
        // Address already selected, skip address selection modal
        setSelectedAddress(selectedAddr);
        setIsMenuModalOpen(true);
        return;
      }
    }

    // If customer has multiple addresses and none pre-selected, show address selection modal
    if (customer.addresses && customer.addresses.length > 1) {
      setIsAddressSelectionModalOpen(true);
    } else if (customer.addresses && customer.addresses.length === 1) {
      // Single address, use it directly
      setSelectedAddress(customer.addresses[0]);
      setIsMenuModalOpen(true);
    } else {
      // No addresses, proceed to menu (will need to add address later)
      setIsMenuModalOpen(true);
    }
  }, []);

  const [newCustomerInitialPhone, setNewCustomerInitialPhone] = useState<string>('');

  const handleAddNewCustomer = useCallback((phone: string) => {
    setIsCustomerSearchModalOpen(false);
    setNewCustomerInitialPhone((phone || '').trim());
    setCustomerToEdit(null);
    setCustomerModalMode('new');
    setIsAddCustomerModalOpen(true);
  }, []);

  const handleAddressSelected = useCallback((customer: Customer, address: any, validationResult?: DeliveryBoundaryValidationResponse) => {
    setSelectedCustomer(customer);
    setSelectedAddress(address);
    setDeliveryZoneInfo(validationResult || null);
    setIsAddressSelectionModalOpen(false);

    // Check if we can proceed directly to menu
    if (validationResult?.uiState?.canProceed) {
      // Validation passed, proceed to menu
      setIsMenuModalOpen(true);
    } else if (validationResult) {
      // Validation issues exist, show zone alert instead of proceeding
      setShowZoneAlert(true);
      toast(t('orderFlow.zoneValidationRequired'), {
        duration: 3000,
        icon: '⚠️',
        style: { background: '#f59e0b', color: 'white' }
      });
    } else {
      // No validation result (shouldn't happen), proceed with warning
      toast(t('orderFlow.noValidationResult'), {
        duration: 3000,
        icon: '⚠️',
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
    setIsAddressSelectionModalOpen(false);
    setIsAddCustomerModalOpen(true);
  }, []);

  const handleAddressAdded = useCallback((customer: Customer) => {
    // Address was added via AddCustomerModal - customer now has new address data
    setSelectedCustomer(customer);
    setSelectedAddress({
      street_address: customer.address,
      postal_code: customer.postal_code,
      floor_number: customer.floor_number,
      notes: customer.notes,
    });
    setCustomerToEdit(null);
    setCustomerModalMode('new');
    setIsAddCustomerModalOpen(false);
    setIsMenuModalOpen(true);
    toast.success(t('orderFlow.addressAdded'));
  }, [t]);

  const handleEditCustomer = useCallback((customer: Customer) => {
    // For editing, we reuse the AddCustomerModal with the customer's data pre-filled
    setCustomerToEdit(customer);
    setCustomerModalMode('edit');
    setIsCustomerSearchModalOpen(false);
    setIsAddCustomerModalOpen(true);
  }, []);

  const handleCustomerAdded = useCallback((newCustomer: Customer) => {
    const wasEditing = !!customerToEdit;
    setSelectedCustomer(newCustomer);
    setIsAddCustomerModalOpen(false);
    setCustomerToEdit(null); // Clear edit state

    // If new customer has addresses, use the first one
    if (newCustomer.addresses && newCustomer.addresses.length > 0) {
      setSelectedAddress(newCustomer.addresses[0]);
    }

    setIsMenuModalOpen(true);
    toast.success(wasEditing ? t('orderFlow.customerUpdated') : t('orderFlow.customerAdded'));
  }, [t, customerToEdit]);

  const handleMenuModalClose = useCallback(() => {
    resetFlow();
  }, [resetFlow]);

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
    // If customer has multiple addresses, show selection modal
    if (selectedCustomer?.addresses && selectedCustomer.addresses.length > 1) {
      setIsAddressSelectionModalOpen(true);
    } else {
      // Otherwise, go back to customer search to select different customer
      setSelectedCustomer(null);
      setIsCustomerSearchModalOpen(true);
    }
  }, [selectedCustomer]);

  const handleSwitchToPickup = useCallback(() => {
    setShowZoneAlert(false);
    setDeliveryZoneInfo(null);
    setSelectedAddress(null);
    setSelectedOrderType('pickup');

    // Create pickup customer and proceed to menu
    const pickupCustomer: Customer = {
      id: 'pickup-customer',
      name: t('orderFlow.walkInCustomer'),
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
        name: t('orderFlow.tableCustomer', { table: selectedTable.tableNumber }) || `Table ${selectedTable.tableNumber}`,
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
      setShowTableActionModal(false);
      setShowReservationForm(true);
    }
  }, [selectedTable]);

  // Handle reservation form submission
  const handleReservationSubmit = useCallback(async (data: CreateReservationDto) => {
    if (!branchId || !organizationId) {
      toast.error(t('orderFlow.missingContext') || 'Missing branch or organization context');
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
      
      toast.success(t('orderFlow.reservationCreated') || 'Reservation created successfully');
      setShowReservationForm(false);
      setSelectedTable(null);
    } catch (error) {
      console.error('Failed to create reservation:', error);
      toast.error(t('orderFlow.reservationFailed') || 'Failed to create reservation');
    }
  }, [t, branchId, organizationId]);

  // Handle reservation form cancel
  const handleReservationCancel = useCallback(() => {
    setShowReservationForm(false);
    setSelectedTable(null);
  }, []);

  // Handle order completion from menu
  const handleOrderComplete = useCallback(async (orderData: any) => {
    setIsProcessingOrder(true);

    try {
      // Calculate delivery details
      let deliveryAddress = null;
      let deliveryFee = 0;
      let deliveryZoneId = null;
      let zoneName = null;
      let estimatedDeliveryTime = null;

      if (selectedOrderType === 'delivery' && selectedAddress) {
        deliveryAddress = `${selectedAddress.street_address}, ${selectedAddress.city}`;
        if (selectedAddress.postal_code) {
          deliveryAddress += ` ${selectedAddress.postal_code}`;
        }
        if (selectedAddress.floor_number) {
          deliveryAddress += `, Floor: ${selectedAddress.floor_number}`;
        }

        // Use delivery zone info if available, otherwise fallback to default
        if (deliveryZoneInfo?.zone) {
          deliveryFee = deliveryZoneInfo.zone.deliveryFee;
          deliveryZoneId = deliveryZoneInfo.zone.id;
          zoneName = deliveryZoneInfo.zone.name;
          estimatedDeliveryTime = deliveryZoneInfo.zone.estimatedTime;
        } else {
          deliveryFee = 2.50; // Default delivery fee fallback
        }
      }

      // Extract discount information
      const discountPercentage = orderData.discountPercentage || 0;
      const discountAmount = orderData.discountAmount || 0;

      // Calculate tax using settings (applied after discount)
      const subtotalAfterDiscount = orderData.total; // Already includes discount
      const tax = Math.round(subtotalAfterDiscount * (taxRatePercentage / 100) * 100) / 100;
      const total_amount = subtotalAfterDiscount + deliveryFee;

      // Warn if no active shift
      if (!isShiftActive) {
        toast(t('orderFlow.noActiveShift'), {
          duration: 3000,
          icon: '⚠️',
          style: { background: '#f59e0b', color: 'white' }
        });
      }

      // Create order object matching the API expected format and shared types
      const orderToCreate = {
        // API required fields
        customer_id: selectedCustomer?.id !== 'pickup-customer' ? selectedCustomer?.id : null,
        items: orderData.items.map((item: any) => ({
          menu_item_id: item.menuItemId || item.menu_item_id || item.id, // Use menuItemId (Supabase UUID) instead of id (cart ID)
          quantity: item.quantity,
          price: item.price,
          customizations: item.customizations || item.selectedIngredients || null
        })),

        // Use total_amount instead of total (matching shared types)
        total_amount: total_amount,
        subtotal: subtotalAfterDiscount,
        tax,
        delivery_fee: deliveryFee,

        // Discount fields (matching shared types)
        discount_percentage: discountPercentage,
        discount_amount: discountAmount,

        status: 'pending' as const,
        payment_method: orderData.paymentData?.method || null,
        delivery_address: deliveryAddress,
        notes: orderData.notes || null,

        // Driver assignment for delivery orders
        driver_id: orderData.paymentData?.driverId || null,

        // Delivery zone metadata
        delivery_zone_id: deliveryZoneId,
        zone_name: zoneName,
        estimated_delivery_time: estimatedDeliveryTime,
        delivery_zone_validation: deliveryZoneInfo ? JSON.stringify({
          deliveryAvailable: deliveryZoneInfo.deliveryAvailable,
          requiresManagerApproval: deliveryZoneInfo.uiState?.requiresManagerApproval || false,
          validatedAt: new Date().toISOString()
        }) : null,

        // Additional fields for local storage compatibility
        orderNumber: `ORD-${Date.now().toString().slice(-6)}`,
        customerName: selectedCustomer?.name || t('orderFlow.walkInCustomer'),
        customerPhone: selectedCustomer?.phone || '',
        orderType: selectedOrderType as 'pickup' | 'delivery',
        paymentStatus: (orderData.paymentData ? 'completed' : 'pending') as 'pending' | 'completed' | 'processing' | 'failed' | 'refunded',
        paymentTransactionId: orderData.paymentData?.transactionId || undefined,
        estimatedTime: 15,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),

        // Shift-related fields
        staff_shift_id: activeShift?.id || null,
        staff_id: staff?.staffId || null
      };

      // Create order using the store method (handles both local storage and Supabase sync)

      // Ensure a cashier shift is active before allowing order creation
      try {
        const branchId = staff?.branchId || await (window as any).electronAPI.getTerminalBranchId();
        const terminalId = staff?.terminalId || await (window as any).electronAPI.getTerminalId();
        const activeCashier = await (window as any).electronAPI.getActiveCashierByTerminal(branchId, terminalId);
        if (!activeCashier) {
          toast.error(t('orderFlow.noActiveCashierShift') || 'Cannot create orders until a cashier opens the day.');
          setIsProcessingOrder(false);
          return;
        }
      } catch (err) {
        console.error('Failed to verify active cashier shift', err);
        toast.error(t('orderFlow.noActiveCashierShift') || 'Cannot create orders until a cashier opens the day.');
        setIsProcessingOrder(false);
        return;
      }

      const result = await createOrder(orderToCreate);

      if (result.success) {
        toast.success(t('orderFlow.orderCreated', { orderNumber: orderToCreate.orderNumber }));

        // Track order + discount application
        try {
          ActivityTracker.trackOrderCreated(result.orderId || orderToCreate.orderNumber, total_amount)
          ActivityTracker.trackDiscount(Boolean(discountAmount), discountAmount, discountPercentage)
        } catch {}

        // Record driver earnings for delivery orders
        if (selectedOrderType === 'delivery' && orderData.paymentData?.driverId && activeShift?.id) {
          try {
            const paymentMethod = orderData.paymentData.method;
            const cashCollected = paymentMethod === 'cash' ? (orderData.paymentData.cashReceived || total_amount) : 0;
            const cardAmount = paymentMethod === 'card' ? total_amount : 0;

            const earningResult = await window.electronAPI.recordDriverEarning({
              driverId: orderData.paymentData.driverId,
              shiftId: activeShift.id,
              orderId: (result.orderId || orderToCreate.orderNumber),
              deliveryFee: deliveryFee,
              tipAmount: 0, // Could be enhanced to collect tips
              paymentMethod: paymentMethod,
              cashCollected: cashCollected,
              cardAmount: cardAmount
            });

            if (!earningResult.success) {
              console.error('Failed to record driver earning:', earningResult.error);
              // Don't fail the order, just log the error
              toast.error(t('orderFlow.driverEarningFailed'));
            }
          } catch (earningError) {
            console.error('Error recording driver earning:', earningError);
            // Don't fail the order, just log the error
          }
        }

        // Additional success feedback for delivery orders
        if (selectedOrderType === 'delivery' && deliveryAddress) {
          setTimeout(() => {
            toast.success(t('orderFlow.deliveryTo', { address: deliveryAddress }), { duration: 4000 });
          }, 1000);
        }

        resetFlow();
      } else {
        toast.error(t('orderFlow.orderFailed'));
        if ('error' in result) {
          console.error('Order creation failed:', result.error);
        }
      }
    } catch (error) {
      console.error('Error creating order:', error);
      toast.error(t('orderFlow.orderFailed'));
    } finally {
      setIsProcessingOrder(false);
    }
  }, [selectedCustomer, selectedOrderType, selectedAddress, deliveryZoneInfo, createOrder, resetFlow, activeShift, isShiftActive, staff, taxRatePercentage]);

  return (
    <div className={`order-flow ${className}`}>
      {/* Floating Action Button for New Order - hidden when order creation is disabled */}
      {canCreateOrders && (
        <FloatingActionButton
          onClick={handleStartNewOrder}
          disabled={!isShiftActive}
          aria-label={t('orderFlow.startNewOrder')}
          title={!isShiftActive ? t('orders.startShiftFirst', 'Start a shift first to create orders') : undefined}
          className={!isShiftActive ? 'bg-gray-400 cursor-not-allowed opacity-50 hover:scale-100 hover:bg-gray-400' : ''}
        />
      )}

      {/* Order Type Selection Modal */}
      <POSGlassModal
        isOpen={isOrderTypeModalOpen}
        onClose={() => setIsOrderTypeModalOpen(false)}
        title={t('orderFlow.selectOrderType')}
      >
        <div className="p-2">
          {isTransitioning ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
              <span className="ml-3 text-white/70">{t('orderFlow.settingUpOrder')}</span>
            </div>
          ) : (
            <div className={`grid gap-4 ${hasDeliveryModule && hasTablesModule ? 'grid-cols-3' : hasDeliveryModule || hasTablesModule ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {/* Delivery Button - Yellow (only if Delivery module acquired) */}
              {hasDeliveryModule && (
                <button
                  onClick={() => handleSelectOrderType('delivery')}
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
                        {t('orderFlow.deliveryOrder')}
                      </h3>
                      <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        Παράδοση στο σπίτι
                      </p>
                    </div>
                  </div>
                </button>
              )}

              {/* Pickup Button - Green (always available) */}
              <button
                onClick={() => handleSelectOrderType('pickup')}
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
                      {t('orderFlow.pickupOrder')}
                    </h3>
                    <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                      Παραλαβή από το κατάστημα
                    </p>
                  </div>
                </div>
              </button>

              {/* Table Button - Blue (only if Tables module acquired) */}
              {hasTablesModule && (
                <button
                  onClick={() => handleSelectOrderType('dine-in')}
                  className="group relative p-6 rounded-2xl border-2 border-blue-400/30 bg-gradient-to-br from-blue-500/10 to-blue-600/5 hover:from-blue-500/20 hover:to-blue-600/10 hover:border-blue-400/50 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20"
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 flex items-center justify-center">
                      {/* Round restaurant table icon */}
                      <svg className="w-full h-full text-blue-400 group-hover:text-blue-300 transition-colors" fill="currentColor" viewBox="0 0 24 24">
                        {/* Round table top (ellipse for 3D effect) */}
                        <ellipse cx="12" cy="6" rx="8" ry="3" />
                        {/* Table cloth/body */}
                        <path d="M4 6c0 0 1 6 8 6s8-6 8-6c0 1.5-2 5-8 5S4 7.5 4 6z" />
                        {/* Table pedestal */}
                        <rect x="10" y="12" width="4" height="6" rx="0.5" />
                        {/* Table base */}
                        <ellipse cx="12" cy="19" rx="4" ry="1.2" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <h3 className="text-lg font-bold text-blue-400 group-hover:text-blue-300 transition-colors mb-1">
                        {t('orderFlow.tableOrder')}
                      </h3>
                      <p className="text-xs text-white/60 group-hover:text-white/80 transition-colors">
                        {t('orderFlow.tableDescription')}
                      </p>
                    </div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      </POSGlassModal>

      {/* Customer Search Modal */}
      <CustomerSearchModal
        isOpen={isCustomerSearchModalOpen}
        onClose={() => setIsCustomerSearchModalOpen(false)}
        onCustomerSelected={handleCustomerSelected}
        onAddNewCustomer={handleAddNewCustomer}
        onAddNewAddress={handleAddNewAddress}
        onEditCustomer={handleEditCustomer}
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

      {/* Address Selection Modal */}
      {selectedCustomer && isAddressSelectionModalOpen && (
        <AddressSelectionModal
          isOpen={isAddressSelectionModalOpen}
          onClose={() => setIsAddressSelectionModalOpen(false)}
          customer={selectedCustomer}
          orderType={selectedOrderType || 'delivery'}
          onAddressSelected={handleAddressSelected}
          onAddNewAddress={handleAddNewAddress}
        />
      )}

      {/* Zone Validation Alert - Displayed when delivery zone validation requires attention */}
      {showZoneAlert && deliveryZoneInfo && selectedAddress && (
        <POSGlassModal
          isOpen={showZoneAlert}
          onClose={() => setShowZoneAlert(false)}
          title={t('orderFlow.deliveryZoneValidation')}
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
        </POSGlassModal>
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
    </div>
  );
});

OrderFlow.displayName = 'OrderFlow';

export default OrderFlow;
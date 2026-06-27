import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { MenuModal } from '../components/modals/MenuModal';
import { SplitPaymentModal } from '../components/modals/SplitPaymentModal';
import type { SplitPaymentResult } from '../components/modals/SplitPaymentModal';
import { AddCustomerModal } from '../components/modals/AddCustomerModal';
import { CustomerSearchModal } from '../components/modals/CustomerSearchModal';
import { CustomerInfoModal } from '../components/modals/CustomerInfoModal';
import { OrderConflictBanner } from '../components/OrderConflictBanner';
import PickupOrderIcon from '../components/icons/PickupOrderIcon';
import { useOrderStore } from '../hooks/useOrderStore';
import { useShift } from '../contexts/shift-context';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import toast from 'react-hot-toast';
import { customerService } from '../services';
import { NewOrderPageSkeleton } from '../components/skeletons/NewOrderPageSkeleton';
import { ErrorDisplay } from '../components/error/ErrorDisplay';
import { withTimeout, ErrorHandler, POSError } from '../../shared/utils/error-handler';
import { TIMING } from '../../shared/constants';
import { useAcquiredModules } from '../hooks/useAcquiredModules';
import { useFeatures } from '../hooks/useFeatures';
import { ActivityTracker } from '../services/ActivityTracker';
import { buildSplitPaymentItems } from '../utils/splitPaymentItems';
import type { SplitPaymentItem } from '../utils/splitPaymentItems';
import { resolveDeliveryFee } from '../utils/delivery-fee';
import {
  resolveCanonicalCustomerAddress,
  withMaterializedCustomerAddresses,
} from '../utils/customer-addresses';
import { resolvePersistedCustomerId } from '../utils/persisted-customer-id';
import { resolveActiveCashierShift } from '../utils/active-cashier';
import { parseSpecialAddressInput } from '../utils/specialAddress';
import { buildTableOrderCreateFields } from '../utils/tableOrderFlow';
import { formatTableDisplayNumber } from '../utils/table-display';
import {
  hasValidSyncedPosMenuItemId,
  normalizePosOrderItems,
} from '../../shared/utils/pos-order-items';
import { AlertTriangle } from 'lucide-react';
import { getBridge } from '../../lib';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

interface Customer {
  id: string;
  name: string;
  phone?: string;
  phone_number?: string;
  email?: string;
  address?: any;
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
  selected_address_id?: string | null;
  addresses?: any[];
  version?: number;
}

interface NewOrderPageProps {
  // Optional props if needed
}

interface CustomerInfo {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  address?: {
    id?: string;
    street: string;
    street_address?: string;
    city: string;
    postalCode: string;
    postal_code?: string;
    floor_number?: string;
    floor?: string;
    notes?: string;
    name_on_ringer?: string;
    coordinates?: { lat: number; lng: number };
    latitude?: number | null;
    longitude?: number | null;
    address_fingerprint?: string | null;
  };
}

const toLatLngCoordinates = (
  coordinates:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null
    | undefined,
  latitude?: number | null,
  longitude?: number | null,
): { lat: number; lng: number } | undefined => {
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
    return {
      lat: Number(latitude),
      lng: Number(longitude),
    };
  }

  return undefined;
};

const buildCustomerInfoFromCustomer = (customer: Customer): CustomerInfo => {
  const normalizedCustomer = withMaterializedCustomerAddresses(customer) as Customer;
  const resolvedAddress = resolveCanonicalCustomerAddress(normalizedCustomer);
  const coordinates = toLatLngCoordinates(
    resolvedAddress?.coordinates ?? normalizedCustomer.coordinates,
    resolvedAddress?.latitude ?? normalizedCustomer.latitude,
    resolvedAddress?.longitude ?? normalizedCustomer.longitude,
  );

  return {
    name: normalizedCustomer.name,
    phone: normalizedCustomer.phone || normalizedCustomer.phone_number || '',
    email: normalizedCustomer.email || '',
    notes: resolvedAddress?.notes || normalizedCustomer.notes || '',
    address: {
      street: resolvedAddress?.street_address || normalizedCustomer.address || '',
      id: resolvedAddress?.id,
      street_address:
        resolvedAddress?.street_address || normalizedCustomer.address || '',
      city: resolvedAddress?.city || normalizedCustomer.city || '',
      postalCode:
        resolvedAddress?.postal_code || normalizedCustomer.postal_code || '',
      postal_code:
        resolvedAddress?.postal_code || normalizedCustomer.postal_code || '',
      floor_number:
        resolvedAddress?.floor_number || normalizedCustomer.floor_number || '',
      notes: resolvedAddress?.notes || normalizedCustomer.notes || '',
      name_on_ringer:
        resolvedAddress?.name_on_ringer || normalizedCustomer.name_on_ringer || '',
      coordinates,
      latitude:
        coordinates?.lat ?? resolvedAddress?.latitude ?? normalizedCustomer.latitude ?? null,
      longitude:
        coordinates?.lng ??
        resolvedAddress?.longitude ??
        normalizedCustomer.longitude ??
        null,
      address_fingerprint:
        resolvedAddress?.address_fingerprint ||
        normalizedCustomer.address_fingerprint ||
        null,
    },
  };
};

const NewOrderPage: React.FC<NewOrderPageProps> = () => {
  const bridge = getBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { conflicts, createOrder, silentRefresh } = useOrderStore();
  const { staff, activeShift, isShiftActive } = useShift();
  const { getSetting } = useTerminalSettings();
  const { branchId, organizationId, terminalId } = useResolvedPosIdentity('branch+organization');
  const { isFeatureEnabled, isMobileWaiter, loading: featuresLoading } = useFeatures();
  const canCreateOrders = isFeatureEnabled('orderCreation');

  // Check if delivery module is acquired (Requirement 10.2, 10.3)
  const { hasDeliveryModule, isLoading: isLoadingModules } = useAcquiredModules();

  // Redirect to dashboard if order creation is disabled for this terminal.
  // Wait for terminal features to load first: the fail-closed default
  // (orderCreation=false) would otherwise redirect + toast during the brief loading
  // window even on terminals where order creation is actually enabled.
  useEffect(() => {
    if (!featuresLoading && !canCreateOrders) {
      toast.error(t('settings.terminal.messages.orderCreationDisabled', 'Order creation is disabled for this terminal'));
      navigate('/');
    }
  }, [featuresLoading, canCreateOrders, navigate, t]);

  // Modal states
  const [showPhoneLookupModal, setShowPhoneLookupModal] = useState(false);
  const [showCustomerInfoModal, setShowCustomerInfoModal] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [splitPaymentData, setSplitPaymentData] = useState<{
    orderId: string;
    orderTotal: number;
    items: SplitPaymentItem[];
    isGhostOrder: boolean;
  } | null>(null);
  const [selectedOrderType, setSelectedOrderType] = useState<"pickup" | "delivery" | "dine-in" | null>(null);
  const [addCustomerMode, setAddCustomerMode] = useState<'new' | 'edit' | 'addAddress' | 'editAddress'>('new');
  const [isProcessingOrder, setIsProcessingOrder] = useState(false);
  const [taxRatePercentage, setTaxRatePercentage] = useState<number>(24);

  // Customer data states
  const [phoneNumber, setPhoneNumber] = useState('');
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>({
    name: '',
    phone: '',
    email: '',
    address: {
      street: '',
      city: '',
      postalCode: '',
    }
  });
  const [existingCustomer, setExistingCustomer] = useState<Customer | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<POSError | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Additional states for customer form
  const [orderType, setOrderType] = useState<"dine-in" | "pickup" | "delivery">("pickup");
  const [tableNumber, setTableNumber] = useState('');
  const [tableId, setTableId] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [isValidatingAddress, setIsValidatingAddress] = useState(false);
  const [addressValid, setAddressValid] = useState(false);

  // Initialize page
  useEffect(() => {
    setTimeout(() => setIsInitializing(false), 0);
  }, []);

  useEffect(() => {
    const requestedOrderType = searchParams.get('orderType');
    if (requestedOrderType !== 'dine-in') {
      return;
    }

    setOrderType('dine-in');
    setSelectedOrderType('dine-in');
    setTableNumber(searchParams.get('tableNumber') || '');
    setTableId(searchParams.get('tableId') || '');
    setShowPhoneLookupModal(false);
    setShowCustomerInfoModal(false);
    setShowAddCustomerModal(false);
    setShowMenuModal(true);
    setIsInitializing(false);
  }, [searchParams]);

  useEffect(() => {
    const rawConfiguredRate = getSetting<number | string>('tax', 'tax_rate_percentage', 24);
    const configuredRate = Number(rawConfiguredRate);
    if (Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate <= 100) {
      setTaxRatePercentage(configuredRate);
    } else {
      setTaxRatePercentage(24);
    }
  }, [getSetting]);

  // Handler for selecting order type
  const handleOrderTypeSelect = (type: "pickup" | "delivery") => {
    setSelectedOrderType(type);

    if (type === "pickup") {
      // For pickup orders, create a basic customer object and go directly to menu
      const pickupCustomer = {
        id: 'pickup-customer',
        name: t('customer.noCustomer'),
        phone_number: '',
        email: '',
        addresses: []
      };

      setOrderType("pickup");
      setShowMenuModal(true);
    } else {
      // For delivery orders, show phone lookup modal
      setOrderType("delivery");
      setShowPhoneLookupModal(true);
    }
  };

  // Handler for customer selection from search modal
  const handleCustomerSelected = (customer: any) => {
    const normalizedCustomer = withMaterializedCustomerAddresses(customer as Customer) as Customer;
    const resolvedAddress = resolveCanonicalCustomerAddress(normalizedCustomer);
    setExistingCustomer(normalizedCustomer);

    console.log('[NewOrderPage.handleCustomerSelected] Customer:', normalizedCustomer);
    console.log('[NewOrderPage.handleCustomerSelected] resolvedAddress:', resolvedAddress);

    const customerInfoData = buildCustomerInfoFromCustomer(normalizedCustomer);
    setCustomerInfo(customerInfoData);

    setSpecialInstructions(customerInfoData.notes || '');

    setShowPhoneLookupModal(false);
    // Open AddCustomerModal in edit mode instead of simplified CustomerInfoModal
    setAddCustomerMode('edit');
    setShowAddCustomerModal(true);
  };

  const handleEditCustomer = (customer: any) => {
    setExistingCustomer(customer);
    // The address-row pencil passes editAddressId -> open address-only edit mode;
    // the full "Edit Customer" button passes no editAddressId and stays full edit.
    setAddCustomerMode(customer?.editAddressId ? 'editAddress' : 'edit');
    setShowPhoneLookupModal(false);
    setShowAddCustomerModal(true);
  };

  const handleAddNewAddressDetails = (customer: any) => {
    setExistingCustomer(customer);
    setAddCustomerMode('addAddress');
    setShowPhoneLookupModal(false);
    setShowAddCustomerModal(true);
  };

  // Handler for adding new customer from search modal
  const handleAddNewCustomer = (phone: string) => {
    setExistingCustomer(null);
    setPhoneNumber(phone); // Keep track of phone
    setShowPhoneLookupModal(false);
    setAddCustomerMode('new');
    setShowAddCustomerModal(true);
  };

  const handleNewCustomerAdded = (customer: any) => {
    // Store the customer info and proceed to menu
    const normalizedCustomer = withMaterializedCustomerAddresses(customer as Customer) as Customer;
    setExistingCustomer(normalizedCustomer);

    const customerInfoData = buildCustomerInfoFromCustomer(normalizedCustomer);
    setCustomerInfo(customerInfoData);

    setSpecialInstructions(customerInfoData.notes || '');

    // Close add customer modal and open menu modal
    setShowAddCustomerModal(false);
    setShowMenuModal(true);
  };

  // Handler for saving customer info from modal
  const handleCustomerInfoSave = (info: any) => {
    // Update local state
    setCustomerInfo({
      name: info.name,
      phone: info.phone,
      email: info.email,
      address: {
        street: info.address || '',
        city: '', // info.address is single string in modal often, might need parsing or just store as street
        postalCode: '',
        coordinates: info.coordinates
      }
    });

    // Close customer info modal and open menu modal
    setShowCustomerInfoModal(false);
    setShowMenuModal(true);
  };

  // Legacy handler kept if needed for reference, but main flow uses new handlers above
  const handleValidateAddress = async (address: string) => {
    // ... logic moved to CustomerInfoModal internal component
    return true;
  };

  // Handler for customer info form submission - now opens MenuModal instead of navigating
  const handleCustomerInfoSubmit = () => {
    if (!customerInfo.name || !customerInfo.phone) {
      toast.error(t('customer.validation.allFieldsRequired'));
      return;
    }

    if (orderType === 'delivery' && (!customerInfo.address?.street || !customerInfo.address?.city)) {
      toast.error(t('delivery.messages.addressRequired'));
      return;
    }

    // Close customer info modal and open menu modal
    setShowCustomerInfoModal(false);
    setShowMenuModal(true);
  };

  const finalizeCreatedOrderPayment = useCallback(async (orderId: string, isGhostOrder: boolean) => {
    // Ghost orders: print receipt directly (Rust auto-print skips ghosts)
    if (isGhostOrder) {
      await bridge.payments.printReceipt(orderId);
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
  }, [bridge]);

  const handleOrderComplete = useCallback(async (orderData: any): Promise<boolean> => {
    setIsProcessingOrder(true);
    const isSplitPayment = orderData.paymentData?.method === 'pending';
    const isGhostOrder = orderData.is_ghost === true;
    const ghostSource = isGhostOrder
      ? (typeof orderData.ghost_source === 'string' ? orderData.ghost_source : 'manual_code_x_1')
      : null;
    const ghostMetadata = isGhostOrder ? (orderData.ghost_metadata ?? null) : null;

    try {
      const currentOrderType = (orderData.orderType || selectedOrderType || 'pickup') as 'pickup' | 'delivery' | 'dine-in';
      const currentCustomer = orderData.customer || null;
      const currentAddress = orderData.address || null;
      const resolvedBranchId = branchId || staff?.branchId || null;

      if (!resolvedBranchId || !organizationId) {
        toast.error(t('orderFlow.missingContext', 'Missing branch or organization context'));
        return false;
      }

      let deliveryAddress = null;
      let deliveryFee = 0;
      let deliveryZoneId = null;
      let zoneName = null;
      let estimatedDeliveryTime = null;
      const effectiveDeliveryZoneInfo = orderData.deliveryZoneInfo ?? null;
      const currentAddressLabel =
        currentAddress?.street_address || currentAddress?.street || currentAddress?.address || '';
      const currentAddressCoordinates = parseSpecialAddressInput(currentAddressLabel).shouldSkipZoneValidation
        ? undefined
        : toLatLngCoordinates(
            currentAddress?.coordinates,
            currentAddress?.latitude,
            currentAddress?.longitude,
          );

      if (currentOrderType === 'delivery' && currentAddress) {
        const streetAddress = currentAddress.street_address || currentAddress.street || '';
        const city = currentAddress.city || '';
        const postalCode = currentAddress.postal_code || '';
        const floorNumber = currentAddress.floor_number || currentAddress.floor || '';

        deliveryAddress = [streetAddress, city].filter(Boolean).join(', ');
        if (postalCode) {
          deliveryAddress += ` ${postalCode}`;
        }
        if (floorNumber) {
          deliveryAddress += `, Floor: ${floorNumber}`;
        }

        deliveryFee = Number(orderData.deliveryFee ?? resolveDeliveryFee(effectiveDeliveryZoneInfo));

        if (effectiveDeliveryZoneInfo?.zone) {
          deliveryZoneId = effectiveDeliveryZoneInfo.zone.id;
          zoneName = effectiveDeliveryZoneInfo.zone.name;
          estimatedDeliveryTime = effectiveDeliveryZoneInfo.zone.estimatedTime;
        }
      }

      const discountPercentage = Number(orderData.discountPercentage || 0);
      const discountAmount = Number(orderData.discountAmount || 0);
      const subtotalAfterDiscount = Number(orderData.total || 0);
      const taxDivisor = 1 + (taxRatePercentage / 100);
      const tax =
        taxRatePercentage > 0 && taxDivisor > 0
          ? Math.round((subtotalAfterDiscount - (subtotalAfterDiscount / taxDivisor)) * 100) / 100
          : 0;
      const totalAmount = subtotalAfterDiscount + deliveryFee;
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
              amount: totalAmount,
              cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
              changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
              transactionRef: orderData.paymentData.transactionId,
              staffId: currentOrderType === 'delivery' ? undefined : staff?.staffId,
              staffShiftId: currentOrderType === 'delivery' ? undefined : activeShift?.id,
            }
          : undefined;

      if (!isShiftActive) {
        toast(t('orderFlow.noActiveShift', 'No active shift'), {
          duration: 3000,
          icon: <AlertTriangle className="w-4 h-4 text-white" />,
          style: { background: '#f59e0b', color: 'white' },
        });
      }

      const normalizedItems = normalizePosOrderItems(orderData.items || []);
      const invalidItems = normalizedItems.filter(
        (item: any) => !hasValidSyncedPosMenuItemId(item),
      );
      if (invalidItems.length > 0) {
        toast.error(
          t(
            'orderFlow.invalidCartItems',
            'Order cannot be created because some cart items are not synced menu items. Sync menu and try again.',
          ),
        );
        return false;
      }

      const resolvedTerminalId = terminalId || staff?.terminalId || await bridge.terminalConfig.getTerminalId();
      if (!resolvedTerminalId) {
        toast.error(t('orderFlow.missingContext', 'Missing branch or organization context'));
        return false;
      }

      const activeCashier = await resolveActiveCashierShift({
        branchId: resolvedBranchId,
        terminalId: resolvedTerminalId,
        activeShift,
        logContext: 'NewOrderPage',
      });
      if (!activeCashier) {
        toast.error(t('orderFlow.noActiveCashierShift', 'Cannot create orders until a cashier opens the day.'));
        return false;
      }

      const existingOrderId = orderData.paymentData?.existingOrderId;
      if (existingOrderId && (paymentMethod === 'cash' || paymentMethod === 'card')) {
        const paymentResult: any = await bridge.payments.recordPayment({
          orderId: existingOrderId,
          method: paymentMethod,
          amount: totalAmount,
          cashReceived: paymentMethod === 'cash' ? orderData.paymentData.cashReceived : undefined,
          changeGiven: paymentMethod === 'cash' ? orderData.paymentData.change : undefined,
          transactionRef: orderData.paymentData.transactionId,
          staffId: currentOrderType === 'delivery' ? undefined : staff?.staffId,
          staffShiftId: currentOrderType === 'delivery' ? undefined : activeShift?.id,
        });
        if (paymentResult?.success === false) {
          throw new Error(paymentResult.error || 'Failed to record payment');
        }
        await silentRefresh().catch(() => {});
        void finalizeCreatedOrderPayment(existingOrderId, isGhostOrder).catch((printError: any) => {
          const stage = printError?.stage;
          if (isGhostOrder || stage === 'receipt') {
            console.error('[NewOrderPage] Fallback receipt print error:', printError);
            toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' }));
            return undefined;
          }

          console.warn('[NewOrderPage] Fallback fiscal print error (non-blocking):', printError);
          toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' }));
        });
        return true;
      }

      const clientRequestId =
        globalThis.crypto?.randomUUID?.() ??
        `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tableOrderFields = buildTableOrderCreateFields({
        serviceOrderType: currentOrderType,
        pricingOrderType: currentOrderType,
        table: tableId || tableNumber ? {
          id: tableId || null,
          tableNumber: tableNumber || null,
        } : null,
        tableNumber,
        guestCount: 1,
      });
      const {
        order_type: tableOrderType,
        payment_method: _tablePaymentMethod,
        payment_status: _tablePaymentStatus,
        ...tableOrderCreateFields
      } = tableOrderFields;
      const resolvedOrderType = (tableOrderType || currentOrderType) as 'pickup' | 'delivery' | 'dine-in';

      const orderToCreate = {
        customer_id: resolvePersistedCustomerId(currentCustomer?.id),
        customerId: resolvePersistedCustomerId(currentCustomer?.id),
        clientRequestId,
        items: normalizedItems,
        branch_id: resolvedBranchId,
        organization_id: organizationId,
        total_amount: totalAmount,
        subtotal: subtotalAfterDiscount,
        tax_amount: tax,
        delivery_fee: deliveryFee,
        discount_percentage: discountPercentage,
        discount_amount: discountAmount,
        country_code: 'GR',
        pricing_mode: 'tax_inclusive',
        status: 'pending' as const,
        payment_method: isGhostOrder ? null : (paymentMethod || null),
        room_id: isRoomChargePayment ? roomId : null,
        roomId: isRoomChargePayment ? roomId : null,
        initialPayment,
        is_ghost: isGhostOrder,
        ghost_source: ghostSource,
        ghost_metadata: ghostMetadata,
        delivery_address: deliveryAddress,
        delivery_address_id: currentAddress?.id || null,
        delivery_city: currentAddress?.city || null,
        delivery_postal_code: currentAddress?.postal_code || null,
        delivery_floor: currentAddress?.floor_number || currentAddress?.floor || null,
        delivery_notes: currentAddress?.notes || currentAddress?.delivery_notes || null,
        delivery_latitude: currentAddressCoordinates?.lat ?? null,
        delivery_longitude: currentAddressCoordinates?.lng ?? null,
        delivery_address_fingerprint:
          currentAddress?.address_fingerprint || currentCustomer?.address_fingerprint || null,
        name_on_ringer: currentCustomer?.name_on_ringer || currentAddress?.name_on_ringer || null,
        notes: orderData.notes || null,
        driver_id: undefined,
        delivery_zone_id: deliveryZoneId,
        zone_name: zoneName,
        estimated_delivery_time: estimatedDeliveryTime,
        delivery_zone_validation: effectiveDeliveryZoneInfo ? JSON.stringify({
          deliveryAvailable: effectiveDeliveryZoneInfo.deliveryAvailable,
          requiresManagerApproval: effectiveDeliveryZoneInfo.uiState?.requiresManagerApproval || false,
          validatedAt: new Date().toISOString(),
        }) : null,
        customerName: currentOrderType === 'dine-in' && tableNumber
          ? t('orderFlow.tableCustomer', { table: formatTableDisplayNumber(tableNumber) })
          : currentCustomer?.name || '',
        customerPhone: currentCustomer?.phone || currentCustomer?.phone_number || '',
        order_type: resolvedOrderType,
        orderType: resolvedOrderType,
        ...tableOrderCreateFields,
        payment_status: currentOrderType === 'dine-in' ? ('pending' as const) : undefined,
        paymentStatus: (
          isSplitPayment
            ? 'pending'
            : (orderData.paymentData ? 'completed' : 'pending')
        ) as 'pending' | 'completed' | 'processing' | 'failed' | 'refunded',
        paymentTransactionId: orderData.paymentData?.transactionId || undefined,
        estimatedTime: 15,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        staff_shift_id: currentOrderType === 'delivery' ? undefined : (activeShift?.id || null),
        staff_id: currentOrderType === 'delivery' ? undefined : (staff?.staffId || null),
      };

      const result = await createOrder(orderToCreate);
      if (!result.success || !result.orderId) {
        toast.error(t('orderFlow.orderFailed', 'Failed to create order'));
        return false;
      }

      const roomCharge = (result as any).roomCharge;
      if (isRoomChargePayment && roomCharge?.applied === false) {
        await silentRefresh().catch(() => {});
        orderData.paymentData.existingOrderId = result.orderId;
        orderData.paymentData.existingOrderNumber = result.orderNumber;
        orderData.paymentData.roomChargeFallback = true;
        orderData.paymentData.roomChargeFallbackReason =
          roomCharge.code || roomCharge.error || 'room_charge_not_applied';
        return false;
      }

      const displayOrderNumber = result.orderNumber || result.orderId || '';
      toast.success(t('orderFlow.orderCreated', { orderNumber: displayOrderNumber }));

      try {
        ActivityTracker.trackOrderCreated(result.orderId || displayOrderNumber, totalAmount);
        ActivityTracker.trackDiscount(Boolean(discountAmount), discountAmount, discountPercentage);
      } catch {}

      if (isSplitPayment) {
        setSplitPaymentData({
          orderId: result.orderId,
          orderTotal: totalAmount,
          items: buildSplitPaymentItems({
            items: (orderData.items || []).map((item: any, index: number) => ({
              name: item.name || 'Item',
              quantity: item.quantity || 1,
              price: item.unitPrice || item.price || 0,
              totalPrice: item.totalPrice || ((item.unitPrice || item.price || 0) * (item.quantity || 1)),
              itemIndex: item.itemIndex ?? item.item_index ?? index,
            })),
            orderTotal: totalAmount,
            deliveryFee,
            discountAmount,
            deliveryFeeLabel: t('payment.fields.deliveryFee', { defaultValue: 'Delivery Fee' }),
            discountLabel: t('modals.payment.discount', { defaultValue: 'Discount' }),
            adjustmentLabel: t('splitPayment.adjustment', { defaultValue: 'Adjustment' }),
          }),
          isGhostOrder,
        });
        setShowMenuModal(false);
        await silentRefresh().catch(() => {});
        return true;
      }

      if (initialPayment) {
        await silentRefresh().catch(() => {});
      }

      void finalizeCreatedOrderPayment(result.orderId, isGhostOrder).catch((printError: any) => {
        const stage = printError?.stage;
        if (isGhostOrder || stage === 'receipt') {
          console.error('[NewOrderPage] Ghost receipt print error:', printError);
          toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' }));
          return undefined;
        }

        console.warn('[NewOrderPage] Cash register print error (non-blocking):', printError);
        toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' }));
      });

      return true;
    } catch (error) {
      console.error('Error creating order from NewOrderPage:', error);
      toast.error(t('orderFlow.orderFailed', 'Failed to create order'));
      return false;
    } finally {
      setIsProcessingOrder(false);
    }
  }, [
    activeShift?.id,
    branchId,
    bridge,
    createOrder,
    finalizeCreatedOrderPayment,
    isShiftActive,
    organizationId,
    selectedOrderType,
    silentRefresh,
    staff?.branchId,
    staff?.staffId,
    staff?.terminalId,
    tableId,
    tableNumber,
    t,
    taxRatePercentage,
    terminalId,
  ]);

  const handleSplitClose = useCallback(() => {
    setSplitPaymentData(null);
    setShowMenuModal(false);
    void silentRefresh().catch(() => {});
    navigate('/');
  }, [navigate, silentRefresh]);

  const handleSplitComplete = useCallback(async (_result: SplitPaymentResult) => {
    setSplitPaymentData(null);
    setShowMenuModal(false);
    await silentRefresh().catch(() => {});
    navigate('/');
  }, [navigate, silentRefresh]);

  // Handler for menu modal close
  const handleMenuModalClose = () => {
    setShowMenuModal(false);
    // Navigate back to orders after menu is closed
    navigate('/');
  };

  // Handler for going back to main orders page
  const handleBackToOrders = () => {
    navigate('/');
  };

  // Handle keyboard events for modals
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showMenuModal) {
          setShowMenuModal(false);
        } else if (showCustomerInfoModal) {
          setShowCustomerInfoModal(false);
        } else if (showPhoneLookupModal) {
          setShowPhoneLookupModal(false);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showPhoneLookupModal, showCustomerInfoModal, showMenuModal]);

  // Create customer object for MenuModal
  const getCustomerForMenu = () => {
    if (selectedOrderType === "pickup") {
      return {
        id: 'pickup-customer',
        name: t('customer.noCustomer'),
        phone_number: '',
        email: '',
        addresses: []
      };
    }

    const persistedCustomerId = resolvePersistedCustomerId(existingCustomer?.id);

    return {
      ...(existingCustomer || {}),
      ...(persistedCustomerId ? { id: persistedCustomerId } : {}),
      name: customerInfo.name,
      phone: customerInfo.phone,
      phone_number: customerInfo.phone,
      email: customerInfo.email || '',
      notes: customerInfo.notes || specialInstructions || '',
      addresses: customerInfo.address?.street
        ? [{
            id: 'primary-address',
            street: customerInfo.address.street,
            street_address:
              customerInfo.address.street_address || customerInfo.address.street,
            city: customerInfo.address.city || '',
            postal_code:
              customerInfo.address.postal_code ||
              customerInfo.address.postalCode ||
              '',
            floor_number:
              customerInfo.address.floor_number || customerInfo.address.floor || '',
            notes:
              customerInfo.address.notes ||
              customerInfo.notes ||
              specialInstructions ||
              '',
            delivery_notes:
              customerInfo.address.notes ||
              customerInfo.notes ||
              specialInstructions ||
              '',
            name_on_ringer: customerInfo.address.name_on_ringer || '',
            coordinates: customerInfo.address.coordinates,
            latitude:
              customerInfo.address.latitude ??
              customerInfo.address.coordinates?.lat ??
              null,
            longitude:
              customerInfo.address.longitude ??
              customerInfo.address.coordinates?.lng ??
              null,
            is_default: true,
          }]
        : []
    };
  };

  // Get selected address for MenuModal
  // Checks multiple sources: customerInfo.address, existingCustomer.addresses, existingCustomer.address
  const getSelectedAddress = () => {
    if (selectedOrderType === "pickup") {
      return null;
    }

    const resolvedAddress = existingCustomer
      ? resolveCanonicalCustomerAddress(existingCustomer)
      : null;
    if (resolvedAddress?.street_address) {
      return resolvedAddress;
    }

    if (customerInfo.address?.street) {
      return {
        id: 'primary-address',
        street: customerInfo.address.street,
        street_address: customerInfo.address.street_address || customerInfo.address.street,
        city: customerInfo.address.city || '',
        postalCode:
          customerInfo.address.postalCode || customerInfo.address.postal_code || '',
        postal_code:
          customerInfo.address.postal_code || customerInfo.address.postalCode || '',
        floor:
          customerInfo.address.floor_number || customerInfo.address.floor || '',
        floor_number:
          customerInfo.address.floor_number || customerInfo.address.floor || '',
        notes:
          customerInfo.address.notes || customerInfo.notes || specialInstructions || '',
        delivery_notes:
          customerInfo.address.notes || customerInfo.notes || specialInstructions || '',
        nameOnRinger: customerInfo.address.name_on_ringer || '',
        name_on_ringer: customerInfo.address.name_on_ringer || '',
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

    return null;
  };

  // Handle conflict resolution
  const handleResolveConflict = async (conflictId: string, strategy: string) => {
    try {
      await bridge.orders.resolveConflict(conflictId, strategy);
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
      throw error;
    }
  };

  if (isInitializing) return <NewOrderPageSkeleton />;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={pageMotionContainer}
      className={`relative h-full min-h-0 overflow-y-auto scrollbar-hide ${resolvedTheme === 'dark'
      ? 'bg-gradient-to-br from-gray-900 to-gray-950'
      : 'bg-gradient-to-br from-gray-50 to-gray-100'
      }`}
    >
      {/* Header with glassmorphism */}
      <motion.div variants={pageMotionItem} className={`backdrop-blur-xl border-b shadow-lg ${resolvedTheme === 'dark'
        ? 'bg-gray-800/30 border-gray-700/50'
        : 'bg-white/30 border-white/50'
        }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <button
                onClick={handleBackToOrders}
                className={`mr-4 flex items-center transition-transform duration-200 px-3 py-2 rounded-xl active:scale-95 ${resolvedTheme === 'dark'
                  ? 'text-gray-300 active:bg-white/10'
                  : 'text-gray-700 active:bg-black/5'
                  }`}
              >
                <svg
                  className="w-5 h-5 mr-1"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                {t('orders.backToOrders')}
              </button>
              <h1 className={`text-xl font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                }`}>
                {t('orders.newOrder')}
              </h1>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <motion.div variants={pageMotionItem} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <OrderConflictBanner
            conflicts={conflicts}
            onResolve={handleResolveConflict}
          />
        </motion.div>
      )}

      {/* Main Content with glassmorphism */}
      <motion.div variants={pageMotionItem} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col items-center">
          <motion.div variants={pageMotionItem} className={`backdrop-blur-xl rounded-3xl shadow-2xl border p-12 w-full max-w-4xl ${resolvedTheme === 'dark'
            ? 'bg-gray-800/20 border-gray-700/30'
            : 'bg-white/20 border-white/30'
            }`}>
            <motion.h2 variants={pageMotionItem} className={`text-3xl font-bold text-center mb-4 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
              }`}>
              {t('modals.orderTypeSelection.title')}
            </motion.h2>

            <motion.p variants={pageMotionItem} className={`text-lg mb-12 text-center ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
              }`}>
              {t('modals.orderTypeSelection.subtitle')}
            </motion.p>

            <motion.div variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Pickup Option */}
              <motion.button
                variants={pageMotionItem}
                onClick={() => handleOrderTypeSelect("pickup")}
                className={`border-2 border-yellow-500 rounded-2xl p-10 flex flex-col items-center justify-center transition-all duration-300 shadow-xl active:scale-95 backdrop-blur-sm ${resolvedTheme === 'dark'
                  ? 'bg-gray-800/40 active:bg-gray-700/50'
                  : 'bg-white/40 active:bg-yellow-50/60'
                  }`}
              >
                <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 ${resolvedTheme === 'dark' ? 'bg-yellow-500/20' : 'bg-yellow-100'
                  }`}>
                  <PickupOrderIcon
                    className={`w-12 h-12 ${resolvedTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-700'}`}
                  />
                </div>
                <h3 className={`text-2xl font-bold mb-3 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}>
                  {t('orders.type.takeaway')}
                </h3>
                <p className={`text-center leading-relaxed ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                  }`}>
                  {t('modals.orderTypeSelection.pickupDescription')}
                </p>
              </motion.button>

              {/* Delivery Option - Only shown when delivery module is acquired (Requirement 10.2, 10.3) */}
              {hasDeliveryModule && (
                <motion.button
                  variants={pageMotionItem}
                  onClick={() => handleOrderTypeSelect("delivery")}
                  className={`border-2 border-emerald-500 rounded-2xl p-10 flex flex-col items-center justify-center transition-all duration-300 shadow-xl active:scale-95 backdrop-blur-sm ${resolvedTheme === 'dark'
                    ? 'bg-gray-800/40 active:bg-gray-700/50'
                    : 'bg-white/40 active:bg-emerald-50/60'
                    }`}
                >
                  <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 ${resolvedTheme === 'dark' ? 'bg-emerald-500/30' : 'bg-emerald-100'
                    }`}>
                    <svg
                      className={`w-12 h-12 ${resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
                        }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                      />
                    </svg>
                  </div>
                  <h3 className={`text-2xl font-bold mb-3 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                    }`}>
                    {t('orders.type.delivery')}
                  </h3>
                  <p className={`text-center leading-relaxed ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                    }`}>
                    {t('modals.orderTypeSelection.deliveryDescription')}
                  </p>
                </motion.button>
              )}
            </motion.div>
          </motion.div>
        </div>
      </motion.div>

      {/* Phone Lookup Modal */}
      {showPhoneLookupModal && (
        <CustomerSearchModal
          isOpen={showPhoneLookupModal}
          onClose={() => setShowPhoneLookupModal(false)}
          onCustomerSelected={handleCustomerSelected}
          onAddNewCustomer={handleAddNewCustomer}
          onEditCustomer={handleEditCustomer}
          onAddNewAddress={handleAddNewAddressDetails}
        />
      )}

      {/* Add Customer Modal - also used for editing existing customers */}
      {showAddCustomerModal && (
        <AddCustomerModal
          isOpen={showAddCustomerModal}
          onClose={() => {
            setShowAddCustomerModal(false);
            setExistingCustomer(null);
          }}
          onCustomerAdded={handleNewCustomerAdded}
          initialPhone={phoneNumber}
          mode={addCustomerMode}
          initialCustomer={existingCustomer
            ? (() => {
                const resolvedAddress =
                  resolveCanonicalCustomerAddress(existingCustomer);
                return {
                  id: existingCustomer.id,
                  phone: existingCustomer.phone || existingCustomer.phone_number || '',
                  name: existingCustomer.name,
                  email: existingCustomer.email,
                  address:
                    resolvedAddress?.street_address ||
                    (existingCustomer as any).address,
                  city: resolvedAddress?.city || (existingCustomer as any).city,
                  postal_code:
                    resolvedAddress?.postal_code ||
                    (existingCustomer as any).postal_code,
                  floor_number:
                    resolvedAddress?.floor_number ||
                    (existingCustomer as any).floor_number,
                  notes:
                    resolvedAddress?.notes || (existingCustomer as any).notes,
                  name_on_ringer:
                    resolvedAddress?.name_on_ringer ||
                    (existingCustomer as any).name_on_ringer,
                  addresses: existingCustomer.addresses || [],
                  selected_address_id: existingCustomer.selected_address_id,
                  editAddressId: (existingCustomer as any).editAddressId,
                  version: existingCustomer.version,
                };
              })()
            : undefined}
        />
      )}

      {/* Customer Info Modal */}
      {showCustomerInfoModal && (
        <CustomerInfoModal
          isOpen={showCustomerInfoModal}
          onClose={() => setShowCustomerInfoModal(false)}
          onSave={handleCustomerInfoSave}
          initialData={{
            name: customerInfo.name,
            phone: customerInfo.phone,
            address: customerInfo.address?.street || '',
            coordinates: customerInfo.address?.coordinates,
            deliveryValidation: undefined
          }}
          orderType={orderType === 'delivery' ? 'delivery' : orderType === 'pickup' ? 'pickup' : 'dine-in'}
        />
      )}

      {/* Menu Modal */}
      {showMenuModal && (
        <MenuModal
          isOpen={showMenuModal}
          onClose={handleMenuModalClose}
          selectedCustomer={getCustomerForMenu()}
          selectedAddress={getSelectedAddress()}
          orderType={orderType}
          isProcessingOrder={isProcessingOrder}
          onOrderComplete={handleOrderComplete}
        />
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
    </motion.div>
  );
};

export default NewOrderPage;

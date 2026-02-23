import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { MenuModal } from '../components/modals/MenuModal';
import { AddCustomerModal } from '../components/modals/AddCustomerModal';
import { CustomerSearchModal } from '../components/modals/CustomerSearchModal';
import { CustomerInfoModal } from '../components/modals/CustomerInfoModal';
import { OrderConflictBanner } from '../components/OrderConflictBanner';
import { useOrderStore } from '../hooks/useOrderStore';
import toast from 'react-hot-toast';
import { customerService } from '../services';
import { NewOrderPageSkeleton } from '../components/skeletons/NewOrderPageSkeleton';
import { ErrorDisplay } from '../components/error/ErrorDisplay';
import { withTimeout, ErrorHandler, POSError } from '../../shared/utils/error-handler';
import { TIMING } from '../../shared/constants';
import { useAcquiredModules } from '../hooks/useAcquiredModules';
import { useFeatures } from '../hooks/useFeatures';
import { getBridge } from '../../lib';

interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  version?: number;
}

interface NewOrderPageProps {
  // Optional props if needed
}

interface CustomerInfo {
  name: string;
  phone: string;
  email?: string;
  address?: {
    street: string;
    city: string;
    postalCode: string;
    coordinates?: { lat: number; lng: number };
  };
}

const NewOrderPage: React.FC<NewOrderPageProps> = () => {
  const bridge = getBridge();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { conflicts } = useOrderStore();
  const { isFeatureEnabled, isMobileWaiter } = useFeatures();
  const canCreateOrders = isFeatureEnabled('orderCreation');

  // Check if delivery module is acquired (Requirement 10.2, 10.3)
  const { hasDeliveryModule, isLoading: isLoadingModules } = useAcquiredModules();

  // Redirect to dashboard if order creation is disabled for this terminal
  useEffect(() => {
    if (!canCreateOrders) {
      toast.error(t('terminal.messages.featureDisabled', 'Order creation is disabled for this terminal'));
      navigate('/');
    }
  }, [canCreateOrders, navigate, t]);

  // Modal states
  const [showPhoneLookupModal, setShowPhoneLookupModal] = useState(false);
  const [showCustomerInfoModal, setShowCustomerInfoModal] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [selectedOrderType, setSelectedOrderType] = useState<"pickup" | "delivery" | null>(null);
  const [addCustomerMode, setAddCustomerMode] = useState<'new' | 'edit' | 'addAddress'>('new');

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
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [isValidatingAddress, setIsValidatingAddress] = useState(false);
  const [addressValid, setAddressValid] = useState(false);

  // Initialize page
  useEffect(() => {
    setTimeout(() => setIsInitializing(false), 0);
  }, []);

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
    setExistingCustomer(customer);

    // Map customer data to form
    // Priority 1: Check if specific address was selected (e.g. from search modal)
    let defaultAddress = null;
    if (customer.selected_address_id && customer.addresses) {
      defaultAddress = customer.addresses.find((a: any) => a.id === customer.selected_address_id);
    }

    // Priority 2: Check default or first address in array
    if (!defaultAddress && customer.addresses && customer.addresses.length > 0) {
      defaultAddress = customer.addresses.find((a: any) => a.is_default) || customer.addresses[0];
    }

    // Priority 2: Use legacy customer.address field if no addresses array
    let addressInfo: { street: string; city: string; postalCode: string; coordinates?: any } = {
      street: '',
      city: '',
      postalCode: '',
    };

    if (defaultAddress) {
      // Use structured address from customer_addresses table
      addressInfo = {
        street: defaultAddress.street_address || defaultAddress.street || '',
        city: defaultAddress.city || '',
        postalCode: defaultAddress.postal_code || '',
        coordinates: defaultAddress.coordinates || undefined,
      };
    } else if (customer.address) {
      // Fallback to legacy customer.address field
      if (typeof customer.address === 'string') {
        // Parse string address - use full string as street, try to extract city/postal
        // For now, just put the whole string in street field
        addressInfo = {
          street: customer.address,
          city: customer.city || '',
          postalCode: customer.postal_code || '',
        };
      } else if (typeof customer.address === 'object') {
        // Handle structured address object
        addressInfo = {
          street: customer.address.street_address || customer.address.street || '',
          city: customer.address.city || '',
          postalCode: customer.address.postal_code || customer.address.postalCode || '',
          coordinates: customer.address.coordinates || undefined,
        };
      }
    }

    // Customer objects may use 'phone' or 'phone_number' depending on source
    // CustomerSearchModal and AddCustomerModal use 'phone', but we check both for robustness
    const customerPhone = customer.phone || customer.phone_number || '';

    console.log('[NewOrderPage.handleCustomerSelected] Customer:', customer);
    console.log('[NewOrderPage.handleCustomerSelected] defaultAddress:', defaultAddress);
    console.log('[NewOrderPage.handleCustomerSelected] customer.address (legacy):', customer.address);
    console.log('[NewOrderPage.handleCustomerSelected] customerPhone:', customerPhone);
    console.log('[NewOrderPage.handleCustomerSelected] addressInfo:', addressInfo);

    setCustomerInfo({
      name: customer.name,
      phone: customerPhone,
      email: customer.email || '',
      address: addressInfo
    });

    if (defaultAddress?.notes) {
      setSpecialInstructions(defaultAddress.notes);
    }

    setShowPhoneLookupModal(false);
    // Open AddCustomerModal in edit mode instead of simplified CustomerInfoModal
    setAddCustomerMode('edit');
    setShowAddCustomerModal(true);
  };

  const handleEditCustomer = (customer: any) => {
    setExistingCustomer(customer);
    setAddCustomerMode('edit');
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
    setExistingCustomer(customer);

    // Map customer data to customerInfo state
    let defaultAddress = null;
    if (customer.selected_address_id && customer.addresses) {
      defaultAddress = customer.addresses.find((a: any) => a.id === customer.selected_address_id);
    }

    if (!defaultAddress && customer.addresses && customer.addresses.length > 0) {
      defaultAddress = customer.addresses[0];
    }

    // Customer objects may use 'phone' or 'phone_number' depending on source
    // AddCustomerModal uses 'phone', but we check both for robustness
    const customerPhone = customer.phone || customer.phone_number || '';

    setCustomerInfo({
      name: customer.name,
      phone: customerPhone,
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
      }
    });

    if (defaultAddress?.notes || customer.notes) {
      setSpecialInstructions(defaultAddress?.notes || customer.notes || '');
    }

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

    return {
      id: existingCustomer?.id || 'new-customer',
      name: customerInfo.name,
      phone_number: customerInfo.phone,
      email: customerInfo.email || '',
      addresses: customerInfo.address?.street ? [{
        id: 'primary-address',
        street: customerInfo.address.street,
        postal_code: customerInfo.address.postalCode || '',
        floor: '',
        notes: specialInstructions || '',
        delivery_instructions: ''
      }] : []
    };
  };

  // Get selected address for MenuModal
  // Checks multiple sources: customerInfo.address, existingCustomer.addresses, existingCustomer.address
  const getSelectedAddress = () => {
    if (selectedOrderType === "pickup") {
      return null;
    }

    // Priority 1: Use customerInfo.address (already structured from handleCustomerSelected)
    if (customerInfo.address?.street) {
      return {
        id: 'primary-address',
        street: customerInfo.address.street,
        city: customerInfo.address.city || '',
        postal_code: customerInfo.address.postalCode || '',
        floor: '',
        notes: specialInstructions || '',
        delivery_instructions: ''
      };
    }

    // Priority 2: Check existingCustomer.addresses array
    const customerAddresses = (existingCustomer as any)?.addresses;
    if (customerAddresses && Array.isArray(customerAddresses) && customerAddresses.length > 0) {
      const addr = customerAddresses.find((a: any) => a.is_default) || customerAddresses[0];
      return {
        id: addr.id || 'customer-address',
        street: addr.street_address || addr.street || '',
        city: addr.city || '',
        postal_code: addr.postal_code || '',
        floor: addr.floor_number || '',
        notes: addr.notes || specialInstructions || '',
        delivery_instructions: addr.delivery_instructions || ''
      };
    }

    // Priority 3: Check existingCustomer.address (legacy field)
    const legacyAddress = (existingCustomer as any)?.address;
    if (legacyAddress) {
      if (typeof legacyAddress === 'string') {
        // Use the string address as street field
        return {
          id: 'legacy-address',
          street: legacyAddress,
          city: (existingCustomer as any)?.city || '',
          postal_code: (existingCustomer as any)?.postal_code || '',
          floor: '',
          notes: specialInstructions || '',
          delivery_instructions: ''
        };
      } else if (typeof legacyAddress === 'object') {
        return {
          id: 'legacy-address',
          street: legacyAddress.street_address || legacyAddress.street || '',
          city: legacyAddress.city || '',
          postal_code: legacyAddress.postal_code || '',
          floor: legacyAddress.floor_number || '',
          notes: legacyAddress.notes || specialInstructions || '',
          delivery_instructions: legacyAddress.delivery_instructions || ''
        };
      }
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
    <div className={`min-h-screen relative ${resolvedTheme === 'dark'
      ? 'bg-gradient-to-br from-gray-900 via-blue-900/20 to-purple-900/20'
      : 'bg-gradient-to-br from-blue-50 via-purple-50/30 to-pink-50/20'
      }`}>
      {/* Header with glassmorphism */}
      <div className={`backdrop-blur-xl border-b shadow-lg ${resolvedTheme === 'dark'
        ? 'bg-gray-800/30 border-gray-700/50'
        : 'bg-white/30 border-white/50'
        }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <button
                onClick={handleBackToOrders}
                className={`mr-4 flex items-center transition-all duration-300 px-3 py-2 rounded-xl ${resolvedTheme === 'dark'
                  ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/20'
                  : 'text-blue-600 hover:text-blue-800 hover:bg-blue-500/10'
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
      </div>

      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <OrderConflictBanner
            conflicts={conflicts}
            onResolve={handleResolveConflict}
          />
        </div>
      )}

      {/* Main Content with glassmorphism */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col items-center">
          <div className={`backdrop-blur-xl rounded-3xl shadow-2xl border p-12 w-full max-w-4xl ${resolvedTheme === 'dark'
            ? 'bg-gray-800/20 border-gray-700/30'
            : 'bg-white/20 border-white/30'
            }`}>
            <h2 className={`text-3xl font-bold text-center mb-4 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
              }`}>
              {t('modals.orderTypeSelection.title')}
            </h2>

            <p className={`text-lg mb-12 text-center ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
              }`}>
              {t('modals.orderTypeSelection.subtitle')}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Pickup Option */}
              <button
                onClick={() => handleOrderTypeSelect("pickup")}
                className={`border-2 border-blue-500 rounded-2xl p-10 flex flex-col items-center transition-all duration-300 shadow-xl hover:scale-105 transform active:scale-95 backdrop-blur-sm ${resolvedTheme === 'dark'
                  ? 'bg-gray-800/40 hover:bg-gray-700/50 hover:border-blue-400 hover:shadow-blue-500/25'
                  : 'bg-white/40 hover:bg-blue-50/50 hover:border-blue-600 hover:shadow-blue-500/25'
                  }`}
              >
                <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 ${resolvedTheme === 'dark' ? 'bg-blue-500/30' : 'bg-blue-100'
                  }`}>
                  <svg
                    className={`w-12 h-12 ${resolvedTheme === 'dark' ? 'text-blue-400' : 'text-blue-600'
                      }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                    />
                  </svg>
                </div>
                <h3 className={`text-2xl font-bold mb-3 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}>
                  {t('orders.type.takeaway')}
                </h3>
                <p className={`text-center leading-relaxed ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                  }`}>
                  {t('modals.orderTypeSelection.pickupDescription')}
                </p>
              </button>

              {/* Delivery Option - Only shown when delivery module is acquired (Requirement 10.2, 10.3) */}
              {hasDeliveryModule && (
                <button
                  onClick={() => handleOrderTypeSelect("delivery")}
                  className={`border-2 border-emerald-500 rounded-2xl p-10 flex flex-col items-center transition-all duration-300 shadow-xl hover:scale-105 transform active:scale-95 backdrop-blur-sm ${resolvedTheme === 'dark'
                    ? 'bg-gray-800/40 hover:bg-gray-700/50 hover:border-emerald-400 hover:shadow-emerald-500/25'
                    : 'bg-white/40 hover:bg-emerald-50/50 hover:border-emerald-600 hover:shadow-emerald-500/25'
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
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

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
          initialCustomer={existingCustomer ? {
            id: existingCustomer.id,
            phone: existingCustomer.phone || '',
            name: existingCustomer.name,
            email: existingCustomer.email,
            address: (existingCustomer as any).address,
            city: (existingCustomer as any).city,
            postal_code: (existingCustomer as any).postal_code,
            floor_number: (existingCustomer as any).floor_number,
            notes: (existingCustomer as any).notes,
            name_on_ringer: (existingCustomer as any).name_on_ringer,
            version: existingCustomer.version,
          } : undefined}
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
          orderType={selectedOrderType === "pickup" ? "pickup" : "delivery"}
        />
      )}
    </div>
  );
};

export default NewOrderPage;

import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  BedDouble,
  CalendarClock,
  Check,
  Edit,
  Mail,
  MapPin,
  Minus,
  Phone,
  Search,
  ShoppingBag,
  Trash2,
  Truck,
  User,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { posApiDelete, posApiGet } from '../../utils/api-helpers';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useTheme } from '../../contexts/theme-context';
import { formatDate } from '../../utils/format';
import { getResolvedTerminalCredentials } from '../../services/terminal-credentials';
import {
  resolveSelectedCustomerAddress,
  withMaterializedCustomerAddresses,
} from '../../utils/customer-addresses';
import { getBridge } from '../../../lib';
import type { CallerIdRequestedOrderType } from '../../services/caller-id-order-flow';

interface CustomerAddress {
  id: string;
  street_address: string;
  street?: string;
  city: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] };
  latitude?: number | null;
  longitude?: number | null;
  address_type: string;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
  version?: number;
  is_legacy_fallback?: boolean;
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
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] };
  latitude?: number | null;
  longitude?: number | null;
  version?: number;
  addresses?: CustomerAddress[];
  is_banned?: boolean;
  ban_reason?: string;
  banned_at?: string;
}

interface CustomerSearchModalBaseProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-selected customer to show directly (e.g., after editing an address) */
  initialCustomer?: Customer | null;
  /** Initial phone/name used by passive lookup flows such as incoming Caller ID. */
  initialSearchTerm?: string;
  /** Optional normalized API lookup key while the full number remains visible. */
  initialLookupTerm?: string;
  /** Forces a fresh lookup when a new event repeats the same search term. */
  searchRequestKey?: string;
  /** Fired after the visible modal has committed for this request. */
  onDisplayed?: () => void;
  /**
   * Turns passive Caller ID lookup into a large, single-screen workspace.
   * Search state stays mounted while the workspace is minimized.
   */
  callerIdWorkspace?: {
    minimized: boolean;
    enabledOrderTypes: CallerIdRequestedOrderType[];
    onMinimize: () => void;
    onOrderTypeSelected: (
      orderType: CallerIdRequestedOrderType,
      customer: Customer | null,
      visiblePhone: string,
    ) => void;
  };
}

type CustomerSearchModalProps = CustomerSearchModalBaseProps & (
  | {
      lookupOnly: true;
      /** Safe Caller ID actions; customer mutation controls remain hidden. */
      onCustomerSelected?: (customer: Customer) => void;
      onAddNewCustomer?: (phone: string) => void;
      onContinueWithoutCustomer?: (phone: string) => void;
      onAddNewAddress?: (customer: Customer) => void;
      onEditCustomer?: never;
    }
  | {
      lookupOnly?: false;
      onCustomerSelected: (customer: Customer) => void;
      onAddNewCustomer: (phone: string) => void;
      onContinueWithoutCustomer?: never;
      onAddNewAddress?: (customer: Customer) => void;
      onEditCustomer?: (customer: Customer) => void;
    }
);

const resolveAddressStreet = (address?: Partial<CustomerAddress> | null): string => {
  if (!address) return '';

  const streetAddress = typeof address.street_address === 'string'
    ? address.street_address.trim()
    : '';
  if (streetAddress) return streetAddress;

  return typeof address.street === 'string' ? address.street.trim() : '';
};

const normalizeCustomerAddress = (address: any): CustomerAddress => {
  const normalizedStreet = resolveAddressStreet(address);
  const coordinates =
    address?.coordinates ||
    (Number.isFinite(Number(address?.latitude)) && Number.isFinite(Number(address?.longitude))
      ? { lat: Number(address.latitude), lng: Number(address.longitude) }
      : undefined);
  return {
    ...address,
    id: address?.id ?? '',
    city: typeof address?.city === 'string' ? address.city : '',
    street: normalizedStreet,
    street_address: normalizedStreet,
    postal_code: typeof address?.postal_code === 'string' ? address.postal_code : '',
    floor_number: typeof address?.floor_number === 'string' ? address.floor_number : '',
    name_on_ringer: typeof address?.name_on_ringer === 'string' ? address.name_on_ringer : '',
    notes: address?.notes ?? address?.delivery_notes ?? '',
    delivery_notes: address?.notes ?? address?.delivery_notes ?? '',
    coordinates,
    latitude: address?.latitude ?? null,
    longitude: address?.longitude ?? null,
    address_type: typeof address?.address_type === 'string' ? address.address_type : 'delivery',
    is_default: Boolean(address?.is_default),
    created_at: typeof address?.created_at === 'string' ? address.created_at : '',
    version: address?.version ?? 1,
  };
};

const normalizeCustomerAddresses = (addresses: any): CustomerAddress[] => {
  if (!Array.isArray(addresses)) return [];
  return addresses.map((address) => normalizeCustomerAddress(address));
};

const ModalDisplayedReporter: React.FC<{
  requestKey?: string;
  onDisplayed?: () => void;
  displayedRequestRef: React.MutableRefObject<string | null>;
}> = ({ requestKey, onDisplayed, displayedRequestRef }) => {
  useEffect(() => {
    const displayKey = requestKey ?? 'default-open';
    if (displayedRequestRef.current === displayKey) return;
    displayedRequestRef.current = displayKey;
    onDisplayed?.();
  }, [displayedRequestRef, onDisplayed, requestKey]);

  return null;
};

export const CustomerSearchModal: React.FC<CustomerSearchModalProps> = ({
  isOpen,
  onClose,
  onCustomerSelected,
  onAddNewCustomer,
  onAddNewAddress,
  onEditCustomer,
  initialCustomer,
  initialSearchTerm,
  initialLookupTerm,
  searchRequestKey,
  onDisplayed,
  onContinueWithoutCustomer,
  lookupOnly = false,
  callerIdWorkspace,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState('');
  const [lookupQuery, setLookupQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputId = useId();
  const searchDisposedRef = useRef(false);
  const searchRequestSeqRef = useRef(0);
  const suppressAutomaticLookupRef = useRef(Boolean(initialCustomer));
  const displayedRequestRef = useRef<string | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const resolvePosCredentials = useCallback(async (): Promise<{ posKey: string; termId: string }> => {
    const resolved = await getResolvedTerminalCredentials();
    const posKey = (resolved.apiKey || '').trim();
    const termId = (resolved.terminalId || '').trim();

    return { posKey, termId };
  }, []);

  const nextSearchRequestId = () => {
    searchRequestSeqRef.current += 1;
    return searchRequestSeqRef.current;
  };

  const isSearchRequestStale = (requestId: number) =>
    searchDisposedRef.current || requestId !== searchRequestSeqRef.current;

  // Initialize either a pre-selected customer or a passive lookup request.
  useEffect(() => {
    if (!isOpen) return;

    nextSearchRequestId();
    setCustomers([]);
    setError(null);
    setIsSearching(false);

    if (initialCustomer) {
      suppressAutomaticLookupRef.current = true;
      const materializedCustomer = withMaterializedCustomerAddresses({
        ...initialCustomer,
        addresses: normalizeCustomerAddresses(initialCustomer.addresses),
      }) as Customer;
      setCustomer(materializedCustomer);
      setSelectedAddressId(resolveSelectedCustomerAddress(materializedCustomer)?.id ?? null);
      setSearchQuery(initialCustomer.phone || '');
      setLookupQuery(initialCustomer.phone || '');
      return;
    }

    suppressAutomaticLookupRef.current = false;
    setCustomer(null);
    setSearchQuery(initialSearchTerm?.trim() ?? '');
    setLookupQuery(initialLookupTerm?.trim() || initialSearchTerm?.trim() || '');
  }, [
    isOpen,
    initialCustomer,
    initialLookupTerm,
    initialSearchTerm,
    searchRequestKey,
  ]);

  // Auto-select default or first address when customer is found. The customer
  // object can be re-set after the operator already picked an address (the
  // lookup pipeline materializes/refreshes it), so a still-valid pick must
  // survive — resetting to the default here silently lost the operator's
  // choice (and made the caller-id address test flake on CI timing).
  useEffect(() => {
    if (customer) {
      setSelectedAddressId((current) => {
        if (current && customer.addresses?.some((addr) => addr.id === current)) {
          return current;
        }
        return resolveSelectedCustomerAddress(customer)?.id ?? null;
      });
    } else {
      setSelectedAddressId(null);
    }
  }, [customer]);


  // Debounced search function - now supports phone or name
  const searchCustomer = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 3) {
      nextSearchRequestId();
      setCustomer(null);
      setCustomers([]);
      setError(null);
      setIsSearching(false);
      return;
    }

    const requestId = nextSearchRequestId();
    setIsSearching(true);
    setError(null);
    setCustomer(null);
    setCustomers([]);

    try {
      const { posKey, termId } = await resolvePosCredentials();
      if (isSearchRequestStale(requestId)) return;

      // Check if we have credentials before making the request
      if (!posKey && !termId) {
        console.warn('[CustomerSearch] No POS credentials found. Please configure terminal in Settings.');
        setError(t('modals.customerSearch.configureTerminal'));
        setIsSearching(false);
        return;
      }

      // Use POS-authenticated endpoint with both search and phone parameters for compatibility
      // The search parameter supports phone or name; phone is for backward compatibility with older API versions
      const encodedQuery = encodeURIComponent(query.trim());
      const endpoint = `pos/customers?search=${encodedQuery}&phone=${encodedQuery}`;

      // Build headers with POS authentication
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) {
        headers['x-pos-api-key'] = String(posKey);
      }
      if (termId) {
        headers['x-terminal-id'] = String(termId);
      }

      console.log('[CustomerSearch] Searching with credentials:', {
        hasApiKey: !!posKey,
        hasTerminalId: !!termId,
        endpoint
      });

      const result = await posApiGet<any>(endpoint, {
        headers,
        credentials: 'omit', // Don't send cookies for POS endpoint
      });

      if (isSearchRequestStale(requestId)) return;

      if (!result.success) {
        if (result.status === 401) {
          console.warn('[CustomerSearch] Authentication failed (401). Check terminal credentials in Settings.');
          setError(t('modals.customerSearch.authFailed'));
          setIsSearching(false);
          return;
        }
        throw new Error(result.error || `HTTP ${result.status || 'error'}`);
      }

      const payload = result.data;

      // Handle multiple results
      if (payload?.success && payload.multiple && payload.customers) {
        const customersList = payload.customers.map((c: any) =>
          withMaterializedCustomerAddresses({
            id: c.id,
            phone: c.phone,
            name: c.name,
            email: c.email,
            address: c.address,
            city: c.city,
            postal_code: c.postal_code,
            floor_number: c.floor_number,
            notes: c.notes,
            name_on_ringer: c.name_on_ringer,
            coordinates: c.coordinates ||
              (Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude))
                ? { lat: Number(c.latitude), lng: Number(c.longitude) }
                : undefined),
            latitude: c.latitude ?? null,
            longitude: c.longitude ?? null,
            version: c.version,
            addresses: normalizeCustomerAddresses(c.addresses),
            is_banned: c.is_banned,
            ban_reason: c.ban_reason,
            banned_at: c.banned_at,
          })
        );
        setError(null);
        setCustomers(customersList);
        setCustomer(null);
      } else if (payload?.success && payload.customer) {
        // Single customer result
        const customerObj = withMaterializedCustomerAddresses({
          id: payload.customer.id,
          phone: payload.customer.phone,
          name: payload.customer.name,
          email: payload.customer.email,
          address: payload.customer.address,
          city: payload.customer.city,
          postal_code: payload.customer.postal_code,
          floor_number: payload.customer.floor_number,
          notes: payload.customer.notes,
          name_on_ringer: payload.customer.name_on_ringer,
          coordinates: payload.customer.coordinates ||
            (Number.isFinite(Number(payload.customer.latitude)) &&
              Number.isFinite(Number(payload.customer.longitude))
              ? { lat: Number(payload.customer.latitude), lng: Number(payload.customer.longitude) }
              : undefined),
          latitude: payload.customer.latitude ?? null,
          longitude: payload.customer.longitude ?? null,
          version: payload.customer.version,
          addresses: normalizeCustomerAddresses(payload.customer.addresses),
          is_banned: payload.customer.is_banned,
          ban_reason: payload.customer.ban_reason,
          banned_at: payload.customer.banned_at,
        }) as Customer;

        // Clear error when customer is found
        setError(null);
        setCustomer(customerObj);
        setCustomers([]);
      } else {
        if (query.length >= 3) {
          setError(t('modals.customerSearch.customerNotFound'));
        }
      }
    } catch (err) {
      if (isSearchRequestStale(requestId)) return;
      console.error('Error searching customer:', err);
      setError(t('modals.customerSearch.searchError'));
    } finally {
      if (!isSearchRequestStale(requestId)) {
        setIsSearching(false);
      }
    }
  }, [resolvePosCredentials, t]);

  // Real-time search effect
  useEffect(() => {
    if (suppressAutomaticLookupRef.current) return;

    // Clear any existing timeout
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    // Set a new timeout for debounced search
    const newTimeout = setTimeout(() => {
      searchCustomer(lookupQuery);
    }, 300); // 300ms delay

    setSearchTimeout(newTimeout);

    // Cleanup function
    return () => {
      if (newTimeout) {
        clearTimeout(newTimeout);
      }
    };
  }, [lookupQuery, searchCustomer, searchRequestKey]);

  // Manual search function (keeping for backward compatibility)
  const handleManualSearch = () => {
    suppressAutomaticLookupRef.current = false;
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    searchCustomer(lookupQuery);
  };

  const buildSelectedCustomer = (): Customer | null => {
    if (!customer) return null;

    let addressToUse = selectedAddressId;
    if (!addressToUse && customer.addresses && customer.addresses.length > 0) {
      addressToUse = resolveSelectedCustomerAddress(customer)?.id ?? null;
    }

    const selectedAddr = addressToUse
      ? customer.addresses?.find((address) => address.id === addressToUse)
      : undefined;
    if (!selectedAddr) return customer;

    return {
      ...customer,
      address: resolveAddressStreet(selectedAddr) || customer.address || '',
      city: selectedAddr.city,
      postal_code: selectedAddr.postal_code,
      floor_number: selectedAddr.floor_number,
      notes: selectedAddr.notes || customer.notes,
      coordinates: selectedAddr.coordinates ?? customer.coordinates,
      latitude: selectedAddr.latitude ?? customer.latitude ?? null,
      longitude: selectedAddr.longitude ?? customer.longitude ?? null,
      selected_address_id: selectedAddr.id,
    } as Customer;
  };

  const handleSelectCustomer = () => {
    const selectedCustomer = buildSelectedCustomer();
    if (selectedCustomer) onCustomerSelected?.(selectedCustomer);
  };

  const handleAddNewCustomer = () => {
    // Pass the search query - if it looks like a phone number, use it as phone
    const isLikelyPhone = /^[0-9+\-\s()]+$/.test(searchQuery.trim());
    onAddNewCustomer?.(isLikelyPhone ? searchQuery : '');
    // Don't close here - let the parent handle the flow
    // onClose();
  };

  const handleAddNewAddress = () => {
    if (customer && onAddNewAddress) {
      onAddNewAddress(customer);
    }
  };

  const handleEditCustomer = () => {
    if (customer && onEditCustomer) {
      onEditCustomer(customer);
    }
  };

  // Show delete confirmation dialog
  const handleDeleteCustomer = () => {
    if (!customer) return;
    setShowDeleteConfirm(true);
  };

  // Perform actual deletion after confirmation
  const performDeleteCustomer = async () => {
    if (!customer) return;

    setIsDeleting(true);
    try {
      const result = await posApiDelete<any>(`pos/customers/${customer.id}`);

      if (result.success && result.data?.success !== false) {
        // Clear the customer from state
        setCustomer(null);
        setCustomers([]);
        setSearchQuery('');
        setShowDeleteConfirm(false);
        // Show styled success toast
        toast.success(t('modals.customerSearch.deleteSuccess'));
      } else {
        throw new Error(result.error || 'Failed to delete customer');
      }
    } catch (err) {
      console.error('Error deleting customer:', err);
      // Show styled error toast
      toast.error(t('modals.customerSearch.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleManualSearch();
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    suppressAutomaticLookupRef.current = false;
    const value = e.target.value;
    setSearchQuery(value);
    setLookupQuery(value);

    // Clear previous results immediately when typing
    if (value.length < searchQuery.length) { // User is deleting
      setCustomer(null);
      setCustomers([]);
      setError(null);
    }
  };

  // Reset state when modal closes; mark disposed to cancel in-flight searches
  useEffect(() => {
    if (isOpen) {
      searchDisposedRef.current = false;
    } else {
      searchDisposedRef.current = true;
      searchRequestSeqRef.current += 1;
      setSearchQuery('');
      setLookupQuery('');
      setCustomer(null);
      setCustomers([]);
      setError(null);
      setIsSearching(false);
      if (searchTimeout) {
        clearTimeout(searchTimeout);
        setSearchTimeout(null);
      }
    }
  }, [isOpen, searchTimeout]);

  // Keep the search field focused when the modal opens so keyboard input can start immediately.
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        const el = searchInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Helper to select a customer from the list - fetch fresh data with addresses
  const handleSelectFromList = async (selectedCustomer: Customer) => {
    const requestId = nextSearchRequestId();
    setIsSearching(true);
    try {
      // Fetch fresh customer data with addresses using the customer's phone
      const { posKey, termId } = await resolvePosCredentials();
      if (isSearchRequestStale(requestId)) return;

      // Fetch by exact phone to get full customer data with addresses
      const endpoint = `pos/customers?phone=${encodeURIComponent(selectedCustomer.phone)}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) headers['x-pos-api-key'] = String(posKey);
      if (termId) headers['x-terminal-id'] = String(termId);

      const result = await posApiGet<any>(endpoint, { headers, credentials: 'omit' });
      if (isSearchRequestStale(requestId)) return;
      const payload = result.success ? result.data : null;

      if (result.success && payload?.success && payload.customer) {
          console.log('[CustomerSearch] Full customer data received:', {
            id: payload.customer.id,
            name: payload.customer.name,
            name_on_ringer: payload.customer.name_on_ringer,
            addressCount: payload.customer.addresses?.length,
            addresses: payload.customer.addresses?.map((a: any) => ({
              id: a.id,
              street: resolveAddressStreet(a),
              notes: a.notes
            }))
          });
          const customerObj = {
            id: payload.customer.id,
            phone: payload.customer.phone,
            name: payload.customer.name,
            email: payload.customer.email,
            address: payload.customer.address,
            postal_code: payload.customer.postal_code,
            floor_number: payload.customer.floor_number,
            notes: payload.customer.notes,
            name_on_ringer: payload.customer.name_on_ringer,
            version: payload.customer.version,
            addresses: normalizeCustomerAddresses(payload.customer.addresses),
            is_banned: payload.customer.is_banned,
            ban_reason: payload.customer.ban_reason,
            banned_at: payload.customer.banned_at,
          };
          setCustomer(customerObj);
          setCustomers([]);
          return;
      }
      // Fallback to using the selected customer from list if fetch fails
      setCustomer(selectedCustomer);
      setCustomers([]);
    } catch (err) {
      if (isSearchRequestStale(requestId)) return;
      console.error('Error fetching customer details:', err);
      // Fallback to using the selected customer from list
      setCustomer(selectedCustomer);
      setCustomers([]);
    } finally {
      if (!isSearchRequestStale(requestId)) {
        setIsSearching(false);
      }
    }
  };

  if (isOpen && callerIdWorkspace?.minimized) return null;

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.customerSearch.title')}
      header={callerIdWorkspace ? (
        <div className="liquid-glass-modal-header">
          <h2 className="liquid-glass-modal-title">
            {t('modals.customerSearch.title')}
          </h2>
          <div className="ml-4 flex items-center gap-2">
            <button
              type="button"
              onClick={callerIdWorkspace.onMinimize}
              className="liquid-glass-modal-close"
              aria-label={t('app.window.minimize', 'Minimize')}
            >
              <Minus className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="liquid-glass-modal-close"
              aria-label={t('common.actions.close', 'Close')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      ) : undefined}
      ariaLabel={callerIdWorkspace ? t('modals.customerSearch.title') : undefined}
      size={callerIdWorkspace ? 'xl' : 'sm'}
      className={callerIdWorkspace ? '!max-w-6xl !max-h-[90vh]' : '!max-w-md'}
      contentClassName={callerIdWorkspace ? '!px-6 !pb-6' : undefined}
      closeOnBackdrop={true}
      closeOnEscape={true}
      initialFocusRef={searchInputRef}
    >
      <ModalDisplayedReporter
        requestKey={searchRequestKey}
        onDisplayed={onDisplayed}
        displayedRequestRef={displayedRequestRef}
      />

      {/* Search Input */}
      <div className="mb-6">
        <label
          htmlFor={searchInputId}
          className="block text-sm font-medium mb-2 liquid-glass-modal-text"
        >
          {t('modals.customerSearch.searchLabel', 'Phone Number or Name')}
        </label>
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 z-10 ${resolvedTheme === 'dark' ? 'text-white' : 'text-black'}`} />
          <input
            id={searchInputId}
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyPress}
            placeholder={t('modals.customerSearch.searchPlaceholder', 'Enter phone or name...')}
            className="customer-search-yellow-input liquid-glass-modal-input w-full rounded-xl px-3 py-3 pl-10 transition-all focus:outline-none"
            autoFocus
          />
          {/* Real-time search indicator */}
          {isSearching && (
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-yellow-500/30 border-t-yellow-500 rounded-full animate-spin"></div>
            </div>
          )}
        </div>
        {searchQuery.length > 0 && searchQuery.length < 3 && (
          <p className="text-xs liquid-glass-modal-text-muted mt-1">
            {t('modals.customerSearch.searchingHint')}
          </p>
        )}
      </div>

      {/* Error Message */}
      {error && (!callerIdWorkspace || error !== t('modals.customerSearch.customerNotFound')) && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {callerIdWorkspace &&
        !isSearching &&
        error === t('modals.customerSearch.customerNotFound') && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <p className="font-medium text-red-600 dark:text-red-400">
            {t('modals.customerSearch.customerNotFound')}
          </p>
          <button
            type="button"
            onClick={handleAddNewCustomer}
            className="min-h-12 rounded-xl border-2 border-emerald-600 bg-white px-6 py-3 font-semibold text-emerald-700 shadow-[0_5px_0_rgba(4,120,87,0.24),0_10px_22px_rgba(15,23,42,0.12)] transition-transform active:translate-y-1 active:shadow-sm dark:border-emerald-500 dark:bg-white dark:text-emerald-700"
            style={{
              backgroundColor: '#ffffff',
              borderColor: '#16a34a',
              color: '#15803d',
            }}
          >
            {t('modals.customerSearch.addNewCustomer')}
          </button>
        </div>
      )}

      {/* Multiple Customers Found */}
      {customers.length > 0 && !customer && (
        <div className="mb-4">
          <p className="text-sm liquid-glass-modal-text-muted mb-2">
            {t('modals.customerSearch.multipleResults', { count: customers.length })}
          </p>
          <div className="max-h-60 overflow-y-auto space-y-3 pr-1 scrollbar-hide">
            {customers.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`relative mb-3 w-full cursor-pointer rounded-2xl border p-4 text-left transition-all ${
                  c.is_banned
                    ? 'border-red-500/50 bg-red-500/5'
                    : 'border-zinc-300/70 bg-zinc-100/85 active:bg-zinc-200/80 dark:border-zinc-700/70 dark:bg-zinc-800/80 dark:active:bg-zinc-700/70'
                }`}
                onClick={() => handleSelectFromList(c)}
              >
                <div className="flex items-center gap-3">
                  <User className={`h-6 w-6 shrink-0 ${c.is_banned ? 'text-red-500' : 'text-gray-600 dark:text-gray-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={`font-medium truncate ${c.is_banned ? 'text-red-500' : 'liquid-glass-modal-text'}`}>{c.name}</p>
                      {c.is_banned && (
                        <span className="px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-500 rounded-full flex items-center gap-1">
                          <Ban className="w-3 h-3" />
                          {t('modals.customerSearch.banned', 'BANNED')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-sm liquid-glass-modal-text-muted">
                      <Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" />
                      <span>{c.phone}</span>
                    </p>
                    {c.is_banned && c.ban_reason && (
                      <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {c.ban_reason}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {customer && (
        <div className={`mb-6 rounded-2xl border p-4 ${
          customer.is_banned
            ? 'border-red-500/50 bg-red-500/5'
            : 'border-zinc-300/70 bg-zinc-100/85 dark:border-zinc-700/70 dark:bg-zinc-800/80'
        }`}>
          {/* Banned Customer Warning Banner */}
          {customer.is_banned && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-2xl">
              <div className="flex items-center gap-2 text-red-500 mb-1">
                <Ban className="w-5 h-5" />
                <span className="font-semibold text-sm uppercase tracking-wide">
                  {t('modals.customerSearch.bannedCustomer', 'Banned Customer')}
                </span>
              </div>
              {customer.ban_reason && (
                <p className="text-sm text-red-400 flex items-start gap-2 mt-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{t('modals.customerSearch.banReason', 'Reason')}: {customer.ban_reason}</span>
                </p>
              )}
              {customer.banned_at && (
                <p className="text-xs text-red-400/70 mt-1 ml-6">
                  {t('modals.customerSearch.bannedOn', 'Banned on')}: {formatDate(customer.banned_at)}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <User className={`h-7 w-7 shrink-0 ${customer.is_banned ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`} />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className={`max-w-full truncate font-medium ${customer.is_banned ? 'text-red-500' : 'liquid-glass-modal-text'}`}>
                  {customer.name}
                </h3>
                {customer.is_banned && (
                  <span className="px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-500 rounded-full flex items-center gap-1">
                    <Ban className="w-3 h-3" />
                    {t('modals.customerSearch.banned', 'BANNED')}
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1.5 text-sm liquid-glass-modal-text-muted">
                <Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" />
                <span>{customer.phone}</span>
              </p>
            </div>
          </div>

          {customer.addresses && customer.addresses.length > 0 ? (
            // Multiple addresses - show a card for EACH address
            <div className={callerIdWorkspace
              ? 'mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'
              : 'mt-3 space-y-2'}>
              <p
                className={`mb-1 text-xs font-semibold uppercase tracking-wider ${callerIdWorkspace ? 'md:col-span-2 xl:col-span-3' : ''}`}
                style={{ color: resolvedTheme === 'dark' ? 'rgba(250, 204, 21, 0.85)' : '#ca8a04' }}
              >
                {t('modals.customerSearch.addresses', 'Addresses')}
              </p>
              {customer.addresses.map((addr) => {
                const isSelected = selectedAddressId === addr.id;
                return (
                  <div
                    key={addr.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedAddressId(addr.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      setSelectedAddressId(addr.id);
                    }}
                    className={`w-full cursor-pointer rounded-lg p-2 transition-all ${callerIdWorkspace ? 'min-h-[116px] !rounded-xl !p-4' : ''} ${isSelected
                      ? 'border-2 border-green-500/60 bg-transparent'
                      : 'border border-gray-200 bg-transparent active:border-gray-300 dark:border-white/10 dark:active:border-white/20'
                      }`}
                  >
                    <div className="flex items-start gap-2">
                      {/* Checkmark or MapPin icon */}
                      {isSelected ? (
                        <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      ) : (
                        <MapPin className="w-4 h-4 text-gray-500 dark:text-gray-300 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${isSelected ? 'text-green-400' : 'liquid-glass-modal-text'}`}>
                          {resolveAddressStreet(addr)}
                        </p>
                        <p className="text-xs liquid-glass-modal-text-muted">
                          {[addr.city, addr.postal_code].filter(Boolean).join(', ')}
                        </p>
                        {addr.floor_number && (
                          <p className="text-xs liquid-glass-modal-text-muted">
                            {t('modals.customerSearch.floor')}: {addr.floor_number}
                          </p>
                        )}
                      </div>
                      {/* Operational actions are intentionally hidden for passive Caller ID lookup. */}
                      {!lookupOnly && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onEditCustomer) {
                              onEditCustomer({ ...customer, editAddressId: addr.id } as any);
                            }
                          }}
                          className="p-1.5 text-amber-500 active:bg-amber-500/20 rounded-md transition-colors"
                          aria-label={t('common.edit', 'Edit')}
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            // Use toast confirmation for address deletion
                            toast((toastInstance) => (
                              <div className="flex flex-col gap-3">
                                <p className="text-sm font-medium">{t('modals.customerSearch.confirmDeleteAddress', 'Delete this address?')}</p>
                                <div className="flex gap-2">
                                  <button
                                    onClick={async () => {
                                      toast.dismiss(toastInstance.id);
                                      try {
                                        const result = await bridge.customers.deleteAddress(customer.id, addr.id);
                                        if (result?.success !== false) {
                                          setCustomer(prev => prev ? {
                                            ...prev,
                                            addresses: prev.addresses?.filter(a => a.id !== addr.id)
                                          } : null);
                                          if (isSelected) {
                                            const remaining = customer.addresses?.filter(a => a.id !== addr.id);
                                            setSelectedAddressId(remaining?.[0]?.id || null);
                                          }
                                          toast.success(
                                            result?.queued
                                              ? t('modals.customerSearch.deleteAddressQueued', 'Address deleted and queued for sync')
                                              : t('modals.customerSearch.deleteAddressSuccess', 'Address deleted'),
                                          );
                                        } else {
                                          toast.error(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                        }
                                      } catch (err) {
                                        console.error('Error deleting address:', err);
                                        toast.error(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                      }
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-md active:bg-red-600 transition-colors"
                                  >
                                    {t('common.delete', 'Delete')}
                                  </button>
                                  <button
                                    onClick={() => toast.dismiss(toastInstance.id)}
                                    className="px-3 py-1.5 text-xs font-medium bg-gray-500 text-white rounded-md active:bg-gray-600 transition-colors"
                                  >
                                    {t('common.cancel', 'Cancel')}
                                  </button>
                                </div>
                              </div>
                            ), { duration: 10000 });
                          }}
                          className="p-1.5 text-red-500 active:bg-red-500/20 rounded-md transition-colors"
                          aria-label={t('common.delete', 'Delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            // Single or no addresses - show full details as originally
            <div className="mt-3 space-y-1">
              {customer.email && (
                <p className="text-sm liquid-glass-modal-text-muted flex items-center gap-2">
                  <Mail className="w-4 h-4" aria-hidden="true" />
                  <span>{customer.email}</span>
                </p>
              )}
              {customer.address && (
                <p className="text-sm liquid-glass-modal-text-muted flex items-start gap-1">
                  <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    {customer.address}
                    {customer.postal_code && ` (${customer.postal_code})`}
                    {customer.floor_number && `, ${t('modals.customerSearch.floor')}: ${customer.floor_number}`}
                  </span>
                </p>
              )}
              {customer.name_on_ringer && (
                <p className="text-sm liquid-glass-modal-text-muted">
                  🔔 {t('modals.customerSearch.nameOnRinger')}: {customer.name_on_ringer}
                </p>
              )}
              {customer.notes && (
                <p className="text-sm liquid-glass-modal-text-muted">
                  📝 {customer.notes}
                </p>
              )}
            </div>
          )}

          {!callerIdWorkspace && (!lookupOnly || Boolean(onCustomerSelected)) && (
            <>
              {/* Continue Button - prominent, shows selected address */}
              <button
                onClick={handleSelectCustomer}
                style={{
                  backgroundColor: '#16a34a',
                  color: '#ffffff',
                  borderColor: '#16a34a'
                }}
                className="w-full mt-4 py-3 px-6 rounded-xl font-medium flex items-center justify-center transition-all duration-300 border active:bg-green-700 dark:active:bg-green-600/30 active:scale-[0.98]"
              >
                <span>
                  {selectedAddressId && customer.addresses?.find(a => a.id === selectedAddressId)
                    ? t('modals.customerSearch.continueWithAddress', 'Continue with {{address}}', {
                      address: resolveAddressStreet(customer.addresses.find(a => a.id === selectedAddressId))
                    })
                    : t('modals.customerSearch.continue', 'Continue')
                  }
                </span>
                <ArrowRight className="w-5 h-5" />
              </button>

              {!lookupOnly && (
                <>
                  {/* Action Buttons - Add Address, Edit Customer, Delete */}
                  <div className="flex gap-2 mt-3">
            {/* Add Address Button */}
            {onAddNewAddress && (
              <button
                onClick={handleAddNewAddress}
                style={{
                  backgroundColor: 'transparent',
                  color: resolvedTheme === 'dark' ? '#ffffff' : '#111827',
                  borderColor: resolvedTheme === 'dark' ? 'rgba(250, 204, 21, 0.4)' : '#ca8a04'
                }}
                className="flex-1 py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-transform duration-150 active:scale-[0.98] border gap-1"
              >
                <MapPin className="w-4 h-4 text-amber-500 dark:text-amber-300" />
                {t('modals.customerSearch.addNewAddress')}
              </button>
            )}
            {/* Edit Customer Button */}
            {onEditCustomer && (
              <button
                onClick={handleEditCustomer}
                style={{
                  backgroundColor: 'transparent',
                  color: resolvedTheme === 'dark' ? '#ffffff' : '#111827',
                  borderColor: resolvedTheme === 'dark' ? 'rgba(245, 158, 11, 0.3)' : '#d97706'
                }}
                className="flex-1 py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-all duration-300 border gap-1"
              >
                <Edit className="w-4 h-4 text-amber-500 dark:text-amber-300" />
                {t('modals.customerSearch.editCustomer')}
              </button>
            )}
            {/* Delete Customer Button */}
            <button
              onClick={handleDeleteCustomer}
              style={{
                backgroundColor: 'transparent',
                color: resolvedTheme === 'dark' ? '#ffffff' : '#111827',
                borderColor: resolvedTheme === 'dark' ? 'rgba(239, 68, 68, 0.3)' : '#dc2626'
              }}
              className="py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-all duration-300 border gap-1"
              aria-label={t('modals.customerSearch.deleteCustomer')}
            >
              <Trash2 className="w-4 h-4 text-red-500 dark:text-red-400" />
            </button>
                  </div>
                </>
              )}
            </>
          )}
          {callerIdWorkspace && lookupOnly && onAddNewAddress && (
            <>
              {/* Caller ID add-address action */}
              <button
                type="button"
                onClick={handleAddNewAddress}
                className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-amber-600 bg-white px-4 py-3 font-semibold text-slate-900 transition-transform active:scale-[0.98] dark:border-amber-400/50 dark:bg-slate-900 dark:text-white"
              >
                <MapPin className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                {t('modals.customerSearch.addNewAddress', 'Add address')}
              </button>
            </>
          )}
        </div>
      )}

      {!callerIdWorkspace && onContinueWithoutCustomer && lookupQuery.length >= 3 && !isSearching && error === t('modals.customerSearch.customerNotFound') && (
        <button
          type="button"
          onClick={() => onContinueWithoutCustomer(searchQuery.trim())}
          className="mb-3 w-full rounded-xl border border-yellow-400/60 bg-yellow-400 px-6 py-3 font-semibold text-black transition-transform active:scale-[0.98]"
        >
          {t('modals.customerSearch.chooseOrderType', 'Continue to order type')}
        </button>
      )}

      {callerIdWorkspace &&
        !isSearching &&
        (Boolean(customer) || error === t('modals.customerSearch.customerNotFound')) && (
        <section
          className="mb-4"
          aria-labelledby="caller-id-order-actions-title"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3
                id="caller-id-order-actions-title"
                className="font-semibold liquid-glass-modal-text"
              >
                {t('orderFlow.selectOrderType', 'Select order type')}
              </h3>
              <p className="text-sm liquid-glass-modal-text-muted">
                {customer
                  ? t('modals.customerSearch.chooseAddressThenOrder', 'Choose an address for delivery, then continue directly.')
                  : t('modals.customerSearch.pickupWithoutCustomer', 'Pickup can continue without registering a customer. Delivery requires customer details.')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {callerIdWorkspace.enabledOrderTypes.map((type) => {
              const config = {
                delivery: {
                  label: t('orderFlow.deliveryOrder', 'Delivery'),
                  icon: Truck,
                  classes: 'border-yellow-500',
                  iconClasses: 'text-yellow-600',
                },
                pickup: {
                  label: t('orderFlow.pickupOrder', 'Pickup'),
                  icon: ShoppingBag,
                  classes: 'border-emerald-500',
                  iconClasses: 'text-emerald-600',
                },
                'dine-in': {
                  label: t('orderFlow.tableOrder', 'Table'),
                  icon: UtensilsCrossed,
                  classes: 'border-amber-500',
                  iconClasses: 'text-amber-600',
                },
                room: {
                  label: t('orderFlow.roomOrder', 'Room'),
                  icon: BedDouble,
                  classes: 'border-amber-500',
                  iconClasses: 'text-amber-600',
                },
                service: {
                  label: t('orderFlow.serviceOrder', 'Service'),
                  icon: CalendarClock,
                  classes: 'border-amber-500',
                  iconClasses: 'text-amber-600',
                },
              }[type];
              const Icon = config.icon;
              return (
                <button
                  key={type}
                  type="button"
                  data-caller-id-order-type={type}
                  onClick={() => callerIdWorkspace.onOrderTypeSelected(
                    type,
                    buildSelectedCustomer(),
                    searchQuery.trim(),
                  )}
                  className={`flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-2xl border-2 bg-white px-4 py-4 font-semibold text-slate-900 shadow-[0_7px_0_rgba(15,23,42,0.12),0_14px_28px_rgba(15,23,42,0.14)] transition-transform active:translate-y-1 active:shadow-sm dark:bg-white dark:text-slate-900 ${config.classes}`}
                >
                  <Icon className={`h-8 w-8 ${config.iconClasses}`} strokeWidth={1.8} />
                  <span className="text-center text-sm leading-tight">{config.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Add New Customer Option - only after an authoritative not-found result in Caller ID mode. */}
      {!callerIdWorkspace && Boolean(onAddNewCustomer) && lookupQuery.length >= 3 && !isSearching && ((!lookupOnly && customer) || error === t('modals.customerSearch.customerNotFound')) && (
        <div className="p-4 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-2xl">
          <p className="text-sm liquid-glass-modal-text-muted mb-3">
            {customer
              ? t('modals.customerSearch.differentPersonPrompt')
              : t('modals.customerSearch.notFoundPrompt')
            }
          </p>
          <button
            onClick={handleAddNewCustomer}
            style={{
              backgroundColor: '#16a34a',
              color: '#ffffff',
              borderColor: '#16a34a'
            }}
            className="w-full py-3 px-6 rounded-xl font-medium flex items-center justify-center transition-all duration-300 border active:bg-green-700 dark:active:bg-green-600/30 active:scale-[0.98]"
          >
            {t('modals.customerSearch.addNewCustomer')}
          </button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {!lookupOnly && (
        <ConfirmDialog
          isOpen={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={performDeleteCustomer}
          title={t('modals.customerSearch.deleteCustomerTitle', 'Delete Customer')}
          message={t('modals.customerSearch.confirmDelete')}
          variant="error"
          confirmText={t('common.delete', 'Delete')}
          cancelText={t('common.cancel', 'Cancel')}
          isLoading={isDeleting}
        />
      )}
    </LiquidGlassModal>
  );
};

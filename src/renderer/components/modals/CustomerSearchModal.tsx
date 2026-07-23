import React, { useState, useEffect, useCallback, useRef } from 'react';
import { User, Phone, MapPin, Trash2, Edit, Check, ArrowRight, Search, Ban, AlertTriangle, Mail } from 'lucide-react';
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

interface CustomerSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCustomerSelected: (customer: Customer) => void;
  onAddNewCustomer: (phone: string) => void;
  onAddNewAddress?: (customer: Customer) => void;
  onEditCustomer?: (customer: Customer) => void;
  /** Pre-selected customer to show directly (e.g., after editing an address) */
  initialCustomer?: Customer | null;
}

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

export const CustomerSearchModal: React.FC<CustomerSearchModalProps> = ({
  isOpen,
  onClose,
  onCustomerSelected,
  onAddNewCustomer,
  onAddNewAddress,
  onEditCustomer,
  initialCustomer,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchDisposedRef = useRef(false);
  const searchRequestSeqRef = useRef(0);
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

  // Set customer from initialCustomer prop when modal opens
  useEffect(() => {
    if (isOpen && initialCustomer) {
      setCustomer(withMaterializedCustomerAddresses({
        ...initialCustomer,
        addresses: normalizeCustomerAddresses(initialCustomer.addresses),
      }) as Customer);
      setSearchQuery(initialCustomer.phone || '');
      setCustomers([]);
      setError(null);
    }
  }, [isOpen, initialCustomer]);

  // Auto-select default or first address when customer is found
  useEffect(() => {
    if (customer) {
      const defaultAddr = resolveSelectedCustomerAddress(customer);
      setSelectedAddressId(defaultAddr?.id ?? null);
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
    // Clear any existing timeout
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    // Set a new timeout for debounced search
    const newTimeout = setTimeout(() => {
      searchCustomer(searchQuery);
    }, 300); // 300ms delay

    setSearchTimeout(newTimeout);

    // Cleanup function
    return () => {
      if (newTimeout) {
        clearTimeout(newTimeout);
      }
    };
  }, [searchQuery, searchCustomer]);

  // Manual search function (keeping for backward compatibility)
  const handleManualSearch = () => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    searchCustomer(searchQuery);
  };

  const handleSelectCustomer = () => {
    if (customer) {
      // Debug: Log customer data before selection
      console.log('[CustomerSearch] handleSelectCustomer - customer:', {
        id: customer.id,
        name: customer.name,
        name_on_ringer: customer.name_on_ringer,
        addressCount: customer.addresses?.length,
        addresses: customer.addresses?.map(a => ({
          id: a.id,
          street: resolveAddressStreet(a),
          notes: a.notes
        }))
      });

      // Determine which address to use - either the explicitly selected one, or default/first
      let addressToUse = selectedAddressId;

      // If no address explicitly selected but customer has addresses, use default or first
      if (!addressToUse && customer.addresses && customer.addresses.length > 0) {
        const defaultAddr = resolveSelectedCustomerAddress(customer);
        addressToUse = defaultAddr?.id ?? null;
      }

      // Use the selected/default address if available
      if (addressToUse && customer.addresses) {
        const selectedAddr = customer.addresses.find(a => a.id === addressToUse);
        if (selectedAddr) {
          const selectedStreet = resolveAddressStreet(selectedAddr) || customer.address || '';
          console.log('[CustomerSearch] Selected address:', {
            id: selectedAddr.id,
            street: selectedStreet,
            notes: selectedAddr.notes,
            rawAddress: selectedAddr
          });
          const customerWithSelectedAddress = {
            ...customer,
            address: selectedStreet,
            city: selectedAddr.city,
            postal_code: selectedAddr.postal_code,
            floor_number: selectedAddr.floor_number,
            notes: selectedAddr.notes || customer.notes,
            coordinates: selectedAddr.coordinates ?? customer.coordinates,
            latitude: selectedAddr.latitude ?? customer.latitude ?? null,
            longitude: selectedAddr.longitude ?? customer.longitude ?? null,
            selected_address_id: selectedAddr.id
          };
          console.log('[CustomerSearch] Passing to OrderFlow:', {
            name_on_ringer: customerWithSelectedAddress.name_on_ringer,
            notes: customerWithSelectedAddress.notes
          });
          onCustomerSelected(customerWithSelectedAddress);
          return;
        }
      }
      // No address selected or no addresses, proceed with customer as-is
      onCustomerSelected(customer);
    }
  };

  const handleAddNewCustomer = () => {
    // Pass the search query - if it looks like a phone number, use it as phone
    const isLikelyPhone = /^[0-9+\-\s()]+$/.test(searchQuery.trim());
    onAddNewCustomer(isLikelyPhone ? searchQuery : '');
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
    const value = e.target.value;
    setSearchQuery(value);

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

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.customerSearch.title')}
      size="sm"
      className="!max-w-md"
      closeOnBackdrop={true}
      closeOnEscape={true}
      initialFocusRef={searchInputRef}
    >
      {/* Search Input */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
          {t('modals.customerSearch.searchLabel', 'Phone Number or Name')}
        </label>
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 z-10 ${resolvedTheme === 'dark' ? 'text-white' : 'text-black'}`} />
          <input
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
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-600 dark:text-red-400 text-sm">
          {error}
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
              <div
                key={c.id}
                className={`relative mb-3 cursor-pointer rounded-2xl border p-4 transition-all ${
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
              </div>
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
            <div className="mt-3 space-y-2">
              <p
                className="mb-1 text-xs font-semibold uppercase tracking-wider"
                style={{ color: resolvedTheme === 'dark' ? 'rgba(250, 204, 21, 0.85)' : '#ca8a04' }}
              >
                {t('modals.customerSearch.addresses', 'Addresses')}
              </p>
              {customer.addresses.map((addr) => {
                const isSelected = selectedAddressId === addr.id;
                return (
                  <div
                    key={addr.id}
                    onClick={() => setSelectedAddressId(addr.id)}
                    className={`w-full cursor-pointer rounded-lg p-2 transition-all ${isSelected
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
                      {/* Edit and Delete buttons */}
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
        </div>
      )}

      {/* Add New Customer Option - Show when customer not found OR when customer is found (for different person with same phone) */}
      {searchQuery.length >= 3 && !isSearching && (customer || error === t('modals.customerSearch.customerNotFound')) && (
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
    </LiquidGlassModal>
  );
};

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { User, Phone, MapPin, Trash2, Edit, Check, ArrowRight, Search, Ban, AlertTriangle, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { getApiUrl } from '../../../config/environment';
import { posApiGet } from '../../utils/api-helpers';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useTheme } from '../../contexts/theme-context';
import { inputBase } from '../../styles/designSystem';
import { formatDate } from '../../utils/format';
import { getCachedTerminalCredentials, refreshTerminalCredentialCache } from '../../services/terminal-credentials';

interface CustomerAddress {
  id: string;
  street_address: string;
  street?: string;
  city: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  address_type: string;
  is_default: boolean;
  created_at: string;
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
  return {
    ...address,
    id: address?.id ?? '',
    city: typeof address?.city === 'string' ? address.city : '',
    street: normalizedStreet,
    street_address: normalizedStreet,
    notes: address?.notes ?? address?.delivery_notes,
    address_type: typeof address?.address_type === 'string' ? address.address_type : 'delivery',
    is_default: Boolean(address?.is_default),
    created_at: typeof address?.created_at === 'string' ? address.created_at : '',
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
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const resolvePosCredentials = useCallback(async (): Promise<{ posKey: string; termId: string }> => {
    const ls = typeof window !== 'undefined' ? window.localStorage : null;
    const electron = typeof window !== 'undefined' ? window.electron : undefined;

    let posKey = '';
    let termId = '';

    try {
      if (electron?.ipcRenderer) {
        const [mainTerminalId, mainApiKey] = await Promise.all([
          electron.ipcRenderer.invoke('terminal-config:get-setting', 'terminal', 'terminal_id'),
          electron.ipcRenderer.invoke('terminal-config:get-setting', 'terminal', 'pos_api_key'),
        ]);
        termId = (mainTerminalId || '').toString().trim();
        posKey = (mainApiKey || '').toString().trim();
      }
    } catch (e) {
      console.warn('[CustomerSearch] Failed to get credentials from main process:', e);
    }

    const refreshed = await refreshTerminalCredentialCache();
    if (!posKey) {
      posKey = (refreshed.apiKey || getCachedTerminalCredentials().apiKey || '').trim();
    }
    if (!termId) {
      termId = (refreshed.terminalId || ls?.getItem('terminal_id') || '').trim();
    }

    return { posKey, termId };
  }, []);

  // Set customer from initialCustomer prop when modal opens
  useEffect(() => {
    if (isOpen && initialCustomer) {
      setCustomer({
        ...initialCustomer,
        addresses: normalizeCustomerAddresses(initialCustomer.addresses),
      });
      setSearchQuery(initialCustomer.phone || '');
      setCustomers([]);
      setError(null);
    }
  }, [isOpen, initialCustomer]);

  // Auto-select default or first address when customer is found
  useEffect(() => {
    if (customer?.addresses && customer.addresses.length > 0) {
      const defaultAddr = customer.addresses.find(a => a.is_default) || customer.addresses[0];
      setSelectedAddressId(defaultAddr.id);
    } else {
      setSelectedAddressId(null);
    }
  }, [customer]);


  // Debounced search function - now supports phone or name
  const searchCustomer = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 3) {
      setCustomer(null);
      setCustomers([]);
      setError(null);
      return;
    }

    setIsSearching(true);
    setError(null);
    setCustomer(null);
    setCustomers([]);

    try {
      const { posKey, termId } = await resolvePosCredentials();

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
        const customersList = payload.customers.map((c: any) => ({
          id: c.id,
          phone: c.phone,
          name: c.name,
          email: c.email,
          address: c.address,
          postal_code: c.postal_code,
          floor_number: c.floor_number,
          notes: c.notes,
          name_on_ringer: c.name_on_ringer,
          version: c.version,
          addresses: normalizeCustomerAddresses(c.addresses),
          is_banned: c.is_banned,
          ban_reason: c.ban_reason,
          banned_at: c.banned_at,
        }));
        setError(null);
        setCustomers(customersList);
        setCustomer(null);
      } else if (payload?.success && payload.customer) {
        // Single customer result
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
      console.error('Error searching customer:', err);
      setError(t('modals.customerSearch.searchError'));
    } finally {
      setIsSearching(false);
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
        const defaultAddr = customer.addresses.find(a => a.is_default) || customer.addresses[0];
        addressToUse = defaultAddr.id;
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
      const { posKey, termId } = await resolvePosCredentials();

      // Build headers with POS authentication
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) {
        headers['x-pos-api-key'] = String(posKey);
      }
      if (termId) {
        headers['x-terminal-id'] = String(termId);
      }

      const response = await fetch(getApiUrl(`pos/customers/${customer.id}`), {
        method: 'DELETE',
        headers,
        credentials: 'omit', // Don't send cookies for POS endpoint
      });

      const result = await response.json();

      if (result.success) {
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

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
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

  // Autofocus and select search input when modal opens
  useEffect(() => {
    if (isOpen) {
      // Use a slightly longer timeout to ensure modal animation completes
      const timer = setTimeout(() => {
        const el = searchInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Helper to select a customer from the list - fetch fresh data with addresses
  const handleSelectFromList = async (selectedCustomer: Customer) => {
    setIsSearching(true);
    try {
      // Fetch fresh customer data with addresses using the customer's phone
      const { posKey, termId } = await resolvePosCredentials();

      // Fetch by exact phone to get full customer data with addresses
      const endpoint = `pos/customers?phone=${encodeURIComponent(selectedCustomer.phone)}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) headers['x-pos-api-key'] = String(posKey);
      if (termId) headers['x-terminal-id'] = String(termId);

      const result = await posApiGet<any>(endpoint, { headers, credentials: 'omit' });
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
      console.error('Error fetching customer details:', err);
      // Fallback to using the selected customer from list
      setCustomer(selectedCustomer);
      setCustomers([]);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.customerSearch.title')}
      size="md"
      closeOnBackdrop={true}
      closeOnEscape={true}
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
            className={`${inputBase(resolvedTheme)} pl-10`}
            autoFocus
          />
          {/* Real-time search indicator */}
          {isSearching && (
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
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
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Multiple Customers Found */}
      {customers.length > 0 && !customer && (
        <div className="mb-4">
          <p className="text-sm liquid-glass-modal-text-muted mb-2">
            {t('modals.customerSearch.multipleResults', { count: customers.length })}
          </p>
          <div className="max-h-60 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            {customers.map((c) => (
              <div
                key={c.id}
                className={`liquid-glass-modal-card cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/30 transition-all mb-3 relative group ${c.is_banned ? 'border-red-500/50 bg-red-500/5' : ''}`}
                onClick={() => handleSelectFromList(c)}
              >
                <div className="flex items-center gap-3">
                  <User className={`w-4 h-4 ${c.is_banned ? 'text-red-500' : 'text-blue-600 dark:text-blue-400'}`} />
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
                    <p className="text-sm liquid-glass-modal-text-muted">📞 {c.phone}</p>
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
        <div className={`mb-6 liquid-glass-modal-card ${customer.is_banned ? 'border-red-500/50' : ''}`}>
          {/* Banned Customer Warning Banner */}
          {customer.is_banned && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
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

          <div className="flex items-start gap-3">
            <User className={`w-5 h-5 mt-1 ${customer.is_banned ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`} />
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className={`font-medium ${customer.is_banned ? 'text-red-500' : 'liquid-glass-modal-text'}`}>
                  {customer.name}
                </h3>
                {customer.is_banned && (
                  <span className="px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-500 rounded-full flex items-center gap-1">
                    <Ban className="w-3 h-3" />
                    {t('modals.customerSearch.banned', 'BANNED')}
                  </span>
                )}
              </div>
              <p className="text-sm liquid-glass-modal-text-muted mb-1">
                📞 {customer.phone}
              </p>
              {customer.addresses && customer.addresses.length > 0 ? (
                // Multiple addresses - show a card for EACH address
                <div className="mt-2 space-y-2">
                  <p
                    className="text-xs font-semibold uppercase tracking-wider mb-1"
                    style={{ color: resolvedTheme === 'dark' ? 'rgba(96, 165, 250, 0.8)' : '#2563eb' }}
                  >
                    {t('modals.customerSearch.addresses', 'Addresses')}
                  </p>
                  {customer.addresses.map((addr) => {
                    const isSelected = selectedAddressId === addr.id;
                    return (
                      <div
                        key={addr.id}
                        onClick={() => setSelectedAddressId(addr.id)}
                        className={`p-2 rounded-lg cursor-pointer transition-all ${isSelected
                          ? 'bg-green-500/10 border-2 border-green-500/30 shadow-[0_0_15px_rgba(34,197,94,0.1)]'
                          : 'bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 border border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20'
                          }`}
                      >
                        <div className="flex items-start gap-2">
                          {/* Checkmark or MapPin icon */}
                          {isSelected ? (
                            <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                          ) : (
                            <MapPin className="w-4 h-4 text-gray-500 dark:text-blue-500 mt-0.5 flex-shrink-0" />
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
                              className="p-1.5 text-amber-500 hover:bg-amber-500/20 rounded-md transition-colors"
                              title={t('common.edit', 'Edit')}
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
                                            const { posKey, termId } = await resolvePosCredentials();

                                            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                            if (posKey) headers['x-pos-api-key'] = String(posKey);
                                            if (termId) headers['x-terminal-id'] = String(termId);

                                            const response = await fetch(getApiUrl(`pos/customers/${customer.id}/addresses/${addr.id}`), {
                                              method: 'DELETE',
                                              headers,
                                              credentials: 'omit',
                                            });
                                            const result = await response.json().catch(() => ({}));
                                            if (response.ok && result.success !== false) {
                                              setCustomer(prev => prev ? {
                                                ...prev,
                                                addresses: prev.addresses?.filter(a => a.id !== addr.id)
                                              } : null);
                                              if (isSelected) {
                                                const remaining = customer.addresses?.filter(a => a.id !== addr.id);
                                                setSelectedAddressId(remaining?.[0]?.id || null);
                                              }
                                              toast.success(t('modals.customerSearch.deleteAddressSuccess', 'Address deleted'));
                                            } else {
                                              toast.error(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                            }
                                          } catch (err) {
                                            console.error('Error deleting address:', err);
                                            toast.error(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                          }
                                        }}
                                        className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors"
                                      >
                                        {t('common.delete', 'Delete')}
                                      </button>
                                      <button
                                        onClick={() => toast.dismiss(toastInstance.id)}
                                        className="px-3 py-1.5 text-xs font-medium bg-gray-500 text-white rounded-md hover:bg-gray-600 transition-colors"
                                      >
                                        {t('common.cancel', 'Cancel')}
                                      </button>
                                    </div>
                                  </div>
                                ), { duration: 10000 });
                              }}
                              className="p-1.5 text-red-500 hover:bg-red-500/20 rounded-md transition-colors"
                              title={t('common.delete', 'Delete')}
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
                <>
                  {customer.email && (
                    <p className="text-sm liquid-glass-modal-text-muted mb-1 flex items-center gap-2">
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
                    <p className="text-sm liquid-glass-modal-text-muted mt-1">
                      🔔 {t('modals.customerSearch.nameOnRinger')}: {customer.name_on_ringer}
                    </p>
                  )}
                  {customer.notes && (
                    <p className="text-sm liquid-glass-modal-text-muted mt-1">
                      📝 {customer.notes}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Continue Button - prominent, shows selected address */}
          <button
            onClick={handleSelectCustomer}
            style={{
              backgroundColor: resolvedTheme === 'dark' ? 'rgba(22, 163, 74, 0.2)' : '#16a34a',
              color: resolvedTheme === 'dark' ? 'rgb(74, 222, 128)' : '#ffffff',
              borderColor: resolvedTheme === 'dark' ? 'rgba(34, 197, 94, 0.3)' : '#16a34a'
            }}
            className="w-full mt-4 py-3 px-6 rounded-xl font-medium flex items-center justify-center transition-all duration-300 border hover:bg-green-700 dark:hover:bg-green-600/30"
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
                  backgroundColor: resolvedTheme === 'dark' ? 'rgba(59, 130, 246, 0.2)' : '#2563eb',
                  color: resolvedTheme === 'dark' ? 'rgb(96, 165, 250)' : '#ffffff',
                  borderColor: resolvedTheme === 'dark' ? 'rgba(59, 130, 246, 0.3)' : '#2563eb'
                }}
                className="flex-1 py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-all duration-300 border hover:bg-blue-700 dark:hover:bg-blue-500/30 gap-1"
              >
                <MapPin className="w-4 h-4" />
                {t('modals.customerSearch.addNewAddress')}
              </button>
            )}
            {/* Edit Customer Button */}
            {onEditCustomer && (
              <button
                onClick={handleEditCustomer}
                style={{
                  backgroundColor: resolvedTheme === 'dark' ? 'rgba(245, 158, 11, 0.2)' : '#d97706',
                  color: resolvedTheme === 'dark' ? 'rgb(251, 191, 36)' : '#ffffff',
                  borderColor: resolvedTheme === 'dark' ? 'rgba(245, 158, 11, 0.3)' : '#d97706'
                }}
                className="flex-1 py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-all duration-300 border hover:bg-amber-700 dark:hover:bg-amber-500/30 gap-1"
              >
                <Edit className="w-4 h-4" />
                {t('modals.customerSearch.editCustomer')}
              </button>
            )}
            {/* Delete Customer Button */}
            <button
              onClick={handleDeleteCustomer}
              style={{
                backgroundColor: resolvedTheme === 'dark' ? 'rgba(239, 68, 68, 0.2)' : '#dc2626',
                color: resolvedTheme === 'dark' ? 'rgb(248, 113, 113)' : '#ffffff',
                borderColor: resolvedTheme === 'dark' ? 'rgba(239, 68, 68, 0.3)' : '#dc2626'
              }}
              className="py-2 px-4 rounded-lg font-medium flex items-center justify-center transition-all duration-300 border hover:bg-red-700 dark:hover:bg-red-500/30 gap-1"
              title={t('modals.customerSearch.deleteCustomer')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Add New Customer Option - Show when customer not found OR when customer is found (for different person with same phone) */}
      {searchQuery.length >= 3 && !isSearching && (customer || error === t('modals.customerSearch.customerNotFound')) && (
        <div className="p-4 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-xl">
          <p className="text-sm liquid-glass-modal-text-muted mb-3">
            {customer
              ? t('modals.customerSearch.differentPersonPrompt')
              : t('modals.customerSearch.notFoundPrompt')
            }
          </p>
          <button
            onClick={handleAddNewCustomer}
            style={{
              backgroundColor: resolvedTheme === 'dark' ? 'rgba(59, 130, 246, 0.2)' : '#2563eb',
              color: resolvedTheme === 'dark' ? 'rgb(96, 165, 250)' : '#ffffff',
              borderColor: resolvedTheme === 'dark' ? 'rgba(59, 130, 246, 0.3)' : '#2563eb'
            }}
            className="w-full py-3 px-6 rounded-xl font-medium flex items-center justify-center transition-all duration-300 border hover:bg-blue-700 dark:hover:bg-blue-500/30"
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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { User, Phone, MapPin, Trash2, Edit, Check, ArrowRight, Search, Ban, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getApiUrl, environment } from '../../../config/environment';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useTheme } from '../../contexts/theme-context';
import { inputBase } from '../../styles/designSystem';

interface CustomerAddress {
  id: string;
  street_address: string;
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

  // Set customer from initialCustomer prop when modal opens
  useEffect(() => {
    if (isOpen && initialCustomer) {
      setCustomer(initialCustomer);
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
      // Get POS API key and terminal ID from main process first (most reliable), then localStorage fallback
      const ls = typeof window !== 'undefined' ? window.localStorage : null;
      const electron = typeof window !== 'undefined' ? window.electron : undefined;

      let posKey = '';
      let termId = '';

      // Try to get credentials from main process via IPC (where connection string credentials are stored)
      try {
        if (electron?.ipcRenderer) {
          const [mainTerminalId, mainApiKey] = await Promise.all([
            electron.ipcRenderer.invoke('terminal-config:get-setting', 'terminal', 'terminal_id'),
            electron.ipcRenderer.invoke('terminal-config:get-setting', 'terminal', 'pos_api_key'),
          ]);
          termId = (mainTerminalId || '').toString().trim();
          posKey = (mainApiKey || '').toString().trim();
          console.log('[CustomerSearch] Got credentials from main process:', {
            hasTerminalId: !!termId,
            hasApiKey: !!posKey
          });
        }
      } catch (e) {
        console.warn('[CustomerSearch] Failed to get credentials from main process:', e);
      }

      // Fallback to localStorage if main process didn't have credentials
      if (!posKey) {
        posKey = (ls?.getItem('pos_api_key') || '').trim() ||
          (environment.POS_API_KEY || '').trim() ||
          (environment.POS_API_SHARED_KEY || '').trim() ||
          (ls?.getItem('POS_API_KEY') || ls?.getItem('POS_API_SHARED_KEY') || '').trim();
      }
      if (!termId) {
        termId = (ls?.getItem('terminal_id') || '').trim();
      }

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
      const endpoint = getApiUrl(`pos/customers?search=${encodedQuery}&phone=${encodedQuery}`);

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

      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        credentials: 'omit', // Don't send cookies for POS endpoint
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.warn('[CustomerSearch] Authentication failed (401). Check terminal credentials in Settings.');
          setError(t('modals.customerSearch.authFailed'));
          setIsSearching(false);
          return;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      // Handle multiple results
      if (result.success && result.multiple && result.customers) {
        const customersList = result.customers.map((c: any) => ({
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
          addresses: c.addresses,
          is_banned: c.is_banned,
          ban_reason: c.ban_reason,
          banned_at: c.banned_at,
        }));
        setError(null);
        setCustomers(customersList);
        setCustomer(null);
      } else if (result.success && result.customer) {
        // Single customer result
        const customerObj = {
          id: result.customer.id,
          phone: result.customer.phone,
          name: result.customer.name,
          email: result.customer.email,
          address: result.customer.address,
          postal_code: result.customer.postal_code,
          floor_number: result.customer.floor_number,
          notes: result.customer.notes,
          name_on_ringer: result.customer.name_on_ringer,
          version: result.customer.version,
          addresses: result.customer.addresses,
          is_banned: result.customer.is_banned,
          ban_reason: result.customer.ban_reason,
          banned_at: result.customer.banned_at,
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
  }, [t]);

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
          street: a.street_address,
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
          console.log('[CustomerSearch] Selected address:', {
            id: selectedAddr.id,
            street: selectedAddr.street_address,
            notes: selectedAddr.notes,
            rawAddress: selectedAddr
          });
          const customerWithSelectedAddress = {
            ...customer,
            address: selectedAddr.street_address,
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

  const handleDeleteCustomer = async () => {
    if (!customer) return;

    const confirmed = window.confirm(t('modals.customerSearch.confirmDelete'));
    if (!confirmed) return;

    try {
      const response = await fetch(getApiUrl(`customers/${customer.id}`), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        // Clear the customer from state
        setCustomer(null);
        setCustomers([]);
        setSearchQuery('');
        // Show success message (optional)
        alert(t('modals.customerSearch.deleteSuccess'));
      } else {
        throw new Error(result.error || 'Failed to delete customer');
      }
    } catch (err) {
      console.error('Error deleting customer:', err);
      alert(t('modals.customerSearch.deleteFailed'));
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
      const ls = typeof window !== 'undefined' ? window.localStorage : null;
      const electron = typeof window !== 'undefined' ? window.electron : undefined;

      let posKey = '';
      let termId = '';

      // Get credentials
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
        console.warn('[CustomerSearch] Failed to get credentials:', e);
      }

      if (!posKey) {
        posKey = (ls?.getItem('pos_api_key') || '').trim() ||
          (environment.POS_API_KEY || '').trim() ||
          (environment.POS_API_SHARED_KEY || '').trim();
      }
      if (!termId) {
        termId = (ls?.getItem('terminal_id') || '').trim();
      }

      // Fetch by exact phone to get full customer data with addresses
      const endpoint = getApiUrl(`pos/customers?phone=${encodeURIComponent(selectedCustomer.phone)}`);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) headers['x-pos-api-key'] = String(posKey);
      if (termId) headers['x-terminal-id'] = String(termId);

      const response = await fetch(endpoint, { method: 'GET', headers, credentials: 'omit' });

      if (response.ok) {
        const result = await response.json();
        if (result.success && result.customer) {
          console.log('[CustomerSearch] Full customer data received:', {
            id: result.customer.id,
            name: result.customer.name,
            name_on_ringer: result.customer.name_on_ringer,
            addressCount: result.customer.addresses?.length,
            addresses: result.customer.addresses?.map((a: any) => ({
              id: a.id,
              street: a.street_address,
              notes: a.notes
            }))
          });
          const customerObj = {
            id: result.customer.id,
            phone: result.customer.phone,
            name: result.customer.name,
            email: result.customer.email,
            address: result.customer.address,
            postal_code: result.customer.postal_code,
            floor_number: result.customer.floor_number,
            notes: result.customer.notes,
            name_on_ringer: result.customer.name_on_ringer,
            version: result.customer.version,
            addresses: result.customer.addresses,
            is_banned: result.customer.is_banned,
            ban_reason: result.customer.ban_reason,
            banned_at: result.customer.banned_at,
          };
          setCustomer(customerObj);
          setCustomers([]);
          return;
        }
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
                  {t('modals.customerSearch.bannedOn', 'Banned on')}: {new Date(customer.banned_at).toLocaleDateString()}
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
                              {addr.street_address}
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
                                if (!window.confirm(t('modals.customerSearch.confirmDeleteAddress', 'Delete this address?'))) return;
                                try {
                                  const response = await fetch(getApiUrl(`customers/${customer.id}/addresses/${addr.id}`), {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                  });
                                  const result = await response.json().catch(() => ({}));
                                  if (response.ok && result.success !== false) {
                                    setCustomer(prev => prev ? {
                                      ...prev,
                                      addresses: prev.addresses?.filter(a => a.id !== addr.id)
                                    } : null);
                                    // If deleted address was selected, select another
                                    if (isSelected) {
                                      const remaining = customer.addresses?.filter(a => a.id !== addr.id);
                                      setSelectedAddressId(remaining?.[0]?.id || null);
                                    }
                                  } else {
                                    alert(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                  }
                                } catch (err) {
                                  console.error('Error deleting address:', err);
                                  alert(t('modals.customerSearch.deleteAddressFailed', 'Failed to delete address'));
                                }
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
                    <p className="text-sm liquid-glass-modal-text-muted mb-1">
                      ✉️ {customer.email}
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
                  address: customer.addresses.find(a => a.id === selectedAddressId)?.street_address
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
    </LiquidGlassModal>
  );
};
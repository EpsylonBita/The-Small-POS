import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { posApiFetch, posApiGet } from '../utils/api-helpers';
import { renderModalPortal } from '../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import toast from 'react-hot-toast';
import { getBridge, offEvent, onEvent } from '../../lib';
import { parseSpecialAddressInput } from '../utils/specialAddress';
import {
  getLoyaltyTierKey,
  hasActiveUserDirectoryFilters,
  matchesUserDirectoryFilters,
  USER_LOYALTY_FILTERS,
  USER_STATUS_FILTERS,
  type UserLoyaltyFilter,
  type UserStatusFilter,
} from '../utils/userDirectoryFilters';
import {
  Users,
  Search,
  Filter,
  Eye,
  Edit3,
  Ban,
  CheckCircle,
  Mail,
  Phone,
  MapPin,
  Star,
  ShoppingBag,
  DollarSign,
  RefreshCw,
  Clock,
  Trash2,
  Save,
  X
} from 'lucide-react';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

interface UserProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  type?: 'customer' | 'app_user';
  loyalty_points: number;
  total_orders: number;
  created_at: string;
  updated_at?: string;
  address?: string;
  postal_code?: string;
  notes?: string;
  is_banned?: boolean;
}

interface CustomerAddress {
  id: string;
  customer_id: string;
  version?: number;
  street_address: string;
  city: string;
  postal_code: string;
  floor_number?: string;
  address_type?: string;
  is_default: boolean;
  delivery_notes?: string;
  latitude?: number;
  longitude?: number;
  place_id?: string;
  formatted_address?: string;
  resolved_street_number?: string;
  address_fingerprint?: string;
}

const USERS_PAGE_SIZE = 10;

function mapCustomerToUser(customer: any): UserProfile | null {
  const id = customer?.id || customer?.customer_id || customer?.customerId;
  if (!id) return null;

  return {
    id: String(id),
    name: customer.name || customer.full_name || customer.customer_name || customer.phone || '',
    email: customer.email || undefined,
    phone: customer.phone || customer.customer_phone || undefined,
    type: 'customer',
    loyalty_points: Number(customer.loyalty_points ?? customer.points_balance ?? 0) || 0,
    total_orders: Number(customer.total_orders ?? 0) || 0,
    created_at: customer.created_at || new Date(0).toISOString(),
    updated_at: customer.updated_at,
    address: customer.address,
    postal_code: customer.postal_code,
    notes: customer.notes,
    is_banned: Boolean(customer.is_banned),
  };
}

function extractCustomerList(payload: any): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.customers)) {
    return payload.customers;
  }

  if (Array.isArray(payload?.data?.customers)) {
    return payload.data.customers;
  }

  const customer = payload?.customer ?? payload?.data?.customer;
  return customer ? [customer] : [];
}

function mapCustomersToUsers(customers: any[]): UserProfile[] {
  return customers
    .map(mapCustomerToUser)
    .filter((user): user is UserProfile => Boolean(user));
}

async function fetchPosCustomersDirectory(): Promise<UserProfile[]> {
  const pageSize = 500;
  let page = 1;
  const customers: any[] = [];

  while (page <= 50) {
    const result = await posApiGet<any>(`pos/customers?page=${page}&limit=${pageSize}`);
    if (!result.success) {
      throw new Error(result.error || 'Failed to load customers');
    }

    const payload = result.data;
    const pageCustomers = extractCustomerList(payload);

    customers.push(...pageCustomers);

    const pagination = payload?.pagination ?? payload?.data?.pagination;
    const hasNextPage =
      pagination?.hasNextPage === true ||
      (!pagination && pageCustomers.length === pageSize);
    if (!hasNextPage) {
      break;
    }

    page += 1;
  }

  return mapCustomersToUsers(customers);
}

async function fetchNativeCustomersDirectory(bridge: ReturnType<typeof getBridge>): Promise<UserProfile[]> {
  const customers = extractCustomerList((await bridge.customers.search('')) || []);
  return mapCustomersToUsers(customers);
}

function createAddressSessionToken(): string {
  return [
    'addr',
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 12),
  ].join('_');
}

function buildAddressFingerprint(
  address: string,
  latitude?: number,
  longitude?: number
): string {
  const normalized = String(address || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0370-\u03ff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return normalized;
  }

  return `${normalized}|${Number(latitude).toFixed(5)}|${Number(longitude).toFixed(5)}`;
}

const UsersPage: React.FC = () => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [loyaltyFilter, setLoyaltyFilter] = useState<UserLoyaltyFilter>('all');
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [userAddresses, setUserAddresses] = useState<CustomerAddress[]>([]);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [addressPendingDelete, setAddressPendingDelete] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editedAddress, setEditedAddress] = useState<Partial<CustomerAddress>>({});
  const [addressSuggestions, setAddressSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const addressSessionTokenRef = useRef<string | null>(null);

  // Refs + stable title ids so the portaled modals can declare labelled dialog
  // semantics and join the topmost-[role="dialog"] Escape stack used across the POS.
  const detailsDialogRef = useRef<HTMLDivElement>(null);
  const detailsTitleId = useId();
  const deleteAddressTitleId = useId();
  const deleteAddressDialogRef = useRef<HTMLDivElement>(null);

  // Close-only path for the customer details modal. Mirrors the footer Close button
  // (clears the modal/view state only) and never calls ban/delete/address-save, so no
  // dismissal route can trigger a side effect.
  const closeDetailsModal = useCallback(() => {
    setShowDetailsModal(false);
    setSelectedUser(null);
    setUserAddresses([]);
  }, []);

  // Close-only path for the address-delete confirmation. Escape (and the existing
  // cancel/backdrop) clear the pending target only; it never calls the delete submit,
  // so dismissing the confirmation can never delete an address.
  const closeAddressDeleteModal = useCallback(() => {
    setAddressPendingDelete(null);
  }, []);

  // Escape closes the filter popover (a role="menu" dropdown, not a dialog) while it
  // is open, leaving status/loyalty filter state untouched.
  useEffect(() => {
    if (!showFilterMenu) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setShowFilterMenu(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showFilterMenu]);

  // Escape closes the customer details modal, mirroring the app-level POS modals.
  // Only the frontmost [role="dialog"] reacts, so the nested address-delete
  // confirmation (also a dialog, mounted above) stays in control while open and this
  // modal is never dismissed out of order. Routes through the close-only path above.
  useEffect(() => {
    if (!showDetailsModal) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== detailsDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeDetailsModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showDetailsModal, closeDetailsModal]);

  // Escape closes ONLY the address-delete confirmation while it is the frontmost
  // [role="dialog"] (it mounts above the details modal at a higher z-index). The details
  // modal's own Escape effect self-suppresses because the confirmation is topmost, so the
  // first Escape closes the confirmation and leaves the parent detail modal open. Routes
  // through the close-only path, never the delete submit.
  useEffect(() => {
    if (!addressPendingDelete) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== deleteAddressDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeAddressDeleteModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [addressPendingDelete, closeAddressDeleteModal]);

  useEffect(() => {
    loadUsers();

    // Listen for real-time customer updates from the main process
    const handleCustomerUpdate = (data: any) => {
      // Add null check for data
      if (!data) {
        console.warn('Received customer update event with undefined data');
        return;
      }

      if (data.eventType === 'UPDATE' && data.new) {
        setUsers(prev => prev.map(user =>
          user.id === data.new.id
            ? { ...user, is_banned: data.new.is_banned, updated_at: data.new.updated_at }
            : user
        ));
      }
    };

    onEvent('customer-updated', handleCustomerUpdate);
    onEvent('customer-realtime-update', handleCustomerUpdate);

    // Cleanup
    return () => {
      offEvent('customer-updated', handleCustomerUpdate);
      offEvent('customer-realtime-update', handleCustomerUpdate);
    };
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Use the native POS sync first. It can read customers directly from
      // Supabase with terminal credentials, avoiding tenant admin-host
      // timeouts. The POS HTTP API remains a compatibility fallback.
      const sources: Array<{ name: string; users: UserProfile[] }> = [];

      try {
        const nativeUsers = await fetchNativeCustomersDirectory(bridge);
        if (nativeUsers.length > 0) {
          sources.push({ name: 'native-customer-sync', users: nativeUsers });
        }
      } catch (cacheError) {
        console.warn('Customer native sync/cache unavailable:', cacheError);
      }

      if (sources.length === 0) {
        try {
          const remoteUsers = await fetchPosCustomersDirectory();
          if (remoteUsers.length > 0) {
            sources.push({ name: 'pos-customers-api', users: remoteUsers });
          }
        } catch (remoteError) {
          console.warn('POS customers API unavailable:', remoteError);
        }
      }

      const unified = sources
        .sort((left, right) => right.users.length - left.users.length)[0]?.users || [];

      // Deduplicate by ID in case IPC and live refresh overlap.
      const uniqueUsers = Array.from(
        new Map(unified.map(user => [user.id, user])).values()
      )

      console.info('[UsersPage] loaded customers', {
        count: uniqueUsers.length,
        sources: sources.map(source => ({ name: source.name, count: source.users.length })),
      });

      setUsers(uniqueUsers)
    } catch (error) {
      console.error('Error loading users:', error);
      toast.error(t('users.loadError') || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleViewUser = async (user: UserProfile) => {
    setSelectedUser(user);
    setShowDetailsModal(true);

    try {
      let matchedCustomer: any = await bridge.customers.lookupById(user.id);

      if (!matchedCustomer && user.phone) {
        const result = await posApiGet<any>(`pos/customers?phone=${encodeURIComponent(user.phone)}`);
        const payload = result.success ? result.data : null;
        if (result.success && payload?.success) {
          matchedCustomer = payload.customer;
          if (!matchedCustomer && Array.isArray(payload.customers)) {
            matchedCustomer = payload.customers.find((c: any) => c.id === user.id) || payload.customers[0];
          }
        }
      }

      if (matchedCustomer?.addresses && matchedCustomer.addresses.length > 0) {
        setUserAddresses(matchedCustomer.addresses.map((addr: any) => ({
          id: addr.id,
          customer_id: user.id,
          version: addr.version,
          street_address: addr.street || addr.street_address,
          city: addr.city || '',
          postal_code: addr.postal_code || '',
          floor_number: addr.floor_number,
          address_type: addr.address_type || 'delivery',
          is_default: addr.is_default,
          delivery_notes: addr.delivery_notes || addr.notes,
          latitude: addr.latitude,
          longitude: addr.longitude,
          place_id: addr.place_id || addr.google_place_id,
          formatted_address: addr.formatted_address,
          resolved_street_number: addr.resolved_street_number,
          address_fingerprint: addr.address_fingerprint,
        })));
      } else {
        setUserAddresses([]);
      }
    } catch (error) {
      console.error('Error fetching customer details:', error);
      setUserAddresses([]);
    }
  };

  const handleEditAddress = (address: CustomerAddress) => {
    setEditingAddressId(address.id);
    setEditedAddress({
      street_address: address.street_address,
      city: address.city,
      postal_code: address.postal_code,
      floor_number: address.floor_number,
      address_type: address.address_type,
      is_default: address.is_default,
      delivery_notes: address.delivery_notes,
      latitude: address.latitude,
      longitude: address.longitude,
      place_id: address.place_id,
      formatted_address: address.formatted_address,
      resolved_street_number: address.resolved_street_number,
      address_fingerprint: address.address_fingerprint,
    });
    setAddressSuggestions([]);
    setShowSuggestions(false);
    addressSessionTokenRef.current = null;
  };

  const handleCancelEdit = () => {
    setEditingAddressId(null);
    setEditedAddress({});
    setAddressSuggestions([]);
    setShowSuggestions(false);
    addressSessionTokenRef.current = null;
  };

  const searchAddresses = async (input: string) => {
    if (parseSpecialAddressInput(input).shouldSkipZoneValidation) {
      addressSessionTokenRef.current = null;
      setAddressSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    if (input.length < 3) {
      addressSessionTokenRef.current = null;
      setAddressSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setIsLoadingAddresses(true);
    try {
      if (!addressSessionTokenRef.current) {
        addressSessionTokenRef.current = createAddressSessionToken();
      }

      const result = await posApiFetch<any>('pos/address/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: input.trim(),
          session_token: addressSessionTokenRef.current,
          location: { latitude: 37.9755, longitude: 23.7348 }, // Athens center
          radius: 20000 // 20km radius
        }),
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to search addresses');
      }

      const payload = result.data;
      if (payload?.predictions && Array.isArray(payload.predictions)) {
        setAddressSuggestions(payload.predictions.slice(0, 5));
        setShowSuggestions(true);
      } else {
        setAddressSuggestions([]);
        setShowSuggestions(false);
      }
    } catch (error) {
      console.error('Error searching addresses:', error);
      setAddressSuggestions([]);
      setShowSuggestions(false);
    } finally {
      setIsLoadingAddresses(false);
    }
  };

  const handleAddressSuggestionClick = async (suggestion: any) => {
    try {
      // Get place details to extract postal code and city
      const result = await posApiFetch<any>('pos/address/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          place_id: suggestion.place_id,
          session_token: addressSessionTokenRef.current || undefined,
        }),
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to load place details');
      }

      const payload = result.data;

      if (payload && payload.result) {
        const addressComponents = payload.result.address_components || [];

        // Extract street number and route (street name)
        const streetNumber = addressComponents.find((c: any) => c.types.includes('street_number'))?.long_name || '';
        const route = addressComponents.find((c: any) => c.types.includes('route'))?.long_name || '';
        const streetAddress = `${route} ${streetNumber}`.trim();
        const latitude = payload.result.geometry?.location?.lat;
        const longitude = payload.result.geometry?.location?.lng;
        const formattedAddress = payload.result.formatted_address || suggestion.description;

        // Extract city
        const city = addressComponents.find((c: any) =>
          c.types.includes('locality') || c.types.includes('administrative_area_level_3')
        )?.long_name || '';

        // Extract postal code
        const postalCode = addressComponents.find((c: any) => c.types.includes('postal_code'))?.long_name || '';

        setEditedAddress(prev => ({
          ...prev,
          street_address: streetAddress || suggestion.description,
          city,
          postal_code: postalCode,
          latitude,
          longitude,
          place_id: payload.result.place_id || suggestion.place_id,
          formatted_address: formattedAddress,
          resolved_street_number: streetNumber || undefined,
          address_fingerprint: buildAddressFingerprint(formattedAddress, latitude, longitude),
        }));
      } else {
        // Fallback: use the description
        setEditedAddress(prev => ({
          ...prev,
          street_address: suggestion.description,
          latitude: undefined,
          longitude: undefined,
          place_id: undefined,
          formatted_address: undefined,
          resolved_street_number: undefined,
          address_fingerprint: undefined,
        }));
      }

      setShowSuggestions(false);
      setAddressSuggestions([]);
    } catch (error) {
      console.error('Error getting place details:', error);
      // Fallback: use the description
      setEditedAddress(prev => ({
        ...prev,
        street_address: suggestion.description,
        latitude: undefined,
        longitude: undefined,
        place_id: undefined,
        formatted_address: undefined,
        resolved_street_number: undefined,
        address_fingerprint: undefined,
      }));
      setShowSuggestions(false);
      setAddressSuggestions([]);
    } finally {
      addressSessionTokenRef.current = null;
    }
  };

  const handleSaveAddress = async (addressId: string) => {
    if (!selectedUser) return;

    try {
      // Combine street_address and city into a single address field for the API
      const parsedAddress = parseSpecialAddressInput(editedAddress.street_address || '');
      const isSpecialAddress = parsedAddress.shouldSkipZoneValidation;
      const streetAddress = isSpecialAddress
        ? parsedAddress.normalizedAddress
        : editedAddress.street_address || '';
      const city = isSpecialAddress ? '' : editedAddress.city || '';
      const combinedAddress = isSpecialAddress
        ? streetAddress
        : [streetAddress, city].filter((part) => String(part || '').trim()).join(', ');
      const fallbackFingerprint = buildAddressFingerprint(
        combinedAddress,
        isSpecialAddress ? undefined : editedAddress.latitude,
        isSpecialAddress ? undefined : editedAddress.longitude
      );
      const currentAddress = userAddresses.find((addr) => addr.id === addressId);
      const addressUpdatePayload: any = {
        customer_id: selectedUser.id,
        address: combinedAddress,
        street_address: streetAddress || combinedAddress,
        city,
        postal_code: editedAddress.postal_code,
        floor_number: editedAddress.floor_number,
        address_type: editedAddress.address_type || 'delivery',
        is_default: editedAddress.is_default || false,
        notes: editedAddress.delivery_notes,
        coordinates: isSpecialAddress ? null : undefined,
        latitude: isSpecialAddress ? null : editedAddress.latitude,
        longitude: isSpecialAddress ? null : editedAddress.longitude,
        place_id: isSpecialAddress ? null : editedAddress.place_id,
        formatted_address: isSpecialAddress ? combinedAddress : editedAddress.formatted_address || combinedAddress,
        resolved_street_number: isSpecialAddress ? null : editedAddress.resolved_street_number,
        address_fingerprint: editedAddress.address_fingerprint || fallbackFingerprint,
      };
      const result: any = await bridge.customers.updateAddress(
        addressId,
        addressUpdatePayload,
        currentAddress?.version || 0,
      );

      if (result?.success !== false) {
        toast.success(
          result?.queued
            ? t('users.savedLocallyQueued', 'Saved locally and queued for sync')
            : t('users.updateAddressSuccess', 'Address updated successfully'),
        );

        // Update local state with the returned address data
        setUserAddresses(prev => prev.map(addr =>
          addr.id === addressId
            ? {
                ...addr,
                version: result?.data?.version ?? addr.version,
                street_address: editedAddress.street_address || addr.street_address,
                city: isSpecialAddress ? '' : editedAddress.city || addr.city,
                postal_code: editedAddress.postal_code || addr.postal_code,
                floor_number: editedAddress.floor_number || addr.floor_number,
                delivery_notes: editedAddress.delivery_notes || addr.delivery_notes,
                address_type: editedAddress.address_type || addr.address_type,
                is_default: editedAddress.is_default !== undefined ? editedAddress.is_default : addr.is_default,
                latitude: isSpecialAddress ? undefined : editedAddress.latitude ?? addr.latitude,
                longitude: isSpecialAddress ? undefined : editedAddress.longitude ?? addr.longitude,
                place_id: isSpecialAddress ? undefined : editedAddress.place_id || addr.place_id,
                formatted_address: isSpecialAddress ? combinedAddress : editedAddress.formatted_address || combinedAddress || addr.formatted_address,
                resolved_street_number: isSpecialAddress ? undefined : editedAddress.resolved_street_number || addr.resolved_street_number,
                address_fingerprint: editedAddress.address_fingerprint || fallbackFingerprint || addr.address_fingerprint,
              }
            : addr
        ));

        setEditingAddressId(null);
        setEditedAddress({});
        addressSessionTokenRef.current = null;
      } else {
        throw new Error(result?.error || 'Failed to update address');
      }
    } catch (error) {
      console.error('Error updating address:', error);
      toast.error(t('users.updateAddressError', 'Failed to update address'));
    }
  };

  const handleDeleteAddress = (addressId: string) => {
    if (!selectedUser) return;
    // Open an app-level confirmation modal instead of a native browser dialog.
    setAddressPendingDelete(addressId);
  };

  const confirmDeleteAddress = async () => {
    if (!selectedUser || !addressPendingDelete) return;
    const addressId = addressPendingDelete;
    setAddressPendingDelete(null);

    try {
      const result = await bridge.customers.deleteAddress(selectedUser.id, addressId);

      if (result?.success === false) {
        throw new Error(result.error || 'Failed to delete address');
      }

      toast.success(
        result?.queued
          ? t('users.deleteAddressQueued', 'Address deleted and queued for sync')
          : t('users.deleteAddressSuccess', 'Address deleted successfully'),
      );
      setUserAddresses(prev => prev.filter(addr => addr.id !== addressId));
    } catch (error) {
      console.error('Error deleting address:', error);
      toast.error(t('users.deleteAddressError', 'Failed to delete address'));
    }
  };

  const handleToggleBan = async (userId: string, currentBanStatus: boolean) => {
    const originalUsers = users;
    setUpdatingUserId(userId);

    try {
      // Optimistically update UI
      setUsers(prev => prev.map(user =>
        user.id === userId ? { ...user, is_banned: !currentBanStatus } : user
      ));

      // Update in Supabase via customer:update-ban-status
      const newBanStatus = !currentBanStatus;
      const result = await bridge.customers.updateBanStatus(userId, newBanStatus);

      console.log('Ban status update result:', result);

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to update ban status');
      }

      toast.success(currentBanStatus ? t('users.unbanned') || 'Customer unbanned' : t('users.banned') || 'Customer banned');
    } catch (error) {
      console.error('Error updating ban status:', error);
      toast.error(t('users.banError') || 'Failed to update ban status');
      setUsers(originalUsers);
    } finally {
      setUpdatingUserId(null);
    }
  };

  const getLoyaltyBadge = (points: number) => {
    const tierKey = getLoyaltyTierKey(points);
    const color =
      tierKey === 'platinum'
        ? 'text-amber-500 dark:text-amber-300'
        : tierKey === 'gold'
          ? 'text-yellow-500 dark:text-yellow-400'
          : tierKey === 'silver'
            ? 'text-zinc-500 dark:text-zinc-300'
            : 'text-orange-700 dark:text-orange-500';

    const tierLabel = t(`users.loyaltyTier.${tierKey}`, tierKey.charAt(0).toUpperCase() + tierKey.slice(1));

    return (
      <span className={`inline-flex items-center text-xs font-medium ${color}`}>
        <Star className="w-3 h-3 mr-1" />
        {tierLabel}
      </span>
    );
  };

  const filtersActive = hasActiveUserDirectoryFilters({ status: statusFilter, loyalty: loyaltyFilter });

  const filteredUsers = useMemo(
    () =>
      users.filter(user =>
        matchesUserDirectoryFilters(user, {
          search: searchTerm,
          status: statusFilter,
          loyalty: loyaltyFilter,
        }),
      ),
    [searchTerm, statusFilter, loyaltyFilter, users],
  );

  // Reset to the first page whenever the visible result set can change.
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, loyaltyFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const pageStart = filteredUsers.length === 0 ? 0 : (activePage - 1) * USERS_PAGE_SIZE + 1;
  const pageEnd = Math.min(activePage * USERS_PAGE_SIZE, filteredUsers.length);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedUsers = useMemo(() => {
    const start = (activePage - 1) * USERS_PAGE_SIZE;
    return filteredUsers.slice(start, start + USERS_PAGE_SIZE);
  }, [activePage, filteredUsers]);

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="p-6">
      {/* Header */}
      <motion.div variants={pageMotionItem} className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className={`truncate text-3xl font-bold tracking-tight ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {t('users.title') || 'Users Management'}
            </h1>
            <p className={`mt-1 truncate text-sm ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
              {t('users.description') || 'View and manage customer accounts'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadUsers()}
            disabled={loading}
            aria-label={t('common.refresh', 'Refresh')}
            className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all ${
              resolvedTheme === 'dark'
                ? 'border border-amber-400/30 bg-amber-500/15 text-amber-300 active:bg-amber-500/25'
                : 'border border-amber-400/40 bg-amber-50 text-amber-600 active:bg-amber-100'
            } ${loading ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.div>

      {/* Search & Filters */}
      <motion.div variants={pageMotionItem} className={`mb-6 p-4 rounded-xl ${
        resolvedTheme === 'dark' ? 'bg-zinc-900/70' : 'bg-gray-100'
      }`}>
        <div className="flex items-center">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <input
              type="text"
              placeholder={t('users.searchPlaceholder') || 'Search by name, email, or phone...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={`w-full pl-10 pr-12 py-2 rounded-2xl ${
                resolvedTheme === 'dark'
                  ? 'bg-zinc-800 text-white border-zinc-600 focus:ring-white/40 focus:border-white/70'
                  : 'bg-white text-gray-900 border-gray-300 focus:ring-gray-400 focus:border-gray-500'
              } border focus:ring-2`}
            />
            <button
              type="button"
              onClick={() => setShowFilterMenu(open => !open)}
              aria-label={t('users.filters.openLabel', 'Filter users')}
              aria-haspopup="menu"
              aria-expanded={showFilterMenu}
              className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-2xl p-1.5 transition-transform active:scale-95 ${
                filtersActive
                  ? 'text-yellow-500'
                  : resolvedTheme === 'dark'
                    ? 'text-zinc-400 active:bg-white/10'
                    : 'text-gray-500 active:bg-gray-200'
              }`}
            >
              <Filter className="h-5 w-5" />
              {filtersActive && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-yellow-500" aria-hidden="true" />
              )}
            </button>
            {showFilterMenu && (
              <>
                <div className="fixed inset-0 z-[1190]" onClick={() => setShowFilterMenu(false)} aria-hidden="true" />
                <div
                  role="menu"
                  className={`absolute right-0 top-full z-[1200] mt-2 flex max-h-[calc(100vh-28rem)] min-h-[12rem] w-64 flex-col rounded-2xl border p-3 shadow-2xl ${
                    resolvedTheme === 'dark'
                      ? 'bg-zinc-900 border-zinc-700 text-white'
                      : 'bg-white border-gray-200 text-gray-900'
                  }`}
                >
                  <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
                  <p className={`mb-1.5 text-xs font-semibold uppercase tracking-wider ${resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-gray-500'}`}>
                    {t('users.filters.statusLabel', 'Status')}
                  </p>
                  <div className="mb-3 flex flex-col gap-1">
                    {USER_STATUS_FILTERS.map(option => (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={statusFilter === option}
                        onClick={() => setStatusFilter(option)}
                        className={`rounded-2xl px-3 py-1.5 text-left text-sm transition-transform active:scale-[0.98] ${
                          statusFilter === option
                            ? 'bg-yellow-400 text-black'
                            : resolvedTheme === 'dark'
                              ? 'text-zinc-200 active:bg-white/10'
                              : 'text-gray-700 active:bg-gray-100'
                        }`}
                      >
                        {t(`users.filters.status.${option}`, option.charAt(0).toUpperCase() + option.slice(1))}
                      </button>
                    ))}
                  </div>
                  <p className={`mb-1.5 text-xs font-semibold uppercase tracking-wider ${resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-gray-500'}`}>
                    {t('users.filters.loyaltyLabel', 'Loyalty tier')}
                  </p>
                  <div className="flex flex-col gap-1">
                    {USER_LOYALTY_FILTERS.map(option => (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={loyaltyFilter === option}
                        onClick={() => setLoyaltyFilter(option)}
                        className={`rounded-2xl px-3 py-1.5 text-left text-sm transition-transform active:scale-[0.98] ${
                          loyaltyFilter === option
                            ? 'bg-yellow-400 text-black'
                            : resolvedTheme === 'dark'
                              ? 'text-zinc-200 active:bg-white/10'
                              : 'text-gray-700 active:bg-gray-100'
                        }`}
                      >
                        {option === 'all'
                          ? t('users.filters.loyalty.all', 'All tiers')
                          : t(`users.loyaltyTier.${option}`, option.charAt(0).toUpperCase() + option.slice(1))}
                      </button>
                    ))}
                  </div>
                  </div>
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={() => { setStatusFilter('all'); setLoyaltyFilter('all'); }}
                      className={`mt-3 shrink-0 w-full rounded-2xl border px-3 py-1.5 text-sm font-medium transition-transform active:scale-[0.98] ${
                        resolvedTheme === 'dark'
                          ? 'border-zinc-700 text-zinc-200 active:bg-white/10'
                          : 'border-gray-200 text-gray-700 active:bg-gray-100'
                      }`}
                    >
                      {t('users.filters.clear', 'Clear filters')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </motion.div>

      {/* Users Table */}
      <motion.div variants={pageMotionItem} className={`rounded-xl overflow-hidden ${
        resolvedTheme === 'dark' ? 'bg-zinc-950' : 'bg-gray-100'
      }`}>
        {loading ? (
          <div className="p-12 text-center">
            <RefreshCw className="w-8 h-8 mx-auto mb-4 animate-spin text-yellow-500" />
            <p className={resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}>
              {t('common.loading') || 'Loading...'}
            </p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="w-12 h-12 mx-auto mb-4 text-gray-400" />
            <h3 className={`text-lg font-medium mb-2 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {t('users.noUsers') || 'No users found'}
            </h3>
            <p className={resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}>
              {searchTerm || filtersActive
                ? t('users.noMatches') || 'No users match your search or filters'
                : t('users.noUsersYet') || 'No users yet'}
            </p>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-yellow-400">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.customer') || 'Customer'}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.contact') || 'Contact'}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.activity') || 'Activity'}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.loyalty') || 'Loyalty'}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.status') || 'Status'}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-black">
                    {t('users.actions') || 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody className={`divide-y ${resolvedTheme === 'dark' ? 'divide-zinc-700' : 'divide-gray-300'}`}>
                {paginatedUsers.map((user) => (
                  <motion.tr
                    key={user.id}
                    variants={pageMotionItem}
                    className={`transition-colors ${
                      resolvedTheme === 'dark' ? 'active:bg-zinc-900' : 'active:bg-gray-200'
                    } ${updatingUserId === user.id ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                          resolvedTheme === 'dark' ? 'bg-zinc-700' : 'bg-gray-300'
                        }`}>
                          <span className={`text-sm font-medium ${
                            resolvedTheme === 'dark' ? 'text-zinc-300' : 'text-gray-700'
                          }`}>
                            {user.name?.split(' ').map(n => n[0]).join('') || 'U'}
                          </span>
                        </div>
                        <div className="ml-4">
                          <div className={`text-sm font-medium ${
                            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                          }`}>
                            {user.name || t('users.unnamed', 'Unnamed User')}
                          </div>
                          <div className={`text-sm ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            {user.type === 'app_user' ? t('users.filterAppUsers', 'App User') : t('users.customer', 'Customer')}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="space-y-1">
                        {user.email && (
                          <div className={`flex items-center text-sm ${
                            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                          }`}>
                            <Mail className="w-4 h-4 mr-2 text-yellow-500" />
                            {user.email}
                          </div>
                        )}
                        {user.phone && (
                          <div className={`flex items-center text-sm ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            <Phone className="w-4 h-4 mr-2 text-yellow-500" />
                            {user.phone}
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="space-y-1">
                        <div className={`flex items-center text-sm ${
                          resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                        }`}>
                          <ShoppingBag className="w-4 h-4 mr-2 text-green-500" />
                          {user.total_orders} {t('users.orders') || 'orders'}
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="space-y-2">
                        {getLoyaltyBadge(user.loyalty_points)}
                        <div className={`text-xs ${
                          resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                        }`}>
                          {user.loyalty_points} {t('users.points') || 'points'}
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="space-y-2">
                        {user.is_banned ? (
                          <span className="inline-flex items-center text-xs font-medium text-red-500 dark:text-red-400">
                            <Ban className="w-3 h-3 mr-1" />
                            {t('users.banned') || 'Banned'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center text-xs font-medium text-green-500 dark:text-green-400">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            {t('users.active') || 'Active'}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleViewUser(user)}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-amber-500 transition-transform active:scale-[0.96] active:bg-amber-500/10"
                          aria-label={t('users.viewDetails') || 'View details'}
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                        {user.type !== 'app_user' && (
                          <button
                            onClick={() => handleToggleBan(user.id, user.is_banned || false)}
                            className={`inline-flex h-10 w-10 items-center justify-center rounded-xl transition-transform active:scale-[0.96] ${
                              user.is_banned
                                ? 'text-green-600 dark:text-green-400 active:bg-green-500/10'
                                : 'text-red-600 dark:text-red-400 active:bg-red-500/10'
                            }`}
                            aria-label={user.is_banned ? t('users.unban') || 'Unban' : t('users.ban') || 'Ban'}
                          >
                            {user.is_banned ? <CheckCircle className="w-5 h-5" /> : <Ban className="w-5 h-5" />}
                          </button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`flex flex-col gap-3 border-t px-6 py-4 text-sm md:flex-row md:items-center md:justify-between ${
            resolvedTheme === 'dark' ? 'border-zinc-700 text-zinc-300' : 'border-gray-300 text-gray-700'
          }`}>
            <span>
              {pageStart}-{pageEnd} of {filteredUsers.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                disabled={activePage === 1}
                className={`rounded-2xl border px-3 py-2 font-medium transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                  resolvedTheme === 'dark'
                    ? 'border-yellow-500 text-yellow-400 active:bg-yellow-400 active:text-black'
                    : 'border-yellow-500 text-yellow-700 active:bg-yellow-400 active:text-black'
                }`}
              >
                {t('users.pagination.previous', 'Previous')}
              </button>
              <span className={resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-gray-600'}>
                {t('users.pagination.pageOf', 'Page {{current}} of {{total}}', { current: activePage, total: totalPages })}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={activePage === totalPages}
                className={`rounded-2xl border px-3 py-2 font-medium transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                  resolvedTheme === 'dark'
                    ? 'border-yellow-500 text-yellow-400 active:bg-yellow-400 active:text-black'
                    : 'border-yellow-500 text-yellow-700 active:bg-yellow-400 active:text-black'
                }`}
              >
                {t('users.pagination.next', 'Next')}
              </button>
            </div>
          </div>
          </>
        )}
      </motion.div>

      {/* User Details Modal */}
      {showDetailsModal && selectedUser && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div
            ref={detailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={detailsTitleId}
            className={`max-w-2xl w-full rounded-3xl overflow-hidden border shadow-2xl backdrop-blur-2xl ${
            resolvedTheme === 'dark' ? 'bg-gray-900/70 border-white/10' : 'bg-white/75 border-white/50'
          }`}>
            <div className={`px-6 py-4 border-b ${
              resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
            }`}>
              <h3 id={detailsTitleId} className={`text-xl font-semibold ${
                resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
              }`}>
                {t('users.customerDetails') || 'Customer Details'}
              </h3>
            </div>

            <div className="p-6 space-y-6">
              {/* Basic Info */}
              <div>
                <h4 className={`text-sm font-medium mb-3 ${
                  resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {t('users.basicInfo') || 'Basic Information'}
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {t('users.name') || 'Name'}
                    </p>
                    <p className={`text-sm font-medium ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                      {selectedUser.name}
                    </p>
                  </div>
                  <div>
                    <p className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {t('users.phone') || 'Phone'}
                    </p>
                    <p className={`text-sm font-medium ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                      {selectedUser.phone || 'N/A'}
                    </p>
                  </div>
                  <div>
                    <p className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {t('users.email') || 'Email'}
                    </p>
                    <p className={`text-sm font-medium ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                      {selectedUser.email || 'N/A'}
                    </p>
                  </div>
                  <div>
                    <p className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {t('users.status') || 'Status'}
                    </p>
                    <p className={`text-sm font-medium ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                      {selectedUser.is_banned ? (
                        <span className="text-red-600 dark:text-red-400">{t('users.banned') || 'Banned'}</span>
                      ) : (
                        <span className="text-green-600 dark:text-green-400">{t('users.active') || 'Active'}</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Addresses */}
              {userAddresses.length > 0 && (
                <div>
                  <h4 className={`text-sm font-medium mb-3 ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.addresses') || 'Addresses'} ({userAddresses.length})
                  </h4>
                  <div className="space-y-3">
                    {userAddresses.map((address) => (
                      <div
                        key={address.id}
                        className={`p-4 rounded-2xl border ${
                          resolvedTheme === 'dark'
                            ? 'bg-gray-700/50 border-gray-600'
                            : 'bg-gray-50 border-gray-200'
                        }`}
                      >
                        {editingAddressId === address.id ? (
                          // Edit Mode
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="relative">
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  {t('users.address.street', 'Street Address')}
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.street_address || ''}
                                  onChange={(e) => {
                                    const streetAddress = e.target.value;
                                    setEditedAddress(prev => ({
                                      ...prev,
                                      street_address: streetAddress,
                                      latitude: undefined,
                                      longitude: undefined,
                                      place_id: undefined,
                                      formatted_address: undefined,
                                      resolved_street_number: undefined,
                                      address_fingerprint: undefined,
                                    }));
                                    searchAddresses(e.target.value);
                                  }}
                                  onFocus={() => {
                                    if (addressSuggestions.length > 0) {
                                      setShowSuggestions(true);
                                    }
                                  }}
                                  className={`w-full px-3 py-2 rounded-2xl text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-yellow-500`}
                                  placeholder={t('modals.addNewAddress.addressPlaceholder')}
                                />

                                {/* Address Suggestions Dropdown */}
                                {showSuggestions && addressSuggestions.length > 0 && (
                                  <div className={`absolute z-50 w-full mt-1 rounded-2xl shadow-lg max-h-60 overflow-y-auto scrollbar-hide ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 border-gray-600'
                                      : 'bg-white border-gray-200'
                                  } border`}>
                                    {addressSuggestions.map((suggestion, index) => (
                                      <button
                                        key={index}
                                        type="button"
                                        onClick={() => handleAddressSuggestionClick(suggestion)}
                                        className={`w-full px-3 py-2 text-left text-sm active:bg-yellow-500/10 transition-transform active:scale-[0.99] border-b last:border-b-0 ${
                                          resolvedTheme === 'dark'
                                            ? 'border-gray-700 text-white'
                                            : 'border-gray-100 text-gray-900'
                                        }`}
                                      >
                                        <div className="flex items-start gap-2">
                                          <MapPin className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                                          <div className="flex-1 min-w-0">
                                            <p className="font-medium truncate">
                                              {suggestion.structured_formatting?.main_text || suggestion.description}
                                            </p>
                                            <p className={`text-xs truncate ${
                                              resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                                            }`}>
                                              {suggestion.structured_formatting?.secondary_text || suggestion.description}
                                            </p>
                                          </div>
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div>
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  {t('users.address.city', 'City')}
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.city || ''}
                                  onChange={(e) => setEditedAddress(prev => ({
                                    ...prev,
                                    city: e.target.value,
                                    latitude: undefined,
                                    longitude: undefined,
                                    place_id: undefined,
                                    formatted_address: undefined,
                                    resolved_street_number: undefined,
                                    address_fingerprint: undefined,
                                  }))}
                                  className={`w-full px-3 py-2 rounded-2xl text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-yellow-500`}
                                />
                              </div>
                              <div>
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  {t('users.address.postalCode', 'Postal Code')}
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.postal_code || ''}
                                  onChange={(e) => setEditedAddress(prev => ({
                                    ...prev,
                                    postal_code: e.target.value,
                                    latitude: undefined,
                                    longitude: undefined,
                                    place_id: undefined,
                                    formatted_address: undefined,
                                    resolved_street_number: undefined,
                                    address_fingerprint: undefined,
                                  }))}
                                  className={`w-full px-3 py-2 rounded-2xl text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-yellow-500`}
                                />
                              </div>
                              <div>
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  {t('users.address.floor', 'Floor Number')}
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.floor_number || ''}
                                  onChange={(e) => setEditedAddress({ ...editedAddress, floor_number: e.target.value })}
                                  className={`w-full px-3 py-2 rounded-2xl text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-yellow-500`}
                                />
                              </div>
                            </div>
                            <div>
                              <label className={`text-xs font-medium ${
                                resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                              }`}>
                                {t('users.address.deliveryNotes', 'Delivery Notes')}
                              </label>
                              <textarea
                                value={editedAddress.delivery_notes || ''}
                                onChange={(e) => setEditedAddress({ ...editedAddress, delivery_notes: e.target.value })}
                                rows={2}
                                className={`w-full px-3 py-2 rounded-2xl text-sm ${
                                  resolvedTheme === 'dark'
                                    ? 'bg-gray-800 text-white border-gray-600'
                                    : 'bg-white text-gray-900 border-gray-300'
                                } border focus:outline-none focus:ring-2 focus:ring-yellow-500`}
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleSaveAddress(address.id)}
                                className="liquid-glass-modal-button liquid-glass-modal-success rounded-xl text-sm disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
                              >
                                <Save className="w-4 h-4" />
                                {t('common.actions.save', 'Save')}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300 active:bg-red-500/20 active:scale-[0.98] transition-all"
                              >
                                <X className="w-4 h-4" />
                                {t('common.actions.cancel', 'Cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          // View Mode
                          <div className="flex items-start gap-2">
                            <MapPin className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-medium ${
                                resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                              }`}>
                                {address.street_address}, {address.city}
                              </p>
                              <p className={`text-xs ${
                                resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                              }`}>
                                {address.postal_code}
                                {address.floor_number && ` • ${t('users.address.floor', 'Floor')} ${address.floor_number}`}
                                {address.is_default && ` • ${t('users.address.default', 'Default')}`}
                              </p>
                              {address.delivery_notes && (
                                <p className={`text-xs mt-1 ${
                                  resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                                }`}>
                                  {address.delivery_notes}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button
                                onClick={() => handleEditAddress(address)}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-amber-500 active:bg-amber-500/10 active:scale-[0.96] transition-transform"
                                aria-label={t('customer.actions.editAddress')}
                              >
                                <Edit3 className="w-5 h-5" />
                              </button>
                              <button
                                onClick={() => handleDeleteAddress(address.id)}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-red-600 dark:text-red-400 active:bg-red-500/10 active:scale-[0.96] transition-transform"
                                aria-label={t('customer.actions.deleteAddress')}
                              >
                                <Trash2 className="w-5 h-5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              {selectedUser.notes && (
                <div>
                  <h4 className={`text-sm font-medium mb-2 ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.notes') || 'Notes'}
                  </h4>
                  <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                    {selectedUser.notes}
                  </p>
                </div>
              )}
            </div>

            <div className={`px-6 py-4 border-t ${
              resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
            } flex justify-between items-center`}>
              {selectedUser.type !== 'app_user' && (
                <button
                  onClick={() => {
                    handleToggleBan(selectedUser.id, selectedUser.is_banned || false);
                    setShowDetailsModal(false);
                    setSelectedUser(null);
                    setUserAddresses([]);
                  }}
                  disabled={updatingUserId === selectedUser.id}
                  className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl transition-all active:scale-[0.98] ${
                    selectedUser.is_banned
                      ? 'bg-green-600 active:bg-green-700 text-white'
                      : 'bg-red-600 active:bg-red-700 text-white'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {selectedUser.is_banned ? (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      {t('users.unban') || 'Unban Customer'}
                    </>
                  ) : (
                    <>
                      <Ban className="w-4 h-4" />
                      {t('users.ban') || 'Ban Customer'}
                    </>
                  )}
                </button>
              )}
              <button
                onClick={closeDetailsModal}
                className={`px-4 py-2 rounded-xl transition-all active:scale-[0.98] ${
                  resolvedTheme === 'dark'
                    ? 'bg-white/10 active:bg-white/15 text-white'
                    : 'bg-black/5 active:bg-black/10 text-gray-900'
                }`}
              >
                {t('common.actions.close') || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {addressPendingDelete && renderModalPortal(
        <div
          className="fixed inset-0 z-[1300] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => setAddressPendingDelete(null)}
        >
          <div
            ref={deleteAddressDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={deleteAddressTitleId}
            className={`w-full max-w-sm rounded-3xl overflow-hidden border shadow-2xl backdrop-blur-2xl ${resolvedTheme === 'dark' ? 'bg-gray-900/70 border-white/10' : 'bg-white/75 border-white/50'}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={`px-6 py-4 border-b ${resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
              <h3 id={deleteAddressTitleId} className={`text-lg font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                {t('users.deleteAddressTitle', 'Delete address')}
              </h3>
            </div>
            <div className={`px-6 py-4 text-sm ${resolvedTheme === 'dark' ? 'text-zinc-300' : 'text-gray-600'}`}>
              {t('users.confirmDeleteAddress', 'Are you sure you want to delete this address?')}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4">
              <button
                type="button"
                onClick={() => setAddressPendingDelete(null)}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all active:scale-[0.98] ${resolvedTheme === 'dark' ? 'border-white/15 bg-white/5 text-zinc-200 active:bg-white/10' : 'border-black/10 bg-black/5 text-gray-700 active:bg-black/10'}`}
              >
                {t('common.actions.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteAddress()}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white active:bg-red-700 active:scale-[0.98] transition-all"
              >
                {t('common.actions.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default UsersPage;

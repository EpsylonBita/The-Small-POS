import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { posApiFetch, posApiGet } from '../utils/api-helpers';
import { renderModalPortal } from '../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import { useModuleAccess } from '../contexts/module-context';
import { extractSavedAddressCoordinates } from '../utils/saved-address-geolocation';
import { toValidLatLng } from '../utils/coordinates';
import toast from 'react-hot-toast';
import { getBridge, offEvent, onEvent } from '../../lib';
import { parseSpecialAddressInput } from '../utils/specialAddress';
import {
  customerAddressWriteErrorText,
  expectCustomerAddressWrite,
} from '../utils/customer-address-write-refusal';
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
  User,
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
  RefreshCw,
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
  coordinate_source?: string | null;
  geocoded_at?: string | null;
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

const UsersPage: React.FC<{ initialSearchTerm?: string }> = ({
  initialSearchTerm = '',
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const hasDeliveryModule = useModuleAccess('delivery').isEnabled;
  const hasDeliveryZonesModule = useModuleAccess('delivery_zones').isEnabled;
  const hasDeliveryPro = hasDeliveryModule && hasDeliveryZonesModule;
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);
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
  const addressSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressGeneration = useRef(0);
  const customerDetailsGeneration = useRef(0);
  const mounted = useRef(true);
  const addressScope = useRef('');
  addressScope.current = JSON.stringify([selectedUser?.id, editingAddressId, showDetailsModal, hasDeliveryPro]);

  // Every text/lifecycle change invalidates autocomplete and details together.
  const invalidateAddressSearch = useCallback((resetSession = false) => {
    const generation = ++addressGeneration.current;
    if (addressSearchTimer.current) clearTimeout(addressSearchTimer.current);
    addressSearchTimer.current = null;
    setAddressSuggestions([]);
    setShowSuggestions(false);
    setIsLoadingAddresses(false);
    if (resetSession) addressSessionTokenRef.current = null;
    return generation;
  }, []);

  useEffect(() => {
    invalidateAddressSearch(true);
  }, [editingAddressId, selectedUser?.id, showDetailsModal, hasDeliveryPro, invalidateAddressSearch]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++addressGeneration.current;
      ++customerDetailsGeneration.current;
      if (addressSearchTimer.current) clearTimeout(addressSearchTimer.current);
      addressSessionTokenRef.current = null;
    };
  }, []);


  useEffect(() => {
    setSearchTerm(initialSearchTerm);
    setCurrentPage(1);
  }, [initialSearchTerm]);

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
    ++customerDetailsGeneration.current;
    invalidateAddressSearch(true);
    setEditingAddressId(null);
    setEditedAddress({});
  }, [invalidateAddressSearch]);

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
    const generation = ++customerDetailsGeneration.current;
    const isCurrent = () => mounted.current && generation === customerDetailsGeneration.current;
    invalidateAddressSearch(true);
    setEditingAddressId(null);
    setEditedAddress({});
    setUserAddresses([]);
    setSelectedUser(user);
    setShowDetailsModal(true);

    try {
      let matchedCustomer: any = await bridge.customers.lookupById(user.id);

      if (!isCurrent()) return;
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

      if (!isCurrent()) return;
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
          latitude: extractSavedAddressCoordinates(addr)?.lat,
          longitude: extractSavedAddressCoordinates(addr)?.lng,
          place_id: addr.place_id || addr.google_place_id,
          formatted_address: addr.formatted_address,
          resolved_street_number: addr.resolved_street_number,
          address_fingerprint: addr.address_fingerprint,
          coordinate_source: addr.coordinate_source,
          geocoded_at: addr.geocoded_at,
        })));
      } else {
        setUserAddresses([]);
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error fetching customer details:', error);
      setUserAddresses([]);
    }
  };

  const handleEditAddress = (address: CustomerAddress) => {
    invalidateAddressSearch(true);
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
      coordinate_source: address.coordinate_source,
      geocoded_at: address.geocoded_at,
    });
    setAddressSuggestions([]);
    setShowSuggestions(false);
    addressSessionTokenRef.current = null;
  };

  const handleCancelEdit = () => {
    invalidateAddressSearch(true);
    setEditingAddressId(null);
    setEditedAddress({});
    setAddressSuggestions([]);
    setShowSuggestions(false);
    addressSessionTokenRef.current = null;
  };

  const searchAddresses = async (input: string, generation: number, scope: string) => {
    const isCurrent = () => mounted.current && generation === addressGeneration.current
      && scope === addressScope.current;
    if (!isCurrent()) return;
    const query = input.trim();
    if (query.length < 3 || parseSpecialAddressInput(query).shouldSkipZoneValidation) {
      addressSessionTokenRef.current = null;
      return;
    }

    const savedMatches = userAddresses.filter(address =>
      address.street_address.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())
    ).slice(0, 5);
    if (savedMatches.length > 0 || !hasDeliveryPro) {
      setAddressSuggestions(savedMatches.map(address => ({
        description: [address.street_address, address.city].filter(Boolean).join(', '),
        source: 'saved',
        savedAddress: address,
      })));
      setShowSuggestions(savedMatches.length > 0);
      return;
    }

    setIsLoadingAddresses(true);
    try {
      if (!addressSessionTokenRef.current) addressSessionTokenRef.current = createAddressSessionToken();
      const result = await posApiFetch<any>('pos/address/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, session_token: addressSessionTokenRef.current }),
      });
      if (!isCurrent()) return;
      if (!result.success) throw new Error(result.error || 'Failed to search addresses');
      const predictions = Array.isArray(result.data?.predictions) ? result.data.predictions.slice(0, 5) : [];
      setAddressSuggestions(predictions);
      setShowSuggestions(predictions.length > 0);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error searching addresses:', error);
      setAddressSuggestions([]);
      setShowSuggestions(false);
    } finally {
      if (isCurrent()) setIsLoadingAddresses(false);
    }
  };

  const queueAddressSearch = (input: string) => {
    const generation = invalidateAddressSearch();
    const scope = addressScope.current;
    if (input.trim().length < 3 || parseSpecialAddressInput(input).shouldSkipZoneValidation) {
      addressSessionTokenRef.current = null;
      return;
    }
    addressSearchTimer.current = setTimeout(() => {
      addressSearchTimer.current = null;
      void searchAddresses(input, generation, scope);
    }, 350);
  };

  const handleAddressTextChange = (field: 'street_address' | 'city' | 'postal_code', value: string) => {
    if (field === 'street_address') queueAddressSearch(value);
    else invalidateAddressSearch();
    setEditedAddress(prev => ({
      ...prev,
      [field]: value,
      latitude: undefined,
      longitude: undefined,
      place_id: undefined,
      formatted_address: undefined,
      resolved_street_number: undefined,
      address_fingerprint: undefined,
      coordinate_source: undefined,
      geocoded_at: undefined,
    }));
  };

  const handleAddressSuggestionClick = async (suggestion: any) => {
    const generation = invalidateAddressSearch();
    const scope = addressScope.current;
    const isCurrent = () => mounted.current && generation === addressGeneration.current
      && scope === addressScope.current;
    if (suggestion.source === 'saved') {
      const saved = suggestion.savedAddress as CustomerAddress;
      const point = extractSavedAddressCoordinates(saved);
      // Copy location only: the edited row keeps its own floor/default/notes and identity.
      setEditedAddress(prev => ({
        ...prev,
        street_address: saved.street_address,
        city: saved.city,
        postal_code: saved.postal_code,
        latitude: point?.lat,
        longitude: point?.lng,
        place_id: saved.place_id,
        formatted_address: saved.formatted_address,
        resolved_street_number: saved.resolved_street_number,
        address_fingerprint: saved.address_fingerprint,
        coordinate_source: saved.coordinate_source,
        geocoded_at: saved.geocoded_at,
      }));
      addressSessionTokenRef.current = null;
      return;
    }
    if (!hasDeliveryPro) return;
    const sessionToken = addressSessionTokenRef.current;
    addressSessionTokenRef.current = null;
    const applyDescription = () => setEditedAddress(prev => ({
      ...prev,
      street_address: suggestion.description,
      latitude: undefined,
      longitude: undefined,
      place_id: undefined,
      formatted_address: undefined,
      resolved_street_number: undefined,
      address_fingerprint: undefined,
      coordinate_source: undefined,
      geocoded_at: undefined,
    }));
    try {
      const result = await posApiFetch<any>('pos/address/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ place_id: suggestion.place_id, session_token: sessionToken || undefined }),
      });
      if (!isCurrent()) return;
      if (!result.success) throw new Error(result.error || 'Failed to load place details');
      const details = result.data?.result;
      if (details) {
        const components = details.address_components || [];
        const streetNumber = components.find((c: any) => c.types.includes('street_number'))?.long_name || '';
        const route = components.find((c: any) => c.types.includes('route'))?.long_name || '';
        const streetAddress = `${route} ${streetNumber}`.trim() || suggestion.description;
        const point = toValidLatLng(details.geometry?.location);
        const formattedAddress = details.formatted_address || suggestion.description;
        const city = components.find((c: any) => c.types.includes('locality') || c.types.includes('administrative_area_level_3'))?.long_name;
        const postalCode = components.find((c: any) => c.types.includes('postal_code'))?.long_name;
        setEditedAddress(prev => ({
          ...prev,
          street_address: streetAddress,
          city: city || prev.city,
          postal_code: postalCode || prev.postal_code,
          latitude: point?.lat,
          longitude: point?.lng,
          place_id: details.place_id || suggestion.place_id,
          formatted_address: formattedAddress,
          resolved_street_number: streetNumber || undefined,
          address_fingerprint: buildAddressFingerprint(formattedAddress, point?.lat, point?.lng),
          coordinate_source: point ? 'google' : undefined,
          geocoded_at: point ? new Date().toISOString() : undefined,
        }));
      } else applyDescription();
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error getting place details:', error);
      applyDescription();
    } finally {
      if (isCurrent()) addressSessionTokenRef.current = null;
    }
  };

  const handleSaveAddress = async (addressId: string) => {
    if (!selectedUser) return;
    const generation = invalidateAddressSearch(true);
    const scope = addressScope.current;
    const customerGeneration = customerDetailsGeneration.current;

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
      // A changed destination (street, city or postal code differ from the
      // saved row) owns its whole point: an unknown point or place id is sent
      // as an explicit null, so the native save, its offline cache merge and
      // the queued PATCH clear the stored pin and the next order's delivery
      // zone and fee are recomputed. `undefined` vanishes from the IPC payload
      // and reads as "unchanged" — desktop 1.4.123 kept the old pin for a text
      // edit saved offline. An unchanged destination (floor, notes, default, or
      // the original text typed back) still omits an unknown point.
      const sameText = (left: unknown, right: unknown) =>
        String(left ?? '').trim() === String(right ?? '').trim();
      const destinationChanged = !currentAddress
        || !sameText(streetAddress, currentAddress.street_address)
        || !sameText(city, currentAddress.city)
        || !sameText(editedAddress.postal_code, currentAddress.postal_code);
      const pointField = <T,>(value: T | undefined): T | null | undefined =>
        value ?? (destinationChanged ? null : undefined);
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
        latitude: isSpecialAddress ? null : pointField(editedAddress.latitude),
        longitude: isSpecialAddress ? null : pointField(editedAddress.longitude),
        place_id: isSpecialAddress ? null : pointField(editedAddress.place_id),
        formatted_address: isSpecialAddress ? combinedAddress : editedAddress.formatted_address || combinedAddress,
        resolved_street_number: isSpecialAddress ? null : editedAddress.resolved_street_number,
        address_fingerprint: editedAddress.address_fingerprint || fallbackFingerprint,
        coordinate_source: isSpecialAddress ? null : editedAddress.coordinate_source,
        geocoded_at: isSpecialAddress ? null : editedAddress.geocoded_at,
      };
      const raw = await bridge.customers.updateAddress(
        addressId,
        addressUpdatePayload,
        currentAddress?.version || 0,
      );
      // A refusal is named and the address stays in edit mode, so the
      // cashier can fix it (INVALID_COORDINATES: pick it again from the
      // suggestions); its `error` is a machine code and is never shown.
      const result = expectCustomerAddressWrite<Partial<CustomerAddress>>(
        t,
        raw,
        'update',
        'users.updateAddressError',
      );

      toast.success(
        result.queued
          ? t('users.savedLocallyQueued', 'Address saved on this register and queued for sync')
          : t('users.updateAddressSuccess', 'Address updated successfully'),
      );

      // A completed write belongs to its original customer view. Keep any newer edit open.
      if (!mounted.current || customerGeneration !== customerDetailsGeneration.current) return;
      // Use the accepted row/payload; never revive the old point after a text edit.
      const savedLocation = { ...addressUpdatePayload, ...result.data };
      const savedPoint = extractSavedAddressCoordinates(savedLocation);
      setUserAddresses(prev => prev.map(addr =>
        addr.id === addressId
          ? {
              ...addr,
              version: result.data?.version ?? addr.version,
              street_address: streetAddress,
              city,
              postal_code: editedAddress.postal_code ?? '',
              floor_number: editedAddress.floor_number,
              delivery_notes: editedAddress.delivery_notes,
              address_type: editedAddress.address_type || addr.address_type,
              is_default: editedAddress.is_default !== undefined ? editedAddress.is_default : addr.is_default,
              latitude: savedPoint?.lat,
              longitude: savedPoint?.lng,
              place_id: savedLocation.place_id ?? savedLocation.google_place_id ?? undefined,
              formatted_address: savedLocation.formatted_address,
              resolved_street_number: savedLocation.resolved_street_number ?? undefined,
              address_fingerprint: savedLocation.address_fingerprint,
              coordinate_source: savedLocation.coordinate_source,
              geocoded_at: savedLocation.geocoded_at,
            }
          : addr
      ));

      if (generation === addressGeneration.current && scope === addressScope.current) {
        setEditingAddressId(null);
        setEditedAddress({});
        addressSessionTokenRef.current = null;
      }
    } catch (error) {
      console.error('Error updating address:', error);
      // Never a native error's raw text: the refusal's own message, else the generic one.
      toast.error(customerAddressWriteErrorText(t, error, 'users.updateAddressError'));
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
      // A refusal (the address or customer is gone at the office, this
      // register's own refusals) is named and the address stays listed.
      const result = expectCustomerAddressWrite(
        t,
        await bridge.customers.deleteAddress(selectedUser.id, addressId),
        'delete',
        'users.deleteAddressError',
      );

      toast.success(
        result.queued
          ? t('users.deleteAddressQueued', 'Address deleted and queued for sync')
          : t('users.deleteAddressSuccess', 'Address deleted successfully'),
      );
      setUserAddresses(prev => prev.filter(addr => addr.id !== addressId));
    } catch (error) {
      console.error('Error deleting address:', error);
      toast.error(customerAddressWriteErrorText(t, error, 'users.deleteAddressError'));
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

  // Founder 01/11: the loyalty tier is a plain word — no bronze/silver/gold/platinum colours and no star badge,
  // because a tier is a fact about the customer, not a state that needs a look. Its points follow as muted words.
  const getLoyaltyBadge = (points: number) => {
    const tierKey = getLoyaltyTierKey(points);
    const tierLabel = t(`users.loyaltyTier.${tierKey}`, tierKey.charAt(0).toUpperCase() + tierKey.slice(1));

    return <span className="text-sm font-semibold">{tierLabel}</span>;
  };

  // Founder 01/11 («διόρθωσε και επανασχεδίασε και αυτή την σελίδα»): the page and its windows in the POS kit — a
  // pos-card hero with the refresh as a kit icon button, the kit search field and a kit filter trigger, the
  // customers as kit list rows inside a pos-card (no yellow table header), neutral icons, status as a coloured
  // word, kit icon buttons for view / block, kit pagination buttons with plain words, and the shared glass shell
  // with ONE field look for the customer details and address-delete windows.
  const subtleClass = 'text-(--pos-s-muted)';
  const kitFieldLook = 'min-h-[48px] rounded-xl border border-(--pos-s-control) bg-(--pos-s-surface) px-3 text-base font-semibold text-(--pos-s-fg) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 focus:border-(--pos-s-yellow) dark:placeholder:text-zinc-500';
  const fieldClass = `w-full ${kitFieldLook}`;
  // The same field with room for its leading search icon.
  const searchFieldClass = 'min-h-[48px] w-full rounded-xl border border-(--pos-s-control) bg-(--pos-s-surface) pl-10 pr-3 text-base font-semibold text-(--pos-s-fg) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 focus:border-(--pos-s-yellow) dark:placeholder:text-zinc-500';
  const fieldLabelClass = 'mb-1 block text-sm font-semibold text-(--pos-s-fg)';
  const sectionTitleClass = `mb-2 text-xs font-semibold uppercase tracking-wider ${subtleClass}`;
  const primaryButtonClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--primary';
  const secondaryButtonClass = 'pos-solid-btn pos-solid-btn--md';
  const dangerButtonClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--danger';
  const smallButtonClass = 'pos-solid-btn pos-solid-btn--sm';
  const modalShellClass = 'liquid-glass-modal-shell relative flex w-full flex-col overflow-hidden text-(--pos-s-fg)';
  const modalHeaderClass = 'flex shrink-0 items-start justify-between gap-4 border-b border-(--modal-glass-line) p-5';
  const modalFooterClass = 'flex shrink-0 flex-wrap items-center gap-3 border-t border-(--modal-glass-line) p-5';

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
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="flex flex-col gap-4 p-4 md:p-5 text-(--pos-s-fg)">
      {/* Header: the kit hero — title, one muted line, the refresh as a kit icon button. */}
      <motion.div variants={pageMotionItem} className="pos-card p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold tracking-tight">
              {t('users.title') || 'Users Management'}
            </h1>
            <p className={`mt-1 truncate text-sm ${subtleClass}`}>
              {t('users.description') || 'View and manage customer accounts'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadUsers()}
            disabled={loading}
            aria-label={t('common.refresh', 'Refresh')}
            className="pos-icon-btn"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.div>

      {/* The customers: toolbar (kit search field + kit filter trigger), kit list rows, kit pagination. */}
      <motion.div variants={pageMotionItem} className="pos-card">
        <div className="flex items-center gap-2 border-b border-(--pos-s-border) p-3 md:p-4">
          <div className="relative min-w-0 flex-1">
            <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${subtleClass}`} aria-hidden="true" />
            <input
              type="text"
              placeholder={t('users.searchPlaceholder') || 'Search by name, email, or phone...'}
              aria-label={t('users.searchPlaceholder') || 'Search by name, email, or phone...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={searchFieldClass}
            />
          </div>
          {/* The filter trigger is a kit icon button; while a status or tier filter is on it shows the kit
              selection (yellow with dark words) instead of the old yellow dot. */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowFilterMenu(open => !open)}
              aria-label={t('users.filters.openLabel', 'Filter users')}
              aria-haspopup="menu"
              aria-expanded={showFilterMenu}
              className={`pos-icon-btn${filtersActive ? ' border-(--pos-s-sel-bg)! bg-(--pos-s-sel-bg)! text-(--pos-s-sel-fg)!' : ''}`}
            >
              <Filter className="h-5 w-5" />
            </button>
            {showFilterMenu && (
              <>
                <div className="fixed inset-0 z-1190" onClick={() => setShowFilterMenu(false)} aria-hidden="true" />
                <div
                  role="menu"
                  className="absolute right-0 top-full z-1200 mt-2 flex max-h-[calc(100vh-22rem)] min-h-48 w-64 flex-col rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-3 text-(--pos-s-fg) shadow-xl"
                >
                  <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
                  <p className={sectionTitleClass}>
                    {t('users.filters.statusLabel', 'Status')}
                  </p>
                  <div className="mb-3 flex flex-col gap-1.5">
                    {USER_STATUS_FILTERS.map(option => (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={statusFilter === option}
                        onClick={() => setStatusFilter(option)}
                        className={`pos-choice w-full justify-start! text-left${statusFilter === option ? ' is-selected' : ''}`}
                      >
                        {t(`users.filters.status.${option}`, option.charAt(0).toUpperCase() + option.slice(1))}
                      </button>
                    ))}
                  </div>
                  <p className={sectionTitleClass}>
                    {t('users.filters.loyaltyLabel', 'Loyalty tier')}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {USER_LOYALTY_FILTERS.map(option => (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={loyaltyFilter === option}
                        onClick={() => setLoyaltyFilter(option)}
                        className={`pos-choice w-full justify-start! text-left${loyaltyFilter === option ? ' is-selected' : ''}`}
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
                      className={`mt-3 shrink-0 w-full ${smallButtonClass}`}
                    >
                      {t('users.filters.clear', 'Clear filters')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center p-8 text-center">
            <RefreshCw className={`mb-3 h-8 w-8 animate-spin ${subtleClass}`} aria-hidden="true" />
            <p className={`text-sm ${subtleClass}`}>
              {t('common.loading') || 'Loading...'}
            </p>
          </div>
        ) : filteredUsers.length === 0 ? (
          // Empty state: a neutral icon without a wrapper, one title, one muted line.
          <div className="flex min-h-[260px] flex-col items-center justify-center p-8 text-center">
            <Users className={`mb-3 h-10 w-10 ${subtleClass}`} aria-hidden="true" />
            <h3 className="text-base font-bold">
              {t('users.noUsers') || 'No users found'}
            </h3>
            <p className={`mt-1 max-w-sm text-sm ${subtleClass}`}>
              {searchTerm || filtersActive
                ? t('users.noMatches') || 'No users match your search or filters'
                : t('users.noUsersYet') || 'No users yet'}
            </p>
          </div>
        ) : (
          <>
          {/* Kit list rows: who (initials + name + role), contact, orders, loyalty, status word, kit icon
              actions. Icons are neutral; only the status word carries a colour (active ok, blocked bad). */}
          {/* Each row is its own grid, so the short facts get fixed widths and the columns line up row to row. */}
          <div role="list" className="divide-y divide-(--pos-s-border)">
            {paginatedUsers.map((user) => (
              <motion.div
                key={user.id}
                role="listitem"
                variants={pageMotionItem}
                className={`flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_6.5rem_8rem_7rem_6rem] lg:gap-3 ${updatingUserId === user.id ? 'opacity-50 pointer-events-none' : ''}`}
              >
                <div className="flex min-w-48 flex-1 items-center gap-3 lg:min-w-0">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--pos-s-surface-2) text-sm font-semibold ${subtleClass}`}
                    aria-hidden="true"
                  >
                    {user.name?.split(' ').map(n => n[0]).join('') || 'U'}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold">
                      {user.name || t('users.unnamed', 'Unnamed User')}
                    </p>
                    <p className={`truncate text-sm ${subtleClass}`}>
                      {user.type === 'app_user' ? t('users.filterAppUsers', 'App User') : t('users.customer', 'Customer')}
                    </p>
                  </div>
                </div>

                <div className={`min-w-48 flex-1 space-y-1 text-sm ${subtleClass} lg:min-w-0`}>
                  {user.email && (
                    <p className="flex min-w-0 items-center gap-2">
                      <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{user.email}</span>
                    </p>
                  )}
                  {user.phone && (
                    <p className="flex min-w-0 items-center gap-2">
                      <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{user.phone}</span>
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 whitespace-nowrap">
                  <ShoppingBag className={`h-4 w-4 shrink-0 ${subtleClass}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tabular-nums">{user.total_orders}</p>
                    <p className={`text-xs ${subtleClass}`}>{t('users.orders') || 'orders'}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 whitespace-nowrap">
                  <Star className={`h-4 w-4 shrink-0 ${subtleClass}`} aria-hidden="true" />
                  <div className="min-w-0">
                    {getLoyaltyBadge(user.loyalty_points)}
                    <p className={`text-xs tabular-nums ${subtleClass}`}>
                      {user.loyalty_points} {t('users.points') || 'points'}
                    </p>
                  </div>
                </div>

                <span className={`text-sm font-semibold ${user.is_banned ? 'text-(--pos-s-bad)' : 'text-(--pos-s-ok)'}`}>
                  {user.is_banned ? t('users.banned') || 'Banned' : t('users.active') || 'Active'}
                </span>

                <div className="ml-auto flex items-center gap-2 lg:ml-0 lg:justify-end">
                  <button
                    type="button"
                    onClick={() => handleViewUser(user)}
                    className="pos-icon-btn"
                    aria-label={t('users.viewDetails') || 'View details'}
                  >
                    <Eye className="h-5 w-5" />
                  </button>
                  {user.type !== 'app_user' && (
                    <button
                      type="button"
                      onClick={() => handleToggleBan(user.id, user.is_banned || false)}
                      className={user.is_banned ? 'pos-icon-btn' : 'pos-icon-btn pos-icon-btn--danger'}
                      aria-label={user.is_banned ? t('users.unban') || 'Unban' : t('users.ban') || 'Ban'}
                    >
                      {user.is_banned ? <CheckCircle className="h-5 w-5" /> : <Ban className="h-5 w-5" />}
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
          {/* Pagination: plain words ("1–9 of 9") and kit buttons. */}
          <div className="flex flex-col gap-3 border-t border-(--pos-s-border) px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="font-semibold tabular-nums">
              {t('users.pagination.range', '{{start}}–{{end}} of {{total}}', { start: pageStart, end: pageEnd, total: filteredUsers.length })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                disabled={activePage === 1}
                className={smallButtonClass}
              >
                {t('users.pagination.previous', 'Previous')}
              </button>
              <span className={`px-1 tabular-nums ${subtleClass}`}>
                {t('users.pagination.pageOf', 'Page {{current}} of {{total}}', { current: activePage, total: totalPages })}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={activePage === totalPages}
                className={smallButtonClass}
              >
                {t('users.pagination.next', 'Next')}
              </button>
            </div>
          </div>
          </>
        )}
      </motion.div>

      {/* Customer details window: the shared glass shell — header (title, close X), body sections as pos-frost,
          footer with Block / Unblock (danger / neutral) and the neutral Close. */}
      {showDetailsModal && selectedUser && renderModalPortal(
        <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">
          <div className="liquid-glass-modal-backdrop" aria-hidden="true" />
          <div
            ref={detailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={detailsTitleId}
            className={`max-h-[calc(100dvh-2rem)] max-w-2xl ${modalShellClass}`}
          >
            <div className={modalHeaderClass}>
              <div className="min-w-0">
                <h3 id={detailsTitleId} className="truncate text-2xl font-bold">
                  {t('users.customerDetails') || 'Customer Details'}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeDetailsModal}
                className="liquid-glass-modal-close"
                aria-label={t('common.close', 'Close')}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scrollbar-hide p-5">
              {/* Basic Info */}
              <section>
                <h4 className={sectionTitleClass}>
                  {t('users.basicInfo') || 'Basic Information'}
                </h4>
                <div className="pos-frost grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
                  <DetailLine icon={<User className="h-4 w-4" />} label={t('users.name') || 'Name'}>
                    {selectedUser.name}
                  </DetailLine>
                  <DetailLine icon={<Phone className="h-4 w-4" />} label={t('users.phone') || 'Phone'}>
                    {selectedUser.phone || '-'}
                  </DetailLine>
                  <DetailLine icon={<Mail className="h-4 w-4" />} label={t('users.email') || 'Email'}>
                    {selectedUser.email || '-'}
                  </DetailLine>
                  <DetailLine
                    icon={selectedUser.is_banned ? <Ban className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
                    label={t('users.status') || 'Status'}
                  >
                    {selectedUser.is_banned ? (
                      <span className="font-semibold text-(--pos-s-bad)">{t('users.banned') || 'Banned'}</span>
                    ) : (
                      <span className="font-semibold text-(--pos-s-ok)">{t('users.active') || 'Active'}</span>
                    )}
                  </DetailLine>
                </div>
              </section>

              {/* Addresses */}
              {userAddresses.length > 0 && (
                <section>
                  <h4 className={sectionTitleClass}>
                    {t('users.addresses') || 'Addresses'} ({userAddresses.length})
                  </h4>
                  <div className="space-y-3">
                    {userAddresses.map((address) => (
                      <div
                        key={address.id}
                        className="pos-frost rounded-xl border p-4"
                      >
                        {editingAddressId === address.id ? (
                          // Edit Mode: one kit field look; neutral Cancel and the one yellow Save.
                          <div className="space-y-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="relative">
                                <label className="block">
                                  <span className={fieldLabelClass}>
                                    {t('users.address.street', 'Street Address')}
                                  </span>
                                  <input
                                    type="text"
                                    value={editedAddress.street_address || ''}
                                    onChange={(e) => handleAddressTextChange('street_address', e.target.value)}
                                    onFocus={() => {
                                      if (addressSuggestions.length > 0) {
                                        setShowSuggestions(true);
                                      }
                                    }}
                                    className={fieldClass}
                                    placeholder={t('modals.addNewAddress.addressPlaceholder')}
                                  />
                                </label>

                                {/* Address Suggestions Dropdown */}
                                {showSuggestions && addressSuggestions.length > 0 && (
                                  <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto scrollbar-hide rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface) p-1 text-(--pos-s-fg) shadow-xl">
                                    {addressSuggestions.map((suggestion, index) => (
                                      <button
                                        key={index}
                                        type="button"
                                        onClick={() => handleAddressSuggestionClick(suggestion)}
                                        className="flex min-h-11 w-full items-start gap-2 rounded-[10px] px-3 py-2 text-left text-sm transition-colors active:bg-(--pos-s-surface-2)"
                                      >
                                        <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${subtleClass}`} aria-hidden="true" />
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate font-medium">
                                            {suggestion.structured_formatting?.main_text || suggestion.description}
                                          </p>
                                          <p className={`truncate text-xs ${subtleClass}`}>
                                            {suggestion.structured_formatting?.secondary_text || suggestion.description}
                                          </p>
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <label className="block">
                                <span className={fieldLabelClass}>
                                  {t('users.address.city', 'City')}
                                </span>
                                <input
                                  type="text"
                                  value={editedAddress.city || ''}
                                  onChange={(e) => handleAddressTextChange('city', e.target.value)}
                                  className={fieldClass}
                                />
                              </label>
                              <label className="block">
                                <span className={fieldLabelClass}>
                                  {t('users.address.postalCode', 'Postal Code')}
                                </span>
                                <input
                                  type="text"
                                  value={editedAddress.postal_code || ''}
                                  onChange={(e) => handleAddressTextChange('postal_code', e.target.value)}
                                  className={fieldClass}
                                />
                              </label>
                              <label className="block">
                                <span className={fieldLabelClass}>
                                  {t('users.address.floor', 'Floor Number')}
                                </span>
                                <input
                                  type="text"
                                  value={editedAddress.floor_number || ''}
                                  onChange={(e) => setEditedAddress({ ...editedAddress, floor_number: e.target.value })}
                                  className={fieldClass}
                                />
                              </label>
                            </div>
                            <label className="block">
                              <span className={fieldLabelClass}>
                                {t('users.address.deliveryNotes', 'Delivery Notes')}
                              </span>
                              <textarea
                                value={editedAddress.delivery_notes || ''}
                                onChange={(e) => setEditedAddress({ ...editedAddress, delivery_notes: e.target.value })}
                                rows={2}
                                className={`min-h-20 resize-none py-2.5 ${fieldClass}`}
                              />
                            </label>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={handleCancelEdit}
                                className={secondaryButtonClass}
                              >
                                <X className="h-4 w-4" />
                                {t('common.actions.cancel', 'Cancel')}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveAddress(address.id)}
                                className={primaryButtonClass}
                              >
                                <Save className="h-4 w-4" />
                                {t('common.actions.save', 'Save')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          // View Mode
                          <div className="flex items-start gap-3">
                            <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${subtleClass}`} aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold">
                                {address.street_address}, {address.city}
                              </p>
                              <p className={`text-xs ${subtleClass}`}>
                                {address.postal_code}
                                {address.floor_number && ` • ${t('users.address.floor', 'Floor')} ${address.floor_number}`}
                                {address.is_default && ` • ${t('users.address.default', 'Default')}`}
                              </p>
                              {address.delivery_notes && (
                                <p className={`mt-1 text-xs ${subtleClass}`}>
                                  {address.delivery_notes}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleEditAddress(address)}
                                className="pos-icon-btn"
                                aria-label={t('customer.actions.editAddress')}
                              >
                                <Edit3 className="h-5 w-5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteAddress(address.id)}
                                className="pos-icon-btn pos-icon-btn--danger"
                                aria-label={t('customer.actions.deleteAddress')}
                              >
                                <Trash2 className="h-5 w-5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Notes */}
              {selectedUser.notes && (
                <section>
                  <h4 className={sectionTitleClass}>
                    {t('users.notes') || 'Notes'}
                  </h4>
                  <p className="pos-frost rounded-xl border p-4 text-sm">
                    {selectedUser.notes}
                  </p>
                </section>
              )}
            </div>

            <div className={`${modalFooterClass} justify-between`}>
              {selectedUser.type !== 'app_user' && (
                <button
                  type="button"
                  onClick={() => {
                    handleToggleBan(selectedUser.id, selectedUser.is_banned || false);
                    setShowDetailsModal(false);
                    setSelectedUser(null);
                    setUserAddresses([]);
                  }}
                  disabled={updatingUserId === selectedUser.id}
                  className={selectedUser.is_banned ? secondaryButtonClass : dangerButtonClass}
                >
                  {selectedUser.is_banned ? (
                    <>
                      <CheckCircle className="h-4 w-4" />
                      {t('users.unban') || 'Unban Customer'}
                    </>
                  ) : (
                    <>
                      <Ban className="h-4 w-4" />
                      {t('users.ban') || 'Ban Customer'}
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={closeDetailsModal}
                className={`ml-auto ${secondaryButtonClass}`}
              >
                {t('common.actions.close') || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Address-delete confirmation: the shared glass shell, neutral Cancel and the danger Delete. */}
      {addressPendingDelete && renderModalPortal(
        <div
          className="fixed inset-0 z-1300 flex items-center justify-center p-4"
          onClick={() => setAddressPendingDelete(null)}
        >
          <div className="liquid-glass-modal-backdrop" aria-hidden="true" />
          <div
            ref={deleteAddressDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={deleteAddressTitleId}
            className={`max-w-md ${modalShellClass}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={modalHeaderClass}>
              <h3 id={deleteAddressTitleId} className="min-w-0 text-xl font-bold">
                {t('users.deleteAddressTitle', 'Delete address')}
              </h3>
              <button
                type="button"
                onClick={closeAddressDeleteModal}
                className="liquid-glass-modal-close"
                aria-label={t('common.close', 'Close')}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="p-5 text-sm">
              {t('users.confirmDeleteAddress', 'Are you sure you want to delete this address?')}
            </div>
            <div className={`${modalFooterClass} justify-end`}>
              <button
                type="button"
                onClick={() => setAddressPendingDelete(null)}
                className={secondaryButtonClass}
              >
                {t('common.actions.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteAddress()}
                className={dangerButtonClass}
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

// Founder 01/11: a detail row in the customer window — a neutral (muted) icon, a muted label and its value.
const DetailLine: React.FC<{ icon: React.ReactNode; label: string; children: React.ReactNode }> = ({ icon, label, children }) => (
  <div className="flex min-w-0 items-start gap-3">
    <div className="mt-0.5 shrink-0 text-(--pos-s-muted)" aria-hidden="true">{icon}</div>
    <div className="min-w-0">
      <p className="text-xs text-(--pos-s-muted)">{label}</p>
      <p className="wrap-break-word text-sm font-medium">{children}</p>
    </div>
  </div>
);

export default UsersPage;

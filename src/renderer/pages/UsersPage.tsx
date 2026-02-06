import React, { useState, useEffect } from 'react';
import { getApiUrl } from '../../config/environment';
import { posApiGet } from '../utils/api-helpers';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import toast from 'react-hot-toast';
import { getCachedTerminalCredentials, refreshTerminalCredentialCache } from '../services/terminal-credentials';
import {
  Users,
  Search,
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
  street_address: string;
  city: string;
  postal_code: string;
  floor_number?: string;
  address_type?: string;
  is_default: boolean;
  delivery_notes?: string;
}

const UsersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'customer' | 'app_user'>('all');
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [userAddresses, setUserAddresses] = useState<CustomerAddress[]>([]);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editedAddress, setEditedAddress] = useState<Partial<CustomerAddress>>({});
  const [addressSuggestions, setAddressSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);

  useEffect(() => {
    loadUsers();

    // Listen for real-time customer updates from the main process
    const handleCustomerUpdate = (_event: any, data: any) => {
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

    // Subscribe to IPC events for customer updates
    if (window.electronAPI?.on) {
      window.electronAPI.on('customer-updated', handleCustomerUpdate);
      window.electronAPI.on('customer-realtime-update', handleCustomerUpdate);
    }

    // Cleanup
    return () => {
      if (window.electronAPI?.removeListener) {
        window.electronAPI.removeListener('customer-updated', handleCustomerUpdate);
        window.electronAPI.removeListener('customer-realtime-update', handleCustomerUpdate);
      }
    };
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Fetch customers via IPC for performance
      const customers = await window.electronAPI?.customerSearch?.('') || [];

      // Fetch app users using POS-auth endpoint to avoid admin cookie requirement
      const params = new URLSearchParams({ page: '1', limit: '100', sortBy: 'created_at', sortOrder: 'desc' })

      // Resolve POS API key and terminal id like AddCustomerModal
      const ls = typeof window !== 'undefined' ? window.localStorage : null
      const refreshed = await refreshTerminalCredentialCache()
      const posKey = (refreshed.apiKey || getCachedTerminalCredentials().apiKey || '').trim()
      let termId = ''
      try {
        const electron = (typeof window !== 'undefined' ? (window as any).electronAPI : undefined)
        termId = (await electron?.getTerminalId?.()) || refreshed.terminalId || (ls?.getItem('terminal_id') || '')
      } catch {}

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (posKey) headers['x-pos-api-key'] = String(posKey)
      if (termId) headers['x-terminal-id'] = String(termId)

      const result = await posApiGet<{ users?: any[] }>(`pos/users?${params.toString()}`, { headers })
      if (!result.success) {
        throw new Error(result.error || 'Failed to load users')
      }
      const appUsers = Array.isArray(result.data?.users) ? result.data.users : []

      // Merge into single list
      const unified = [
        ...customers.map((customer: any) => ({
          id: customer.id,
          name: customer.name || customer.full_name || customer.phone,
          email: customer.email,
          phone: customer.phone,
          type: 'customer' as const,
          loyalty_points: customer.loyalty_points || 0,
          total_orders: customer.total_orders || 0,
          created_at: customer.created_at,
          updated_at: customer.updated_at,
          is_banned: Boolean(customer.is_banned)
        })),
        ...appUsers.map((u: any) => ({
          id: u.id,
          name: u.full_name || u.email || u.phone || 'Unnamed User',
          email: u.email,
          phone: u.phone,
          type: 'app_user' as const,
          loyalty_points: 0,
          total_orders: 0,
          created_at: u.created_at,
          updated_at: u.updated_at,
          is_banned: false
        }))
      ]

      // Deduplicate by ID (in case /api/pos/users returns customers)
      const uniqueUsers = Array.from(
        new Map(unified.map(user => [user.id, user])).values()
      )

      setUsers(uniqueUsers)
    } catch (error) {
      console.error('Error loading users:', error);
      toast.error(t('users.loadError') || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  // Helper to get POS auth headers
  const getPosAuthHeaders = async (): Promise<Record<string, string>> => {
    const ls = typeof window !== 'undefined' ? window.localStorage : null;
    const refreshed = await refreshTerminalCredentialCache();
    const posKey = (refreshed.apiKey || getCachedTerminalCredentials().apiKey || '').trim();
    let termId = '';
    try {
      const electron = (typeof window !== 'undefined' ? (window as any).electronAPI : undefined);
      termId = (await electron?.getTerminalId?.()) || refreshed.terminalId || (ls?.getItem('terminal_id') || '');
    } catch {}
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (posKey) headers['x-pos-api-key'] = String(posKey);
    if (termId) headers['x-terminal-id'] = String(termId);
    return headers;
  };

  const handleViewUser = async (user: UserProfile) => {
    setSelectedUser(user);
    setShowDetailsModal(true);

    // Fetch full customer data with addresses from POS API
    if (!user.phone) {
      setUserAddresses([]);
      return;
    }

    try {
      const headers = await getPosAuthHeaders();
      const response = await fetch(`${getApiUrl('pos/customers')}?phone=${encodeURIComponent(user.phone)}`, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('Customer details from API:', result);

      if (result.success && result.customer && result.customer.addresses) {
        setUserAddresses(result.customer.addresses.map((addr: any) => ({
          id: addr.id,
          customer_id: user.id,
          street_address: addr.street || addr.street_address,
          city: addr.city || '',
          postal_code: addr.postal_code || '',
          floor_number: addr.floor_number,
          address_type: addr.address_type || 'delivery',
          is_default: addr.is_default,
          delivery_notes: addr.delivery_notes || addr.notes,
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
    });
    setAddressSuggestions([]);
    setShowSuggestions(false);
  };

  const handleCancelEdit = () => {
    setEditingAddressId(null);
    setEditedAddress({});
    setAddressSuggestions([]);
    setShowSuggestions(false);
  };

  const searchAddresses = async (input: string) => {
    if (input.length < 3) {
      setAddressSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setIsLoadingAddresses(true);
    try {
      const response = await fetch(getApiUrl('google-maps/autocomplete'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: input.trim(),
          location: { latitude: 37.9755, longitude: 23.7348 }, // Athens center
          radius: 20000 // 20km radius
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.predictions && Array.isArray(result.predictions)) {
        setAddressSuggestions(result.predictions.slice(0, 5));
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
      const response = await fetch(getApiUrl('google-maps/place-details'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          place_id: suggestion.place_id
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result && result.result) {
        const addressComponents = result.result.address_components || [];

        // Extract street number and route (street name)
        const streetNumber = addressComponents.find((c: any) => c.types.includes('street_number'))?.long_name || '';
        const route = addressComponents.find((c: any) => c.types.includes('route'))?.long_name || '';
        const streetAddress = `${route} ${streetNumber}`.trim();

        // Extract city
        const city = addressComponents.find((c: any) =>
          c.types.includes('locality') || c.types.includes('administrative_area_level_3')
        )?.long_name || 'Athens';

        // Extract postal code
        const postalCode = addressComponents.find((c: any) => c.types.includes('postal_code'))?.long_name || '';

        setEditedAddress({
          ...editedAddress,
          street_address: streetAddress || suggestion.description,
          city: city,
          postal_code: postalCode
        });
      } else {
        // Fallback: use the description
        setEditedAddress({
          ...editedAddress,
          street_address: suggestion.description
        });
      }

      setShowSuggestions(false);
      setAddressSuggestions([]);
    } catch (error) {
      console.error('Error getting place details:', error);
      // Fallback: use the description
      setEditedAddress({
        ...editedAddress,
        street_address: suggestion.description
      });
      setShowSuggestions(false);
      setAddressSuggestions([]);
    }
  };

  const handleSaveAddress = async (addressId: string) => {
    if (!selectedUser) return;

    try {
      // Combine street_address and city into a single address field for the API
      const combinedAddress = `${editedAddress.street_address || ''}, ${editedAddress.city || ''}`.trim();
      const headers = await getPosAuthHeaders();

      const response = await fetch(getApiUrl(`pos/customers/${selectedUser.id}/addresses/${addressId}`), {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          address: combinedAddress,
          postal_code: editedAddress.postal_code,
          floor_number: editedAddress.floor_number,
          address_type: editedAddress.address_type || 'delivery',
          is_default: editedAddress.is_default || false,
          notes: editedAddress.delivery_notes,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        toast.success('Address updated successfully');

        // Update local state with the returned address data
        setUserAddresses(prev => prev.map(addr =>
          addr.id === addressId
            ? {
                ...addr,
                street_address: editedAddress.street_address || addr.street_address,
                city: editedAddress.city || addr.city,
                postal_code: editedAddress.postal_code || addr.postal_code,
                floor_number: editedAddress.floor_number || addr.floor_number,
                delivery_notes: editedAddress.delivery_notes || addr.delivery_notes,
                address_type: editedAddress.address_type || addr.address_type,
                is_default: editedAddress.is_default !== undefined ? editedAddress.is_default : addr.is_default,
              }
            : addr
        ));

        setEditingAddressId(null);
        setEditedAddress({});
      } else {
        throw new Error(result.error || 'Failed to update address');
      }
    } catch (error) {
      console.error('Error updating address:', error);
      toast.error('Failed to update address');
    }
  };

  const handleDeleteAddress = async (addressId: string) => {
    if (!selectedUser) return;

    if (!confirm('Are you sure you want to delete this address?')) {
      return;
    }

    try {
      const headers = await getPosAuthHeaders();
      const response = await fetch(getApiUrl(`pos/customers/${selectedUser.id}/addresses/${addressId}`), {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        toast.success('Address deleted successfully');

        // Update local state
        setUserAddresses(prev => prev.filter(addr => addr.id !== addressId));
      } else {
        throw new Error(result.error || 'Failed to delete address');
      }
    } catch (error) {
      console.error('Error deleting address:', error);
      toast.error('Failed to delete address');
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
      const result = await window.electronAPI?.invoke?.('customer:update-ban-status', userId, newBanStatus);

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
    let tier = 'Bronze';
    let color = 'bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400';

    if (points >= 1000) {
      tier = 'Platinum';
      color = 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400';
    } else if (points >= 500) {
      tier = 'Gold';
      color = 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
    } else if (points >= 200) {
      tier = 'Silver';
      color = 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400';
    }

    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
        <Star className="w-3 h-3 mr-1" />
        {tier}
      </span>
    );
  };

  const filteredUsers = users.filter(user => {
    if (typeFilter !== 'all' && user.type !== typeFilter) return false;
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      user.name?.toLowerCase().includes(search) ||
      user.email?.toLowerCase().includes(search) ||
      user.phone?.toLowerCase().includes(search)
    );
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className={`text-3xl font-bold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {t('users.title') || 'Users Management'}
            </h1>
            <p className={`text-lg mt-2 ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
              {t('users.description') || 'View and manage customer accounts'}
            </p>
          </div>
          <button
            onClick={loadUsers}
            className={`inline-flex items-center px-4 py-2 rounded-lg transition-colors ${
              resolvedTheme === 'dark'
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            }`}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            {t('common.actions.refresh') || 'Refresh'}
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className={`mb-6 p-4 rounded-xl ${
        resolvedTheme === 'dark' ? 'bg-gray-800/50' : 'bg-white'
      }`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <input
              type="text"
              placeholder={t('users.searchPlaceholder') || 'Search by name, email, or phone...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={`w-full pl-10 pr-4 py-2 rounded-lg ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-700 text-white border-gray-600'
                  : 'bg-gray-50 text-gray-900 border-gray-300'
              } border focus:ring-2 focus:ring-blue-500 focus:border-blue-500`}
            />
          </div>
          <div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | 'customer' | 'app_user')}
              className={`px-3 py-2 rounded-lg border ${
                resolvedTheme === 'dark' ? 'bg-gray-700 text-white border-gray-600' : 'bg-gray-50 text-gray-900 border-gray-300'
              }`}
            >
              <option value="all">{t('filters.all', 'All')}</option>
              <option value="customer">Customers</option>
              <option value="app_user">App Users</option>
            </select>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className={`rounded-xl overflow-hidden ${
        resolvedTheme === 'dark' ? 'bg-gray-800/50' : 'bg-white'
      }`}>
        {loading ? (
          <div className="p-12 text-center">
            <RefreshCw className="w-8 h-8 mx-auto mb-4 animate-spin text-blue-500" />
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
              {searchTerm ? t('users.tryAdjusting') || 'Try adjusting your search' : t('users.noUsersYet') || 'No users yet'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className={resolvedTheme === 'dark' ? 'bg-gray-700/50' : 'bg-gray-50'}>
                <tr>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.customer') || 'Customer'}
                  </th>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.contact') || 'Contact'}
                  </th>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.activity') || 'Activity'}
                  </th>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.loyalty') || 'Loyalty'}
                  </th>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.status') || 'Status'}
                  </th>
                  <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    {t('users.actions') || 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody className={`divide-y ${resolvedTheme === 'dark' ? 'divide-gray-700' : 'divide-gray-200'}`}>
                {filteredUsers.map((user) => (
                  <tr
                    key={user.id}
                    className={`transition-colors ${
                      resolvedTheme === 'dark' ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'
                    } ${updatingUserId === user.id ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                          resolvedTheme === 'dark' ? 'bg-gray-600' : 'bg-gray-200'
                        }`}>
                          <span className={`text-sm font-medium ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'
                          }`}>
                            {user.name?.split(' ').map(n => n[0]).join('') || 'U'}
                          </span>
                        </div>
                        <div className="ml-4">
                          <div className={`text-sm font-medium ${
                            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                          }`}>
                            {user.name || 'Unnamed User'}
                          </div>
                          <div className={`text-sm ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            {user.type === 'app_user' ? 'App User' : 'Customer'}
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
                            <Mail className="w-4 h-4 mr-2 text-gray-400" />
                            {user.email}
                          </div>
                        )}
                        {user.phone && (
                          <div className={`flex items-center text-sm ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            <Phone className="w-4 h-4 mr-2 text-gray-400" />
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
                          <ShoppingBag className="w-4 h-4 mr-2 text-gray-400" />
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
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400">
                            <Ban className="w-3 h-3 mr-1" />
                            {t('users.banned') || 'Banned'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400">
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
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 transition-colors"
                          title={t('users.viewDetails') || 'View details'}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {user.type !== 'app_user' && (
                          <button
                            onClick={() => handleToggleBan(user.id, user.is_banned || false)}
                            className={`${
                              user.is_banned
                                ? 'text-green-600 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300'
                                : 'text-orange-600 dark:text-orange-400 hover:text-orange-900 dark:hover:text-orange-300'
                            } transition-colors`}
                            title={user.is_banned ? t('users.unban') || 'Unban' : t('users.ban') || 'Ban'}
                          >
                            {user.is_banned ? <CheckCircle className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* User Details Modal */}
      {showDetailsModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className={`max-w-2xl w-full rounded-xl shadow-xl ${
            resolvedTheme === 'dark' ? 'bg-gray-800' : 'bg-white'
          }`}>
            <div className={`px-6 py-4 border-b ${
              resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
            }`}>
              <h3 className={`text-xl font-semibold ${
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
                        className={`p-4 rounded-lg border ${
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
                                  Street Address
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.street_address || ''}
                                  onChange={(e) => {
                                    setEditedAddress({ ...editedAddress, street_address: e.target.value });
                                    searchAddresses(e.target.value);
                                  }}
                                  onFocus={() => {
                                    if (addressSuggestions.length > 0) {
                                      setShowSuggestions(true);
                                    }
                                  }}
                                  className={`w-full px-3 py-2 rounded-lg text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
                                  placeholder={t('modals.addNewAddress.addressPlaceholder')}
                                />

                                {/* Address Suggestions Dropdown */}
                                {showSuggestions && addressSuggestions.length > 0 && (
                                  <div className={`absolute z-50 w-full mt-1 rounded-lg shadow-lg max-h-60 overflow-y-auto ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 border-gray-600'
                                      : 'bg-white border-gray-200'
                                  } border`}>
                                    {addressSuggestions.map((suggestion, index) => (
                                      <button
                                        key={index}
                                        type="button"
                                        onClick={() => handleAddressSuggestionClick(suggestion)}
                                        className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-500/10 transition-colors border-b last:border-b-0 ${
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
                                  City
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.city || ''}
                                  onChange={(e) => setEditedAddress({ ...editedAddress, city: e.target.value })}
                                  className={`w-full px-3 py-2 rounded-lg text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
                                />
                              </div>
                              <div>
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  Postal Code
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.postal_code || ''}
                                  onChange={(e) => setEditedAddress({ ...editedAddress, postal_code: e.target.value })}
                                  className={`w-full px-3 py-2 rounded-lg text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
                                />
                              </div>
                              <div>
                                <label className={`text-xs font-medium ${
                                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  Floor Number
                                </label>
                                <input
                                  type="text"
                                  value={editedAddress.floor_number || ''}
                                  onChange={(e) => setEditedAddress({ ...editedAddress, floor_number: e.target.value })}
                                  className={`w-full px-3 py-2 rounded-lg text-sm ${
                                    resolvedTheme === 'dark'
                                      ? 'bg-gray-800 text-white border-gray-600'
                                      : 'bg-white text-gray-900 border-gray-300'
                                  } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
                                />
                              </div>
                            </div>
                            <div>
                              <label className={`text-xs font-medium ${
                                resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                              }`}>
                                Delivery Notes
                              </label>
                              <textarea
                                value={editedAddress.delivery_notes || ''}
                                onChange={(e) => setEditedAddress({ ...editedAddress, delivery_notes: e.target.value })}
                                rows={2}
                                className={`w-full px-3 py-2 rounded-lg text-sm ${
                                  resolvedTheme === 'dark'
                                    ? 'bg-gray-800 text-white border-gray-600'
                                    : 'bg-white text-gray-900 border-gray-300'
                                } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleSaveAddress(address.id)}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                              >
                                <Save className="w-4 h-4" />
                                Save
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm ${
                                  resolvedTheme === 'dark'
                                    ? 'bg-gray-600 text-white hover:bg-gray-500'
                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                }`}
                              >
                                <X className="w-4 h-4" />
                                Cancel
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
                                {address.floor_number && ` • Floor ${address.floor_number}`}
                                {address.is_default && ' • Default'}
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
                                className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-lg transition-colors"
                                title={t('customer.actions.editAddress')}
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteAddress(address.id)}
                                className="p-2 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                title={t('customer.actions.deleteAddress')}
                              >
                                <Trash2 className="w-4 h-4" />
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
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                    selectedUser.is_banned
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-orange-600 hover:bg-orange-700 text-white'
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
                onClick={() => {
                  setShowDetailsModal(false);
                  setSelectedUser(null);
                  setUserAddresses([]);
                }}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
                }`}
              >
                {t('common.actions.close') || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersPage;


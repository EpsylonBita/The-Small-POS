import React, { useState, useRef, useEffect } from 'react';
import { MapPin, User, Phone, Mail, FileText, Building, Users, AlertTriangle, CheckCircle, Clock, Hash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getApiUrl } from '../../../config/environment';
import { Customer } from '../../../shared/types/customer';
import { customerService } from '../../services/CustomerService';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useTheme } from '../../contexts/theme-context';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  getCachedTerminalCredentials,
  getResolvedTerminalCredentials,
} from '../../services/terminal-credentials';

import { inputBase } from '../../styles/designSystem';

interface CustomerData {
  id?: string;
  phone: string;
  name?: string;
  email?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  name_on_ringer?: string;
  addresses?: any[];
  version?: number;
  editAddressId?: string; // ID of address to edit (for editAddress mode)
}

interface AddCustomerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCustomerAdded: (customer: any) => void;
  initialPhone?: string;
  initialCustomer?: CustomerData;
  /**
   * Modal mode:
   * - 'new': Creating a new customer (default)
   * - 'edit': Full edit of existing customer (all fields editable)
   * - 'addAddress': Adding a new address to existing customer (only address fields editable)
   * - 'editAddress': Editing an existing address (only address fields editable)
   */
  mode?: 'new' | 'edit' | 'addAddress' | 'editAddress';
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string, details?: any) => void;
  placeholder?: string;
  className?: string;
}

const AddressAutocomplete: React.FC<AddressAutocompleteProps> = ({
  value,
  onChange,
  placeholder,
  className = ""
}) => {
  const { t } = useTranslation();
  const placeholderText = placeholder ?? t('modals.addNewAddress.addressPlaceholder');
  const { resolvedTheme } = useTheme();
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [terminalBranchId, setTerminalBranchId] = useState<string | null>(null);
  const bridge = getBridge();

  useEffect(() => {
    let cancelled = false;

    const setIfNotCancelled = (lat: number, lng: number) => {
      if (cancelled) return;
      setUserLocation({ latitude: lat, longitude: lng });
      console.log('[AddressAutocomplete] Location resolved:', lat, lng);
    };

    const resolveViaMainProcess = async (): Promise<boolean> => {
      try {
        const res = await bridge.geo.ip();
        if (res && (res as any).ok && typeof (res as any).latitude === 'number' && typeof (res as any).longitude === 'number') {
          setIfNotCancelled((res as any).latitude, (res as any).longitude);
          return true;
        }
      } catch (e) {
        console.warn('[AddressAutocomplete] main-process IP geolocation failed:', e);
      }
      return false;
    };

    const fetchIpFallback = async () => {
      // Prefer main-process fetch (bypasses renderer CSP)
      if (await resolveViaMainProcess()) return;

      // As a last resort, try direct fetches (may be blocked by CSP in some builds)
      try {
        const res = await fetch('https://ipapi.co/json/');
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
            setIfNotCancelled(data.latitude, data.longitude);
            return;
          }
        }
      } catch { }
      try {
        const res2 = await fetch('https://ipwho.is/');
        if (res2.ok) {
          const data2 = await res2.json();
          if (data2 && data2.success && data2.latitude && data2.longitude) {
            setIfNotCancelled(Number(data2.latitude), Number(data2.longitude));
            return;
          }
        }
      } catch { }
      console.warn('[AddressAutocomplete] IP geolocation fallback failed; proceeding without location bias');
    };

    // Avoid Chromium provider 403 spam: use IP-based geolocation only
    fetchIpFallback();

    return () => { cancelled = true };
  }, []);

  // Resolve branch id from main (Admin-provisioned) - needed for delivery zone validation
  useEffect(() => {
    const resolveBranch = async () => {
      try {
        const bid = await bridge.terminalConfig.getBranchId()
        if (bid) setTerminalBranchId(bid)
      } catch { }
    }
    const handleTerminalSettingsUpdated = () => {
      void resolveBranch()
    }
    resolveBranch()
    onEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
    onEvent('terminal-config-updated', handleTerminalSettingsUpdated)
    return () => {
      offEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
      offEvent('terminal-config-updated', handleTerminalSettingsUpdated)
    }
  }, [bridge.terminalConfig]);

  const searchAddresses = async (input: string) => {
    if (input.length < 3) {
      setSuggestions([]);
      return;
    }

    setIsLoading(true);
    try {
      const url = getApiUrl('google-maps/autocomplete');
      console.log('[AddressAutocomplete] 🔎 autocomplete →', { input, url, userLocation });

      // Call the Google Places Autocomplete API
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: input.trim(),
          location: userLocation || undefined,
          radius: userLocation ? 20000 : undefined // 20km bias when location known
        })
      });

      console.log('[AddressAutocomplete] 📡 autocomplete status:', response.status);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${text}`);
      }

      const result = await response.json();
      console.log('[AddressAutocomplete] ✅ autocomplete result:', { count: Array.isArray(result?.predictions) ? result.predictions.length : 0, sample: result?.predictions?.[0] });

      if (result.predictions && Array.isArray(result.predictions)) {
        // Convert predictions to the format expected by the UI
        const formattedSuggestions = result.predictions.map((pred: any) => ({
          place_id: pred.place_id,
          name: pred.main_text || pred.description,
          formatted_address: pred.description,
          description: pred.description
        }));
        setSuggestions(formattedSuggestions.slice(0, 5)); // Limit to 5 suggestions
      } else {
        setSuggestions([]);
      }
    } catch (error) {
      console.error('[AddressAutocomplete] ❌ Error searching addresses:', error);
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    console.log('[AddressAutocomplete] ⌨️ input change:', newValue);
    onChange(newValue);
    setShowSuggestions(true);

    // Debounce the search
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      console.log('[AddressAutocomplete] ⏱️ debounced search for:', newValue);
      searchAddresses(newValue);
    }, 300);
  };

  const handleSuggestionClick = async (suggestion: any) => {
    try {
      // Get place details to extract street address, city, postal code, and coordinates
      const response = await fetch(getApiUrl('google-maps/place-details'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          place_id: suggestion.place_id,
          // Provide coordinates for OSM reverse fallback when Google key is missing
          location: suggestion.location || undefined,
          formatted_address: suggestion.formatted_address || undefined
        })
      });

      let detailsResult: any = null;
      if (response.ok) {
        detailsResult = await response.json();
      } else {
        console.warn('[AddressAutocomplete] place-details non-OK', response.status);
      }

      let streetAddress = ''; // Only street name + number
      let city = '';
      let postalCode = '';
      let coordinates: { lat: number; lng: number } | undefined = undefined;

      if (detailsResult && detailsResult.result) {
        const addressComponents = detailsResult.result.address_components || [];

        // Extract street number and route (street name)
        const streetNumber = addressComponents.find((component: any) =>
          component.types.includes('street_number')
        )?.long_name || '';

        const route = addressComponents.find((component: any) =>
          component.types.includes('route')
        )?.long_name || '';

        // Combine street name and number (e.g., "Kresnas 4")
        if (route && streetNumber) {
          streetAddress = `${route} ${streetNumber}`;
        } else if (route) {
          streetAddress = route;
        } else {
          // Fallback to main_text from suggestion
          streetAddress = suggestion.name || suggestion.formatted_address.split(',')[0];
        }

        // Extract city (locality or administrative_area_level_3)
        const cityComponent = addressComponents.find((component: any) =>
          component.types.includes('locality') ||
          component.types.includes('administrative_area_level_3')
        );
        if (cityComponent) {
          city = cityComponent.long_name;
        }

        // Extract postal code
        const postalCodeComponent = addressComponents.find((component: any) =>
          component.types.includes('postal_code')
        );
        if (postalCodeComponent) {
          postalCode = postalCodeComponent.long_name;
        }

        // Extract coordinates
        const loc = detailsResult.result.geometry?.location;
        if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
          coordinates = { lat: loc.lat, lng: loc.lng };
        }
      } else {
        // Fallback: use only the first part of the address (before first comma)
        streetAddress = suggestion.formatted_address.split(',')[0];
      }

      // Pass street address, city, postal code, and coordinates
      onChange(streetAddress, { city, postalCode, coordinates });
      setSuggestions([]);
      setShowSuggestions(false);
      // Do NOT auto-submit; let the user click Save
    } catch (error) {
      console.error('Error getting place details:', error);
      // Fallback: use only the first part of the address
      const streetAddress = suggestion.formatted_address.split(',')[0];
      onChange(streetAddress);
      setSuggestions([]);
      setShowSuggestions(false);
      // Do NOT auto-submit; let the user click Save
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="relative">
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
        <input
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
          onFocus={() => setShowSuggestions(true)}
          placeholder={placeholderText}
          autoComplete="off"
          className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${className}`}
        />
      </div>

      {/* Suggestions Dropdown */}
      {showSuggestions && (suggestions.length > 0 || isLoading) && (
        <div className="absolute left-0 right-0 top-full z-[9999] mt-1 liquid-glass-modal-card shadow-2xl max-h-60 overflow-y-auto">
          {isLoading && (
            <div className="p-3 text-center text-gray-500 dark:text-gray-400">
              {t('modals.addCustomer.searchingAddresses')}
            </div>
          )}

          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              key={suggestion.place_id || index}
              onClick={() => handleSuggestionClick(suggestion)}
              className="w-full text-left p-3 hover:bg-white/10 dark:hover:bg-white/5 transition-colors border-b border-gray-200/20 dark:border-gray-600/20 last:border-b-0"
            >
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-blue-500 dark:text-blue-400 mt-1 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {suggestion.name}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {suggestion.formatted_address}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const AddCustomerModal: React.FC<AddCustomerModalProps> = ({
  isOpen,
  onClose,
  onCustomerAdded,
  initialPhone,
  initialCustomer,
  mode = 'new',
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const bridge = getBridge();

  const [terminalBranchId, setTerminalBranchId] = useState<string | null>(null);
  const validationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if we're editing an existing customer
  const isEditing = !!initialCustomer?.id;

  // In addAddress or editAddress mode, customer info fields are read-only
  const isAddAddressMode = mode === 'addAddress';
  const isEditAddressMode = mode === 'editAddress';
  const isAddressOnlyMode = isAddAddressMode || isEditAddressMode;

  useEffect(() => {
    const loadBid = async () => {
      try {
        const bid = await bridge.terminalConfig.getBranchId();
        if (bid) setTerminalBranchId(bid);
      } catch { }
    }
    const handleTerminalSettingsUpdated = () => {
      void loadBid()
    }
    loadBid()
    onEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
    onEvent('terminal-config-updated', handleTerminalSettingsUpdated)
    return () => {
      offEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
      offEvent('terminal-config-updated', handleTerminalSettingsUpdated)
    }
  }, [bridge.terminalConfig]);

  const [formData, setFormData] = useState({
    phone: '',
    name: '',
    email: '',
    nameOnRinger: '',
    address: '',
    city: '',
    postalCode: '',
    floorNumber: '',
    notes: '',
  });

  // Track if form has been initialized for this modal open
  const formInitializedRef = useRef(false);

  // Reset initialization flag when modal closes
  useEffect(() => {
    if (!isOpen) {
      formInitializedRef.current = false;
    }
  }, [isOpen]);

  // Prefill form from initialCustomer (for editing) or initialPhone (for new customer)
  // Only runs ONCE when modal opens to prevent resetting while user types
  useEffect(() => {
    if (isOpen && !formInitializedRef.current) {
      formInitializedRef.current = true;

      // Reset delivery validation state when modal opens
      setDeliveryValidationResult(null);
      setShowDeliveryValidation(false);
      setAddressCoordinates(null);
      setIsValidatingDelivery(false);
      setErrors({});

      if (initialCustomer) {
        if (isEditAddressMode && initialCustomer.editAddressId) {
          // Edit Address mode - find the address to edit and prefill its data
          const addressToEdit = initialCustomer.addresses?.find(
            (addr: any) => addr.id === initialCustomer.editAddressId
          );
          if (addressToEdit) {
            setFormData({
              phone: initialCustomer.phone || '',
              name: initialCustomer.name || '',
              email: initialCustomer.email || '',
              nameOnRinger: addressToEdit.name_on_ringer || '',
              address: addressToEdit.street_address || addressToEdit.street || '',
              city: addressToEdit.city || '',
              postalCode: addressToEdit.postal_code || '',
              floorNumber: addressToEdit.floor_number || '',
              notes: addressToEdit.notes || '',
            });
          } else {
            // Address not found, fall back to empty address fields
            setFormData({
              phone: initialCustomer.phone || '',
              name: initialCustomer.name || '',
              email: initialCustomer.email || '',
              nameOnRinger: '',
              address: '',
              city: '',
              postalCode: '',
              floorNumber: '',
              notes: '',
            });
          }
        } else if (isAddAddressMode) {
          // Add Address mode - only prefill customer info, leave address fields EMPTY for new address
          setFormData({
            phone: initialCustomer.phone || '',
            name: initialCustomer.name || '',
            email: initialCustomer.email || '',
            nameOnRinger: '', // Empty for new address
            address: '', // Empty for new address
            city: '', // Empty for new address
            postalCode: '', // Empty for new address
            floorNumber: '', // Empty for new address
            notes: '', // Empty for new address
          });
        } else {
          // Edit mode - prefill all fields
          setFormData({
            phone: initialCustomer.phone || '',
            name: initialCustomer.name || '',
            email: initialCustomer.email || '',
            nameOnRinger: initialCustomer.name_on_ringer || '',
            address: initialCustomer.address || '',
            city: initialCustomer.city || '',
            postalCode: initialCustomer.postal_code || '',
            floorNumber: initialCustomer.floor_number || '',
            notes: initialCustomer.notes || '',
          });
        }
      } else if (initialPhone) {
        // New customer with just phone prefilled
        setFormData({
          phone: initialPhone,
          name: '',
          email: '',
          nameOnRinger: '',
          address: '',
          city: '',
          postalCode: '',
          floorNumber: '',
          notes: '',
        });
      } else {
        // Completely new - reset everything
        setFormData({
          phone: '',
          name: '',
          email: '',
          nameOnRinger: '',
          address: '',
          city: '',
          postalCode: '',
          floorNumber: '',
          notes: '',
        });
      }
    }
  }, [isOpen, initialPhone, initialCustomer, isAddAddressMode, isEditAddressMode]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deliveryValidationResult, setDeliveryValidationResult] = useState<any>(null);
  const [showDeliveryValidation, setShowDeliveryValidation] = useState(false);
  const [addressCoordinates, setAddressCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [isValidatingDelivery, setIsValidatingDelivery] = useState(false);

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const handleAddressChange = (address: string, details?: any) => {
    console.log('🔍 handleAddressChange called with:', { address, details });

    // Clear address error
    if (errors.address) {
      setErrors(prev => ({ ...prev, address: '' }));
    }

    // Clear existing validation timeout
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }

    // Check if this is a suggestion selection (has details with city/postalCode/coordinates)
    const isFromSuggestion = details && (details.city || details.postalCode || details.coordinates);

    if (isFromSuggestion) {
      // User selected a suggestion - fill all fields and validate
      console.log('✅ Suggestion selected, filling city/postal and validating:', { address, details });
      setFormData(prev => ({
        ...prev,
        address,
        city: details.city || prev.city,
        postalCode: details.postalCode || prev.postalCode,
      }));

      // Show delivery validation and trigger it immediately for selected address
      setShowDeliveryValidation(true);
      validationTimeoutRef.current = setTimeout(() => {
        console.log('⏰ Triggering delivery validation for selected address:', address);
        validateDeliveryAddress(address, details.coordinates);
      }, 300); // Quick validation after selection
    } else {
      // User is just typing - only update address, don't validate yet
      console.log('⌨️ User typing, just updating address (no validation):', address);
      setFormData(prev => ({
        ...prev,
        address,
      }));

      // Hide delivery validation while typing
      if (address.trim().length === 0) {
        setShowDeliveryValidation(false);
        setDeliveryValidationResult(null);
      }
    }
  };
  // Normalize Admin API response shape to legacy shape used by UI
  const normalizeDeliveryValidation = (res: any) => {
    try {
      if (res && typeof res === 'object' && ('isValid' in res || 'selectedZone' in res)) {
        const z = res.selectedZone || null;
        return {
          success: true,
          deliveryAvailable: Boolean((res as any).isValid),
          message: (res as any).reason || null,
          zone: z ? {
            id: z.id,
            name: z.name,
            deliveryFee: z.delivery_fee ?? z.deliveryFee ?? null,
            minimumOrderAmount: z.minimum_order_amount ?? z.minimumOrderAmount ?? null,
            estimatedTime: {
              min: z.estimated_delivery_time_min ?? z.estimatedTime?.min ?? null,
              max: z.estimated_delivery_time_max ?? z.estimatedTime?.max ?? null,
            }
          } : null,
          override: undefined,
          coordinates: (res as any).coordinates || undefined,
        };
      }
    } catch { }
    // Already in expected shape or unknown – return as-is
    return res;
  };


  // Attempt server-side geocoding (search-places + place-details) and re-validate
  const attemptAutoGeocodeAndRevalidate = async (addr: string) => {
    try {
      const searchUrl = getApiUrl('google-maps/search-places');
      console.log('🧭 Auto-geocode: searching', { addr, searchUrl });
      const searchRes = await fetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: addr + ', Greece',
          branchId: terminalBranchId || getCachedTerminalCredentials().branchId || undefined,
        }),
      });
      if (!searchRes.ok) {
        console.warn('🧭 Auto-geocode: search failed', searchRes.status);
        return;
      }
      const searchJson = await searchRes.json();
      const first = Array.isArray(searchJson?.places) ? searchJson.places[0] : null;
      if (!first) {
        console.warn('🧭 Auto-geocode: no candidates');
        return;
      }

      // Optionally enrich with details to extract coordinates
      let coords: { lat: number; lng: number } | undefined = first?.location;
      try {
        const detailsUrl = getApiUrl('google-maps/place-details');
        const detRes = await fetch(detailsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ place_id: first.place_id, location: first.location, formatted_address: first.formatted_address }),
        });
        if (detRes.ok) {
          const details = await detRes.json();
          const loc = details?.result?.geometry?.location;
          if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
            coords = { lat: loc.lat, lng: loc.lng };
          }
          // Do NOT auto-fill the address - let user keep their input
        }
      } catch { }

      if (coords) {
        setAddressCoordinates(coords);
        console.log('🧭 Auto-geocode: got coords', coords, '→ re-validating');
        await validateDeliveryAddress(addr, coords, 1);
      }
    } catch (e) {
      console.warn('🧭 Auto-geocode failed:', e);
    }
  };

  const validateDeliveryAddress = async (address: string, coords?: { lat: number; lng: number }, retryCount: number = 0) => {
    console.log('🚀 validateDeliveryAddress called with:', address);
    if (!address.trim()) {
      console.log('❌ Address is empty, skipping validation');
      return;
    }

    console.log('⏳ Starting delivery validation...');
    setIsValidatingDelivery(true);
    try {
      // Use POS-specific endpoint that accepts terminal authentication
      const apiUrl = getApiUrl('pos/delivery-zones/validate');
      console.log('📡 Calling API:', apiUrl);

      // Get API credentials for authentication
      let posKey = '';
      let termId = '';

      try {
        const [apiKeyResult, terminalIdResult] = await Promise.allSettled([
          bridge.terminalConfig.getSetting('terminal', 'pos_api_key'),
          bridge.terminalConfig.getTerminalId(),
        ]);
        if (apiKeyResult.status === 'fulfilled') {
          posKey = (apiKeyResult.value || '').toString().trim();
          console.log('[validateDeliveryAddress] Got API key from bridge:', posKey ? `(len: ${posKey.length})` : '(empty)');
        }
        if (terminalIdResult.status === 'fulfilled') {
          termId = (terminalIdResult.value || '').toString().trim();
          console.log('[validateDeliveryAddress] Got terminal ID from bridge:', termId || '(empty)');
        }
      } catch (e) {
        console.warn('[validateDeliveryAddress] Error getting credentials from bridge:', e);
      }

      const refreshed = await getResolvedTerminalCredentials();
      if (!posKey) {
        posKey = (refreshed.apiKey || getCachedTerminalCredentials().apiKey || '').trim();
        console.log('[validateDeliveryAddress] Got API key from credential cache:', posKey ? '(present)' : '(empty)');
      }
      if (!termId) {
        termId = (refreshed.terminalId || getCachedTerminalCredentials().terminalId || '').trim();
        console.log('[validateDeliveryAddress] Got terminal ID from credential cache:', termId || '(empty)');
      }

      console.log('[validateDeliveryAddress] Final credentials - posKey:', posKey ? `(len: ${posKey.length})` : '(empty)', 'termId:', termId || '(empty)');

      // Build headers with authentication
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (posKey) {
        headers['x-pos-api-key'] = String(posKey);
        if (termId) headers['x-terminal-id'] = String(termId);
      }

      // Call the delivery validation API directly
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          address,
          coordinates: coords,
          orderAmount: 0, // Default for customer creation
          branchId: terminalBranchId || refreshed.branchId || getCachedTerminalCredentials().branchId || undefined,
        }),
      });

      console.log('📡 API Response status:', response.status);

      if (response.ok) {
        const result = await response.json();
        console.log('✅ Delivery validation result (raw):', result);
        const normalized = normalizeDeliveryValidation(result);
        console.log('✅ Delivery validation result (normalized):', normalized);
        setDeliveryValidationResult(normalized);

        // Store coordinates if available
        if (normalized && (normalized as any).coordinates) {
          setAddressCoordinates((normalized as any).coordinates);
          console.log('📍 Stored coordinates:', (normalized as any).coordinates);
        }

        // If server asks for geocoding first, try to autocomplete once then re-validate
        const suggested = (result as any)?.suggestedAction || (normalized as any)?.suggestedAction || '';
        const message: string = (normalized as any)?.message || '';
        if (retryCount === 0 && (!coords) && (suggested === 'geocode_first' || /geocod/i.test(message))) {
          await attemptAutoGeocodeAndRevalidate(address);
        }
      } else {
        console.error('❌ Delivery validation failed:', response.status);
        const errorResult = {
          success: false,
          deliveryAvailable: false,
          message: t('modals.addCustomer.validationError'),
        };
        setDeliveryValidationResult(errorResult);
        console.log('❌ Set error result:', errorResult);
      }
    } catch (error) {
      console.error('💥 Delivery validation error:', error);
      const errorResult = {
        success: false,
        deliveryAvailable: false,
        message: t('modals.addCustomer.validationError'),
      };
      setDeliveryValidationResult(errorResult);
      console.log('💥 Set error result:', errorResult);
    } finally {
      console.log('🏁 Validation complete, setting isValidatingDelivery to false');
      setIsValidatingDelivery(false);
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.phone.trim()) {
      newErrors.phone = t('modals.addCustomer.phoneRequired');
    }

    if (!formData.name.trim()) {
      newErrors.name = t('modals.addCustomer.nameRequired');
    }

    if (!formData.address.trim()) {
      newErrors.address = t('modals.addCustomer.streetRequired');
    } else if (deliveryValidationResult && !deliveryValidationResult.deliveryAvailable && !deliveryValidationResult.override?.applied) {
      newErrors.address = t('modals.addCustomer.addressOutsideArea');
    }

    if (!formData.nameOnRinger.trim()) {
      newErrors.nameOnRinger = t('modals.addCustomer.nameOnRingerRequired', 'Name on ringer is required');
    }

    if (!formData.floorNumber.trim()) {
      newErrors.floorNumber = t('modals.addCustomer.floorRequired', 'Floor number is required');
    }

    if (formData.email && !/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = t('modals.addCustomer.emailInvalid');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[AddCustomerModal.handleSubmit] BUILD v2026.01.05.2 - Called with mode:', mode, 'initialCustomer:', initialCustomer?.id, initialCustomer?.name);
    console.log('[AddCustomerModal.handleSubmit] formData:', JSON.stringify(formData, null, 2));

    if (!validateForm()) {
      console.log('[AddCustomerModal.handleSubmit] Validation failed');
      return;
    }

    setIsSubmitting(true);
    console.log('[AddCustomerModal.handleSubmit] Starting submission...');

    try {
      // Get credentials from secure main-process/IPC context
      let posKey = ''
      let termId = ''

      // Try to get credentials from typed bridge (most reliable)
      try {
        const [mainTerminalId, mainApiKey] = await Promise.all([
          bridge.terminalConfig.getTerminalId(),
          bridge.terminalConfig.getSetting('terminal', 'pos_api_key'),
        ])
        termId = (mainTerminalId || '').toString().trim()
        posKey = (mainApiKey || '').toString().trim()
      } catch (e) {
        console.warn('[AddCustomerModal] Failed to get credentials from bridge:', e)
      }

      const refreshed = await getResolvedTerminalCredentials()
      if (!posKey) {
        posKey = (refreshed.apiKey || getCachedTerminalCredentials().apiKey || '').trim()
      }
      if (!termId) {
        termId = (refreshed.terminalId || getCachedTerminalCredentials().terminalId || '').trim()
      }

      // Build headers with authentication
      const headers: any = { 'Content-Type': 'application/json' }
      if (posKey) {
        headers['x-pos-api-key'] = String(posKey)
        if (termId) headers['x-terminal-id'] = String(termId)
      }

      // Handle ADD ADDRESS mode - save new address to existing customer via IPC
      if (mode === 'addAddress' && initialCustomer?.id) {
        console.log('[AddCustomerModal] Adding new address for customer:', initialCustomer.id)

        try {
          // Use IPC service to avoid CORS
          const addressData = {
            street_address: formData.address.trim(), // Map to DB column name
            city: formData.city ? formData.city.trim() : 'Athens',
            postal_code: formData.postalCode ? formData.postalCode.trim() : null,
            floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
            notes: formData.notes ? formData.notes.trim() : null,
            address_type: 'delivery',
            is_default: false,
            coordinates: addressCoordinates, // Pass coordinates
          };

          // Result from IPC is { success: boolean, data?: any, error?: string }
          const result = await customerService.addCustomerAddress(initialCustomer.id, addressData) as any;

          if (result && result.success) {
            const newAddress = result.data;
            console.log('[AddCustomerModal] addAddress success - newAddress from API:', JSON.stringify(newAddress, null, 2));
            // Return the customer with the new address info
            const updatedCustomer = {
              ...initialCustomer,
              // Update legacy fields for immediate UI feedback if needed,
              // though proper selection should use selected_address_id
              address: formData.address.trim(),
              postal_code: formData.postalCode ? formData.postalCode.trim() : initialCustomer.postal_code,
              floor_number: formData.floorNumber ? formData.floorNumber.trim() : initialCustomer.floor_number,
              notes: formData.notes ? formData.notes.trim() : initialCustomer.notes,
              name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : initialCustomer.name_on_ringer,
              // Include the new address ID
              selected_address_id: newAddress?.id,
              // Ensure addresses array includes the new one if we have it locally
              addresses: initialCustomer.addresses ? [...initialCustomer.addresses, newAddress] : [newAddress]
            };
            console.log('[AddCustomerModal] Calling onCustomerAdded with updatedCustomer:', JSON.stringify({
              id: updatedCustomer.id,
              name: updatedCustomer.name,
              address: updatedCustomer.address,
              addresses: updatedCustomer.addresses,
              selected_address_id: updatedCustomer.selected_address_id
            }, null, 2));

            onCustomerAdded(updatedCustomer);
          } else {
            throw new Error(result?.error || 'Failed to add address');
          }
        } catch (err: any) {
          throw new Error(err.message || 'Failed to add address');
        }
        return;
      }

      // Handle EDIT ADDRESS mode - update existing address in customer_addresses table
      if (mode === 'editAddress' && initialCustomer?.id && initialCustomer?.editAddressId) {
        console.log('[AddCustomerModal] Updating address:', initialCustomer.editAddressId, 'for customer:', initialCustomer.id);

        try {
          const addressData = {
            street_address: formData.address.trim(),
            city: formData.city ? formData.city.trim() : null,
            postal_code: formData.postalCode ? formData.postalCode.trim() : null,
            floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
            notes: formData.notes ? formData.notes.trim() : null,
            coordinates: addressCoordinates,
          };

          // Find the address to get its current version
          const addressToEdit = initialCustomer.addresses?.find(
            (addr: any) => addr.id === initialCustomer.editAddressId
          );
          const currentVersion = addressToEdit?.version || 1;

          // Use customerService to update the address
          const result = await customerService.updateCustomerAddress(
            initialCustomer.editAddressId,
            addressData,
            currentVersion
          ) as any;

          if (result && result.success) {
            const updatedAddress = result.data;
            // Update the addresses array with the edited address
            const updatedAddresses = initialCustomer.addresses?.map((addr: any) =>
              addr.id === initialCustomer.editAddressId ? { ...addr, ...updatedAddress } : addr
            ) || [];

            // Return the customer with updated addresses
            const updatedCustomer = {
              ...initialCustomer,
              addresses: updatedAddresses,
              // Keep editAddressId so OrderFlow knows which address was edited
              editAddressId: initialCustomer.editAddressId,
            };

            onCustomerAdded(updatedCustomer);
          } else {
            throw new Error(result?.error || 'Failed to update address');
          }
        } catch (err: any) {
          throw new Error(err.message || 'Failed to update address');
        }
        return;
      }

      // Handle EDIT mode - update existing customer via IPC
      if (mode === 'edit' && initialCustomer?.id) {
        console.log('[AddCustomerModal] Updating existing customer via IPC:', initialCustomer.id);
        console.log('[AddCustomerModal] initialCustomer.version:', (initialCustomer as any).version);

        try {
          const updates = {
            phone: formData.phone.trim(),
            name: formData.name.trim(),
            email: formData.email ? formData.email.trim() : undefined,
            address: formData.address.trim(),
            city: formData.city ? formData.city.trim() : undefined,
            postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
            floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
            notes: formData.notes ? formData.notes.trim() : undefined,
            name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
            // Pass coordinates if available
            coordinates: addressCoordinates
          };

          // Use optimistic versioning if available, otherwise fetch fresh version
          let currentVersion = initialCustomer.version;

          // If no version, fetch fresh customer data to get current version
          if (currentVersion === undefined || currentVersion === null) {
            console.log('[AddCustomerModal] No version found, fetching fresh customer data...');
            try {
              // First invalidate cache to ensure we get fresh data
              await bridge.customers.invalidateCache(initialCustomer.phone);

              const freshCustomer = await bridge.customers.lookupByPhone(initialCustomer.phone);
              console.log('[AddCustomerModal] Fresh customer data:', JSON.stringify(freshCustomer, null, 2));
              if (freshCustomer?.version !== undefined && freshCustomer?.version !== null) {
                currentVersion = freshCustomer.version;
                console.log('[AddCustomerModal] Got fresh version:', currentVersion);
              } else if (freshCustomer?.id) {
                // Customer exists but has no version - this is a legacy customer
                // We need to fetch the actual version from the database or use force update
                console.log('[AddCustomerModal] Customer exists but no version in response, using force update (-1)');
                currentVersion = -1; // Signal to skip version check for legacy customers
              }
            } catch (e) {
              console.warn('[AddCustomerModal] Failed to fetch fresh version:', e);
            }
          }

          // If still no version after fetching, throw error - version is required for updates
          if (currentVersion === undefined || currentVersion === null) {
            console.error('[AddCustomerModal] Cannot update customer without version');
            throw new Error(t('modals.addCustomer.versionRequired', 'Unable to update customer - please refresh and try again'));
          }

          console.log('[AddCustomerModal] Using version for update:', currentVersion);

          // Result is { success, data, conflict, error }
          const result = await customerService.updateCustomer(initialCustomer.id, updates, currentVersion) as any;

          if (result && result.success) {
            // Success - merge the updated customer with address data from form
            // The API returns customer without addresses, so we need to include them
            const updatedCustomer = {
              ...result.data,
              // Include address data from form for immediate use
              address: formData.address.trim(),
              city: formData.city ? formData.city.trim() : undefined,
              postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
              floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
              notes: formData.notes ? formData.notes.trim() : undefined,
              name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
              // Preserve existing addresses from initialCustomer if available
              addresses: initialCustomer.addresses || [],
            };
            onCustomerAdded(updatedCustomer);
            setFormData({
              phone: '',
              name: '',
              email: '',
              nameOnRinger: '',
              address: '',
              city: '',
              postalCode: '',
              floorNumber: '',
              notes: '',
            });
          } else if (result?.conflict) {
            throw new Error(t('modals.addCustomer.conflictError', 'Customer was updated by another terminal. Please refresh.'));
          } else {
            throw new Error(result?.error || 'Failed to update customer');
          }
        } catch (err: any) {
          throw new Error(err.message || 'Failed to update customer');
        }
        return;
      }

      // Handle NEW mode - create customer via IPC
      console.log('[AddCustomerModal] Creating new customer via IPC');

      const newCustomerData = {
        phone: formData.phone.trim(),
        name: formData.name.trim(),
        email: formData.email ? formData.email.trim() : undefined,
        address: formData.address.trim(),
        city: formData.city ? formData.city.trim() : undefined,
        postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
        floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
        notes: formData.notes ? formData.notes.trim() : undefined,
        name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
        // Branch association - assign customer to the terminal's branch
        branch_id: terminalBranchId || undefined,
        // Include delivery validation data and coordinates
        coordinates: addressCoordinates,
        // Note: delivery_validation might require schema update in Main process to be persisted
        // providing it here in case it is supported or for future support
        delivery_validation: deliveryValidationResult ? {
          validated: true,
          delivery_available: deliveryValidationResult.deliveryAvailable,
          zone_id: deliveryValidationResult.zone?.id,
          zone_name: deliveryValidationResult.zone?.name,
          delivery_fee: deliveryValidationResult.zone?.deliveryFee,
          minimum_order_amount: deliveryValidationResult.zone?.minimumOrderAmount,
          override_applied: deliveryValidationResult.override?.applied || false,
          override_reason: deliveryValidationResult.override?.reason
        } : null,
      };

      // Cast to any to handle the wrapper object return { success, data }
      const result = await customerService.createCustomer(newCustomerData as any) as any;

      if (result && result.success) {
        onCustomerAdded(result.data);

        // Reset form
        setFormData({
          phone: '',
          name: '',
          email: '',
          nameOnRinger: '',
          address: '',
          city: '',
          postalCode: '',
          floorNumber: '',
          notes: '',
        });
      } else {
        throw new Error(result?.error || 'Failed to create customer');
      }
    } catch (error) {
      console.error('[AddCustomerModal.handleSubmit] Error:', error);
      console.error('[AddCustomerModal.handleSubmit] Mode was:', mode, 'initialCustomer:', initialCustomer?.id);
      setErrors({ submit: error instanceof Error ? error.message : t('modals.addCustomer.failed') });
    } finally {
      console.log('[AddCustomerModal.handleSubmit] Finally block - isSubmitting set to false');
      setIsSubmitting(false);
    }
  };

  // Cleanup validation timeout on unmount
  useEffect(() => {
    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
    };
  }, []);

  // Determine modal title based on mode
  const getModalTitle = () => {
    if (isAddAddressMode) {
      return t('modals.addCustomer.addAddressTitle', 'Add New Address');
    }
    if (isEditAddressMode) {
      return t('modals.addCustomer.editAddressTitle', 'Edit Address');
    }
    if (isEditing) {
      return t('modals.addCustomer.editTitle');
    }
    return t('modals.addCustomer.title');
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={getModalTitle()}
      size="sm"
      className="!max-w-lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {/* Form Content */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Phone Number - disabled in addAddress mode */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.phoneLabel').replace(' *', '')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => handleInputChange('phone', e.target.value)}
              placeholder={t('modals.addCustomer.phonePlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${isAddressOnlyMode ? 'opacity-60 cursor-not-allowed' : ''}`}
              disabled={isAddressOnlyMode}
              readOnly={isAddressOnlyMode}
            />
          </div>
          {errors.phone && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.phone}</p>
          )}
        </div>

        {/* Address with Simple Input + Delivery Validation */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.addressLabel').replace(' *', '')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <AddressAutocomplete
              value={formData.address}
              onChange={handleAddressChange}
              placeholder={t('modals.addCustomer.streetPlaceholder')}
              className="pr-3"
            />
          </div>
          {errors.address && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.address}</p>
          )}
        </div>

        {/* Delivery Validation */}
        {showDeliveryValidation && (
          <div className="liquid-glass-modal-card">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <MapPin className="w-4 h-4" />
                {t('modals.addCustomer.deliveryValidation')}
              </div>

              {/* Validation Status */}
              <div className="min-h-[24px]">
                {isValidatingDelivery && (
                  <div className="flex items-center gap-2 text-blue-600">
                    <Clock className="w-4 h-4 animate-spin" />
                    <span className="text-sm">{t('modals.addCustomer.validatingAddress')}</span>
                  </div>
                )}

                {!isValidatingDelivery && deliveryValidationResult && (
                  <div>
                    {deliveryValidationResult.deliveryAvailable ? (
                      <div className="flex items-center gap-2 text-green-600">
                        <CheckCircle className="w-4 h-4" />
                        <span className="text-sm">
                          {t('modals.addCustomer.deliveryAvailable')}
                          {deliveryValidationResult.zone && (
                            <span> • {deliveryValidationResult.zone.name} • €{deliveryValidationResult.zone.deliveryFee} {t('modals.addCustomer.deliveryFee')}</span>
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-red-600">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-sm">
                          {deliveryValidationResult.message || t('modals.addCustomer.addressOutsideArea')}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Validation Details */}
              {deliveryValidationResult && deliveryValidationResult.zone && (
                <div className="bg-black/20 rounded-lg p-3 space-y-2 border border-white/5">
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.zone')}:</span>
                      <span className="ml-2 font-medium">{deliveryValidationResult.zone.name}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.deliveryFee')}:</span>
                      <span className="ml-2 font-medium">€{deliveryValidationResult.zone.deliveryFee}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.minimumOrder')}:</span>
                      <span className="ml-2 font-medium">€{deliveryValidationResult.zone.minimumOrderAmount}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.estimatedTime')}:</span>
                      <span className="ml-2 font-medium">
                        {deliveryValidationResult.zone.estimatedTime?.min || 30}-{deliveryValidationResult.zone.estimatedTime?.max || 45} min
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* City */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.cityLabel')}
          </label>
          <div className="relative">
            <Building className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="text"
              value={formData.city}
              onChange={(e) => handleInputChange('city', e.target.value)}
              placeholder={t('modals.addCustomer.cityPlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4`}
            />
          </div>
        </div>

        {/* Postal Code */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.postcodeLabel')}
          </label>
          <div className="relative">
            <Hash className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="text"
              value={formData.postalCode}
              onChange={(e) => handleInputChange('postalCode', e.target.value)}
              placeholder={t('modals.addCustomer.postcodePlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4`}
            />
          </div>
        </div>

        {/* Name - disabled in addAddress mode */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.nameLabel').replace(' *', '')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              placeholder={t('modals.addCustomer.namePlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${isAddressOnlyMode ? 'opacity-60 cursor-not-allowed' : ''}`}
              disabled={isAddressOnlyMode}
              readOnly={isAddressOnlyMode}
            />
          </div>
          {errors.name && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.name}</p>
          )}
        </div>

        {/* Email - disabled in addAddress/editAddress mode */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.emailLabel')}
          </label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="email"
              value={formData.email}
              onChange={(e) => handleInputChange('email', e.target.value)}
              placeholder={t('modals.addCustomer.emailPlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${isAddressOnlyMode ? 'opacity-60 cursor-not-allowed' : ''}`}
              disabled={isAddressOnlyMode}
              readOnly={isAddressOnlyMode}
            />
          </div>
          {errors.email && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.email}</p>
          )}
        </div>

        {/* Name on Ringer */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.nameOnRingerLabel')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Users className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="text"
              value={formData.nameOnRinger}
              onChange={(e) => handleInputChange('nameOnRinger', e.target.value)}
              placeholder={t('modals.addCustomer.nameOnRingerPlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4`}
            />
          </div>
          {errors.nameOnRinger && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.nameOnRinger}</p>
          )}
        </div>

        {/* Floor Number */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.floorLabel')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Building className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <input
              type="text"
              value={formData.floorNumber}
              onChange={(e) => handleInputChange('floorNumber', e.target.value)}
              placeholder={t('modals.addCustomer.floorPlaceholder')}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4`}
            />
          </div>
          {errors.floorNumber && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.floorNumber}</p>
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.addCustomer.notesLabel')}
          </label>
          <div className="relative">
            <FileText className="absolute left-3 top-3 w-5 h-5 text-blue-500 dark:text-blue-400" />
            <textarea
              value={formData.notes}
              onChange={(e) => handleInputChange('notes', e.target.value)}
              placeholder={t('modals.addCustomer.notesPlaceholder')}
              rows={3}
              className={`${inputBase(resolvedTheme)} pl-10 pr-4 resize-none`}
            />
          </div>
        </div>

        {/* Submit Error */}
        {errors.submit && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-600 dark:text-red-400 text-sm">
            {errors.submit}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="liquid-glass-modal-button flex-1 text-gray-300 bg-white/5 border-white/10 hover:border-white/20"
          >
            {t('modals.addCustomer.cancel')}
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 py-3 px-4 rounded-2xl font-bold text-white bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isSubmitting
              ? t('modals.addCustomer.saving')
              : mode === 'addAddress'
                ? t('modals.addCustomer.saveAddress', 'Save Address')
                : mode === 'edit'
                  ? t('modals.addCustomer.saveChanges', 'Save Changes')
                  : t('modals.addCustomer.save')
            }
          </button>
        </div>
      </form>
    </LiquidGlassModal>
  );
};

import React, { useState, useRef, useEffect } from 'react';
import { MapPin, User, Phone, Mail, FileText, Building, Users, AlertTriangle, CheckCircle, Clock, Hash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Customer } from '../../../shared/types/customer';
import { customerService } from '../../services/CustomerService';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useTheme } from '../../contexts/theme-context';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  buildAddressFingerprint,
  ensureAddressOfflineRuntime,
  extractStreetNumber,
  resolveAddressSuggestion,
  searchAddressSuggestions,
  upsertVerifiedLocalCandidate,
  validateAddressForDelivery,
  type DeliveryValidationResult,
  type ValidationStatus,
} from '../../services/address-workflow';
import {
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
  onChange: (value: string, details?: AddressSelectionDetails) => void;
  placeholder?: string;
  className?: string;
}

interface AddressSelectionDetails {
  city?: string;
  postalCode?: string;
  coordinates?: { lat: number; lng: number };
  placeId?: string;
  resolvedStreetNumber?: string;
  addressFingerprint?: string;
  validationSource?: 'online' | 'offline_cache';
  fromSuggestion?: boolean;
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
  const searchRequestRef = useRef(0);
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

  useEffect(() => {
    void ensureAddressOfflineRuntime(terminalBranchId || undefined);
  }, [terminalBranchId]);

  const searchAddresses = async (input: string, requestId: number) => {
    try {
      const results = await searchAddressSuggestions(input, {
        branchId: terminalBranchId || undefined,
        location: userLocation,
        radius: userLocation ? 20000 : undefined,
        limit: 5,
      });
      if (requestId !== searchRequestRef.current) {
        return;
      }
      setSuggestions(results.slice(0, 5));
    } catch (error) {
      if (requestId !== searchRequestRef.current) {
        return;
      }
      console.error('[AddressAutocomplete] ❌ Error searching addresses:', error);
      setSuggestions([]);
    } finally {
      if (requestId === searchRequestRef.current) {
        setIsLoading(false);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    setShowSuggestions(true);

    // Debounce the search
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (newValue.length < 3) {
      searchRequestRef.current += 1;
      setIsLoading(false);
      setSuggestions([]);
      return;
    }

    const requestId = ++searchRequestRef.current;
    setIsLoading(true);
    timeoutRef.current = setTimeout(() => {
      void searchAddresses(newValue, requestId);
    }, 200);
  };

  const handleSuggestionClick = async (suggestion: any) => {
    try {
      const resolved = await resolveAddressSuggestion(suggestion, value, {
        branchId: terminalBranchId || undefined,
      });
      void upsertVerifiedLocalCandidate({
        place_id: resolved.placeId || suggestion.place_id,
        branch_id: terminalBranchId || undefined,
        name: resolved.streetAddress,
        formatted_address: resolved.formattedAddress || suggestion.formatted_address || resolved.streetAddress,
        city: resolved.city || undefined,
        postal_code: resolved.postalCode || undefined,
        location: resolved.coordinates || suggestion.location || undefined,
        resolved_street_number: resolved.resolvedStreetNumber || undefined,
        address_fingerprint: resolved.addressFingerprint,
        source: resolved.validationSource,
        verified: true,
      });

      onChange(resolved.streetAddress, {
        city: resolved.city || undefined,
        postalCode: resolved.postalCode || undefined,
        coordinates: resolved.coordinates,
        placeId: resolved.placeId || suggestion.place_id,
        resolvedStreetNumber: resolved.resolvedStreetNumber,
        addressFingerprint: resolved.addressFingerprint,
        validationSource: resolved.validationSource,
        fromSuggestion: true,
      });
      setSuggestions([]);
      setShowSuggestions(false);
    } catch (error) {
      console.error('Error getting place details:', error);
      const streetAddress =
        suggestion?.name ||
        String(suggestion?.formatted_address || '').split(',')[0] ||
        String(suggestion?.formatted_address || '');
      onChange(streetAddress, { fromSuggestion: false });
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      searchRequestRef.current += 1;
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
      setDeliveryValidationStatus('idle');
      setShowDeliveryValidation(false);
      setAddressCoordinates(null);
      setSelectedAddressDetails(null);
      setValidationSnapshot(null);
      setOverrideApplied(false);
      setOverrideReason('');
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
  const [deliveryValidationResult, setDeliveryValidationResult] = useState<DeliveryValidationResult | null>(null);
  const [deliveryValidationStatus, setDeliveryValidationStatus] = useState<ValidationStatus | 'idle'>('idle');
  const [showDeliveryValidation, setShowDeliveryValidation] = useState(false);
  const [addressCoordinates, setAddressCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [isValidatingDelivery, setIsValidatingDelivery] = useState(false);
  const [selectedAddressDetails, setSelectedAddressDetails] = useState<AddressSelectionDetails | null>(null);
  const [validationSnapshot, setValidationSnapshot] = useState<string | null>(null);
  const [overrideApplied, setOverrideApplied] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const clearAddressValidation = (addressValue: string) => {
    setSelectedAddressDetails(null);
    setAddressCoordinates(null);
    setDeliveryValidationResult(null);
    setValidationSnapshot(null);
    setOverrideApplied(false);
    setOverrideReason('');

    if (!addressValue.trim()) {
      setShowDeliveryValidation(false);
      setDeliveryValidationStatus('idle');
      return;
    }

    setShowDeliveryValidation(true);
    setDeliveryValidationStatus('requires_selection');
    setDeliveryValidationResult({
      success: true,
      isValid: false,
      deliveryAvailable: false,
      validation_status: 'requires_selection',
      requires_override: false,
      house_number_match: true,
      message: t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.'),
    });
  };

  const validateDeliveryAddress = async (
    address: string,
    details?: AddressSelectionDetails | null
  ): Promise<DeliveryValidationResult | null> => {
    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      return null;
    }

    setIsValidatingDelivery(true);
    try {
      const coords = details?.coordinates || addressCoordinates || undefined;
      const fallbackFingerprint = buildAddressFingerprint(trimmedAddress, coords);

      const validation = await validateAddressForDelivery(trimmedAddress, {
        branchId: terminalBranchId || undefined,
        orderAmount: 0,
        placeId: details?.placeId,
        coordinates: coords,
        inputStreetNumber: extractStreetNumber(trimmedAddress),
        resolvedStreetNumber: details?.resolvedStreetNumber,
        addressFingerprint: details?.addressFingerprint || fallbackFingerprint,
        validationSource: details?.validationSource,
      });

      setDeliveryValidationResult(validation);
      setDeliveryValidationStatus(validation.validation_status);
      setShowDeliveryValidation(true);
      setValidationSnapshot(validation.address_fingerprint || fallbackFingerprint);
      if (validation.coordinates) {
        setAddressCoordinates(validation.coordinates);
      } else if (coords) {
        setAddressCoordinates(coords);
      }

      if (validation.validation_status === 'in_zone') {
        setOverrideApplied(false);
        setOverrideReason('');
      }

      return validation;
    } catch (error) {
      console.error('Delivery validation error:', error);
      const fallback: DeliveryValidationResult = {
        success: false,
        isValid: false,
        deliveryAvailable: false,
        validation_status: 'unverified_offline',
        requires_override: true,
        house_number_match: true,
        message: t('modals.addCustomer.validationError'),
      };
      setDeliveryValidationResult(fallback);
      setDeliveryValidationStatus('unverified_offline');
      setShowDeliveryValidation(true);
      return fallback;
    } finally {
      setIsValidatingDelivery(false);
    }
  };

  const ensureAddressValidationForSubmit = async (): Promise<DeliveryValidationResult | null> => {
    const address = formData.address.trim();
    if (!address) {
      return null;
    }

    const coords = selectedAddressDetails?.coordinates || addressCoordinates || undefined;
    const currentFingerprint = buildAddressFingerprint(address, coords);

    if (deliveryValidationResult && validationSnapshot === currentFingerprint) {
      return deliveryValidationResult;
    }

    return validateDeliveryAddress(address, selectedAddressDetails);
  };

  const evaluateValidationDecision = (result: DeliveryValidationResult | null): string | null => {
    if (!result) {
      return t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.');
    }

    if (result.validation_status === 'in_zone') {
      return null;
    }

    if (result.validation_status === 'requires_selection') {
      return t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.');
    }

    if (result.validation_status === 'out_of_zone') {
      if (!overrideApplied) {
        return t('modals.addCustomer.outOfZoneOverrideRequired', 'Address is out of zone. Tap accept out-of-zone and provide a reason to continue.');
      }
      if (overrideReason.trim().length < 6) {
        return t('modals.addCustomer.overrideReasonRequired', 'Override reason must be at least 6 characters.');
      }
      return null;
    }

    if (result.validation_status === 'unverified_offline') {
      if (!overrideApplied) {
        return t('modals.addCustomer.offlineOverrideRequired', 'Address is unverified offline. Confirm warning and provide a reason to continue.');
      }
      if (overrideReason.trim().length < 6) {
        return t('modals.addCustomer.overrideReasonRequired', 'Override reason must be at least 6 characters.');
      }
      return null;
    }

    return t('modals.addCustomer.validationError');
  };

  const handleAddressChange = (address: string, details?: AddressSelectionDetails) => {

    // Clear address error
    if (errors.address) {
      setErrors(prev => ({ ...prev, address: '' }));
    }
    if (errors.overrideReason) {
      setErrors(prev => ({ ...prev, overrideReason: '' }));
    }

    // Clear existing validation timeout
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }

    const isFromSuggestion = Boolean(details?.fromSuggestion);

    if (isFromSuggestion) {
      setFormData(prev => ({
        ...prev,
        address,
        city: details?.city || prev.city,
        postalCode: details?.postalCode || prev.postalCode,
      }));
      setSelectedAddressDetails(details || null);
      setAddressCoordinates(details?.coordinates || null);
      setOverrideApplied(false);
      setOverrideReason('');
      setShowDeliveryValidation(true);
      validationTimeoutRef.current = setTimeout(() => {
        void validateDeliveryAddress(address, details);
      }, 250);
      return;
    }
    setFormData(prev => ({
      ...prev,
      address,
    }));
    clearAddressValidation(address);
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
    }

    if (overrideApplied && overrideReason.trim().length < 6) {
      newErrors.overrideReason = t('modals.addCustomer.overrideReasonRequired', 'Override reason must be at least 6 characters.');
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

    const validationForSubmit = await ensureAddressValidationForSubmit();
    const validationDecisionError = evaluateValidationDecision(validationForSubmit);
    if (validationDecisionError) {
      const nextErrors: Record<string, string> = {};
      const status = validationForSubmit?.validation_status;
      if ((status === 'out_of_zone' || status === 'unverified_offline') && overrideApplied) {
        nextErrors.overrideReason = validationDecisionError;
      } else {
        nextErrors.address = validationDecisionError;
      }
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      return;
    }

    setIsSubmitting(true);
    console.log('[AddCustomerModal.handleSubmit] Starting submission...');

    try {
      const refreshed = await getResolvedTerminalCredentials().catch(() => ({
        branchId: terminalBranchId || undefined,
      } as any));
      const activeValidation = validationForSubmit || deliveryValidationResult;
      // Persist the exact selected suggestion point first (Google/OSM details), then fallback.
      const persistedCoords =
        selectedAddressDetails?.coordinates || addressCoordinates || activeValidation?.coordinates || null;
      const validatedAt = activeValidation ? new Date().toISOString() : null;
      const normalizedOverrideReason = overrideApplied ? overrideReason.trim() : '';
      const validationMetadata = {
        override_applied: overrideApplied,
        override_reason: normalizedOverrideReason || null,
        validation_status: activeValidation?.validation_status || null,
        zone_id: activeValidation?.selectedZone?.id || null,
        validated_at: validatedAt,
        validation_source: activeValidation?.validation_source || null,
        address_fingerprint:
          activeValidation?.address_fingerprint
          || validationSnapshot
          || buildAddressFingerprint(formData.address.trim(), persistedCoords || undefined),
        place_id: selectedAddressDetails?.placeId || null,
        input_street_number: extractStreetNumber(formData.address.trim()) || null,
        resolved_street_number: selectedAddressDetails?.resolvedStreetNumber || null,
        house_number_match: activeValidation?.house_number_match ?? true,
      };

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
            coordinates: persistedCoords,
            latitude: persistedCoords?.lat ?? null,
            longitude: persistedCoords?.lng ?? null,
            ...validationMetadata,
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
            coordinates: persistedCoords,
            latitude: persistedCoords?.lat ?? null,
            longitude: persistedCoords?.lng ?? null,
            ...validationMetadata,
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
            coordinates: persistedCoords,
            latitude: persistedCoords?.lat ?? null,
            longitude: persistedCoords?.lng ?? null,
            delivery_validation: validationMetadata,
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
        branch_id: terminalBranchId || refreshed.branchId || undefined,
        // Include delivery validation data and coordinates
        coordinates: persistedCoords,
        latitude: persistedCoords?.lat ?? null,
        longitude: persistedCoords?.lng ?? null,
        delivery_validation: activeValidation ? {
          validated: true,
          delivery_available: activeValidation.deliveryAvailable,
          zone_name: activeValidation.selectedZone?.name ?? null,
          delivery_fee: activeValidation.selectedZone?.delivery_fee ?? null,
          minimum_order_amount: activeValidation.selectedZone?.minimum_order_amount ?? null,
          ...validationMetadata,
        } : null,
      };

      const createdRaw = await customerService.createCustomer(newCustomerData as any) as any;
      const createdCustomer = (createdRaw?.data ?? createdRaw?.customer ?? createdRaw) as any;

      if (createdCustomer?.id) {
        onCustomerAdded(createdCustomer);

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
        throw new Error(createdRaw?.error || 'Failed to create customer');
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
                    {deliveryValidationStatus === 'in_zone' ? (
                      <div className="flex items-center gap-2 text-green-600">
                        <CheckCircle className="w-4 h-4" />
                        <span className="text-sm">
                          {t('modals.addCustomer.deliveryAvailable')}
                          {deliveryValidationResult.selectedZone && (
                            <span> • {deliveryValidationResult.selectedZone.name} • €{deliveryValidationResult.selectedZone.delivery_fee} {t('modals.addCustomer.deliveryFee')}</span>
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className={`flex items-center gap-2 ${deliveryValidationStatus === 'unverified_offline' ? 'text-yellow-500' : 'text-red-600'}`}>
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-sm">
                          {deliveryValidationResult.message
                            || (deliveryValidationStatus === 'requires_selection'
                              ? t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.')
                              : t('modals.addCustomer.addressOutsideArea'))}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Validation Details */}
              {deliveryValidationResult && deliveryValidationResult.selectedZone && (
                <div className="bg-black/20 rounded-lg p-3 space-y-2 border border-white/5">
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.zone')}:</span>
                      <span className="ml-2 font-medium">{deliveryValidationResult.selectedZone.name}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.deliveryFee')}:</span>
                      <span className="ml-2 font-medium">€{deliveryValidationResult.selectedZone.delivery_fee}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.minimumOrder')}:</span>
                      <span className="ml-2 font-medium">€{deliveryValidationResult.selectedZone.minimum_order_amount}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">{t('modals.addCustomer.estimatedTime')}:</span>
                      <span className="ml-2 font-medium">
                        {deliveryValidationResult.selectedZone.estimated_delivery_time_min || 30}-{deliveryValidationResult.selectedZone.estimated_delivery_time_max || 45} min
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {(deliveryValidationStatus === 'out_of_zone' || deliveryValidationStatus === 'unverified_offline') && (
                <div className="space-y-2 rounded-lg border border-orange-500/30 bg-orange-500/10 p-3">
                  <label className="flex items-center gap-2 text-sm text-orange-200">
                    <input
                      type="checkbox"
                      checked={overrideApplied}
                      onChange={(e) => setOverrideApplied(e.target.checked)}
                    />
                    {deliveryValidationStatus === 'out_of_zone'
                      ? t('modals.addCustomer.acceptOutOfZone', 'Accept out-of-zone delivery')
                      : t('modals.addCustomer.acceptOfflineUnverified', 'Accept offline unverified delivery')}
                  </label>
                  <textarea
                    value={overrideReason}
                    onChange={(e) => {
                      setOverrideReason(e.target.value);
                      if (errors.overrideReason) {
                        setErrors((prev) => ({ ...prev, overrideReason: '' }));
                      }
                    }}
                    placeholder={t('modals.addCustomer.overrideReasonPlaceholder', 'Add override reason (minimum 6 characters)')}
                    rows={2}
                    className={`${inputBase(resolvedTheme)} resize-none`}
                  />
                  {errors.overrideReason && (
                    <p className="text-xs text-red-400">{errors.overrideReason}</p>
                  )}
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

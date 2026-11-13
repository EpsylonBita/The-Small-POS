import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Clock, Home, Mail, MapPin, User } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import {
  buildAddressFingerprint,
  createAddressSessionToken,
  ensureAddressOfflineRuntime,
  extractStreetNumber,
  getSuggestionStreetLabel,
  formatAddressDistance,
  locateTypedAddress,
  resolveAddressSuggestion,
  searchAddressSuggestions,
  upsertVerifiedLocalCandidate,
  validateAddressForDelivery,
  type AddressSuggestion,
  type DeliveryValidationResult,
  type ValidationStatus,
} from '../../services/address-workflow';
import { streetNamesDiffer } from '../../services/address-street-name';
import { getResolvedTerminalCredentials } from '../../services/terminal-credentials';
import { MODULE_IDS, useAcquiredModules } from '../../hooks/useAcquiredModules';
import { getBridge } from '../../../lib';
import { parseSpecialAddressInput } from '../../utils/specialAddress';
import { FloorPresetPicker } from '../forms/FloorPresetPicker';
import {
  customerAddressWriteErrorText,
  expectCustomerAddressWrite,
} from '../../utils/customer-address-write-refusal';

const ADDRESS_SAVE_FAILED_KEY = 'modals.addCustomer.addressSaveFailed';

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
}

interface AddNewAddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer;
  onAddressAdded: (
    customer: Customer,
    newAddress: string,
    postalCode?: string,
    floorNumber?: string,
    notes?: string
  ) => void;
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

export const AddNewAddressModal: React.FC<AddNewAddressModalProps> = ({
  isOpen,
  onClose,
  customer,
  onAddressAdded,
}) => {
  const { t, i18n } = useTranslation();
  // Presentation only: preserve every existing reveal condition (founder 11/11/2026).
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };
  const bridge = useRef(getBridge()).current;
  const { hasModule } = useAcquiredModules();
  const hasDeliveryModule = hasModule(MODULE_IDS.DELIVERY);
  const hasDeliveryZonesModule = hasModule(MODULE_IDS.DELIVERY_ZONES);
  const hasDeliveryPro = hasDeliveryModule && hasDeliveryZonesModule;
  const [formData, setFormData] = useState({
    address: '',
    postalCode: '',
    floorNumber: '',
    notes: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [selectedAddressDetails, setSelectedAddressDetails] = useState<AddressSelectionDetails | null>(null);
  const [addressCoordinates, setAddressCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [validationResult, setValidationResult] = useState<DeliveryValidationResult | null>(null);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus | 'idle'>('idle');
  const [validationSnapshot, setValidationSnapshot] = useState<string | null>(null);
  const [isValidatingDelivery, setIsValidatingDelivery] = useState(false);
  const [overrideApplied, setOverrideApplied] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [providerPostalCode, setProviderPostalCode] = useState<string | null>(null);
  const [mapStreetName, setMapStreetName] = useState<string | null>(null);
  const typedLocateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateAddressWork = () => {
    searchRequestRef.current += 1;
    if (typedLocateTimerRef.current) clearTimeout(typedLocateTimerRef.current);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setIsValidatingDelivery(false);
    setIsLoadingAddresses(false);
    setSuggestions([]);
    setProviderPostalCode(null);
    setMapStreetName(null);
  };
  const handleClose = () => { invalidateAddressWork(); onClose(); };
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestRef = useRef(0);
  const selectedCityRef = useRef<string | undefined>(undefined);
  const sessionTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setFormData({
      address: '',
      postalCode: '',
      floorNumber: '',
      notes: '',
    });
    setSuggestions([]);
    setSelectedAddressDetails(null);
    setAddressCoordinates(null);
    setValidationResult(null);
    setValidationStatus('idle');
    setValidationSnapshot(null);
    setIsValidatingDelivery(false);
    setOverrideApplied(false);
    setOverrideReason('');
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    searchRequestRef.current += 1;
    sessionTokenRef.current = null;
  }, [isOpen, customer.id]);

  useEffect(() => {
    invalidateAddressWork();
    selectedCityRef.current = undefined;
    return () => {
      searchRequestRef.current += 1;
      if (typedLocateTimerRef.current) clearTimeout(typedLocateTimerRef.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [isOpen, customer.id, hasDeliveryPro]);

  const clearValidation = (addressValue: string) => {
    const parsedAddress = parseSpecialAddressInput(addressValue);
    setSelectedAddressDetails(null);
    setAddressCoordinates(null);
    setValidationResult(null);
    setValidationSnapshot(null);
    setOverrideApplied(false);
    setOverrideReason('');

    if (!addressValue.trim()) {
      setValidationStatus('idle');
      return;
    }

    if (!hasDeliveryPro || parsedAddress.shouldSkipZoneValidation) {
      setValidationStatus('idle');
      return;
    }

    setValidationStatus('requires_selection');
    setValidationResult({
      success: true,
      isValid: false,
      deliveryAvailable: false,
      validation_status: 'requires_selection',
      requires_override: false,
      house_number_match: true,
      message: t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.'),
    });
  };

  const runValidation = async (
    address: string,
    details?: AddressSelectionDetails | null
  ): Promise<DeliveryValidationResult | null> => {
    const generation = searchRequestRef.current;
    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      return null;
    }

    if (parseSpecialAddressInput(trimmedAddress).shouldSkipZoneValidation) {
      const result: DeliveryValidationResult = {
        success: true,
        isValid: true,
        deliveryAvailable: true,
        validation_status: 'module_disabled',
        requires_override: false,
        house_number_match: true,
        message: t('modals.addCustomer.specialAddressModeTitle', 'Special address label detected'),
        address_fingerprint: buildAddressFingerprint(trimmedAddress),
      };
      setValidationResult(result);
      setValidationStatus('idle');
      setAddressCoordinates(null);
      setValidationSnapshot(result.address_fingerprint || buildAddressFingerprint(trimmedAddress));
      return result;
    }

    if (!hasDeliveryPro) {
      setValidationStatus('idle');
      return null;
    }

    const creds = await getResolvedTerminalCredentials();
    if (generation !== searchRequestRef.current) return null;
    const coords = details?.coordinates || addressCoordinates || undefined;
    const fallbackFingerprint = buildAddressFingerprint(trimmedAddress, coords);

    setIsValidatingDelivery(true);
    try {
      const result = await validateAddressForDelivery(trimmedAddress, {
        branchId: creds.branchId || undefined,
        orderAmount: 0,
        placeId: details?.placeId,
        coordinates: coords,
        inputStreetNumber: extractStreetNumber(trimmedAddress),
        resolvedStreetNumber: details?.resolvedStreetNumber,
        addressFingerprint: details?.addressFingerprint || fallbackFingerprint,
        validationSource: details?.validationSource,
      });

      if (generation !== searchRequestRef.current) return null;
      setValidationResult(result);
      setValidationStatus(result.validation_status);
      setValidationSnapshot(result.address_fingerprint || fallbackFingerprint);
      if (result.coordinates) {
        setAddressCoordinates(result.coordinates);
      } else if (coords) {
        setAddressCoordinates(coords);
      }
      if (result.validation_status === 'in_zone') {
        setOverrideApplied(false);
        setOverrideReason('');
      }

      return result;
    } catch (error) {
      if (generation !== searchRequestRef.current) return null;
      console.error('[AddNewAddressModal] validation error:', error);
      const fallback: DeliveryValidationResult = {
        success: false,
        isValid: false,
        deliveryAvailable: false,
        validation_status: 'unverified_offline',
        requires_override: true,
        house_number_match: true,
        message: t('modals.addCustomer.validationError'),
      };
      setValidationResult(fallback);
      setValidationStatus('unverified_offline');
      return fallback;
    } finally {
      if (generation === searchRequestRef.current) setIsValidatingDelivery(false);
    }
  };

  const ensureValidationForSubmit = async (): Promise<DeliveryValidationResult | null> => {
    const address = formData.address.trim();
    if (!address) {
      return null;
    }

    if (!hasDeliveryPro) {
      return null;
    }

    const coords = selectedAddressDetails?.coordinates || addressCoordinates || undefined;
    const currentFingerprint = buildAddressFingerprint(address, coords);

    if (validationResult && validationSnapshot === currentFingerprint) {
      return validationResult;
    }

    return runValidation(address, selectedAddressDetails);
  };

  const evaluateValidationDecision = (result: DeliveryValidationResult | null): string | null => {
    if (!hasDeliveryPro) {
      return null;
    }

    if (!result) {
      return t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.');
    }

    if (result.validation_status === 'in_zone' || result.validation_status === 'module_disabled') {
      return null;
    }

    if (result.validation_status === 'requires_selection') {
      return t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.');
    }

    if (result.validation_status === 'out_of_zone' || result.validation_status === 'unverified_offline') {
      if (!overrideApplied) {
        return t('modals.addCustomer.outOfZoneOverrideRequired', 'Accept override and provide a reason to continue.');
      }
      if (overrideReason.trim().length < 6) {
        return t('modals.addCustomer.overrideReasonRequired', 'Override reason must be at least 6 characters.');
      }
      return null;
    }

    return t('modals.addCustomer.validationError');
  };

  const searchAddresses = async (input: string, requestId: number) => {
    if (!hasDeliveryPro) {
      setSuggestions([]);
      setIsLoadingAddresses(false);
      return;
    }

    try {
      const creds = await getResolvedTerminalCredentials();
      await ensureAddressOfflineRuntime(creds.branchId || undefined);

      const results = await searchAddressSuggestions(input, {
        branchId: creds.branchId || undefined,
        limit: 5,
        sessionToken: sessionTokenRef.current || undefined,
      });

      if (requestId !== searchRequestRef.current) {
        return;
      }
      setSuggestions(results);
    } catch (error) {
      if (requestId !== searchRequestRef.current) {
        return;
      }
      console.error('[AddNewAddressModal] search error:', error);
      setSuggestions([]);
    } finally {
      if (requestId === searchRequestRef.current) {
        setIsLoadingAddresses(false);
      }
    }
  };

  const scheduleAddressSearch = (input: string) => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    if (!hasDeliveryPro) {
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
      setIsLoadingAddresses(false);
      setSuggestions([]);
      return;
    }

    if (input.length < 3) {
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
      setIsLoadingAddresses(false);
      setSuggestions([]);
      return;
    }

    const requestId = ++searchRequestRef.current;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = createAddressSessionToken();
    }
    setIsLoadingAddresses(true);
    searchDebounceRef.current = setTimeout(() => {
      void searchAddresses(input, requestId);
    }, 200);
  };

  const handleSuggestionClick = async (suggestion: AddressSuggestion) => {
    invalidateAddressWork();
    const generation = searchRequestRef.current;
    const sessionToken = sessionTokenRef.current;
    sessionTokenRef.current = null;
    try {
      const creds = await getResolvedTerminalCredentials();
      if (generation !== searchRequestRef.current) return;
      const resolved = await resolveAddressSuggestion(suggestion, formData.address, {
        branchId: creds.branchId || undefined,
        sessionToken: sessionToken || undefined,
      });

      if (generation !== searchRequestRef.current) return;
      void upsertVerifiedLocalCandidate({
        place_id: resolved.placeId || suggestion.place_id,
        branch_id: creds.branchId || undefined,
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

      const details: AddressSelectionDetails = {
        city: resolved.city || undefined,
        postalCode: resolved.postalCode || undefined,
        coordinates: resolved.coordinates,
        placeId: resolved.placeId || suggestion.place_id,
        resolvedStreetNumber: resolved.resolvedStreetNumber,
        addressFingerprint: resolved.addressFingerprint,
        validationSource: resolved.validationSource,
        fromSuggestion: true,
      };

      setFormData((prev) => ({
        ...prev,
        address: resolved.streetAddress,
        postalCode: resolved.postalCode || prev.postalCode,
      }));
      selectedCityRef.current = details.city;
      setSelectedAddressDetails(details);
      setMapStreetName(streetNamesDiffer(resolved.streetAddress, resolved.route) ? resolved.route! : null);
      setAddressCoordinates(details.coordinates || null);
      setSuggestions([]);
      sessionTokenRef.current = null;

      await runValidation(resolved.streetAddress, details);
    } catch (error) {
      if (generation !== searchRequestRef.current) return;
      console.error('[AddNewAddressModal] details error:', error);
      const fallback =
        getSuggestionStreetLabel(suggestion) ||
        String(suggestion?.formatted_address || '').split(',')[0] ||
        String(suggestion?.formatted_address || '');

      setFormData((prev) => ({ ...prev, address: fallback }));
      setSuggestions([]);
      sessionTokenRef.current = null;
      clearValidation(fallback);
    }
  };

  const scheduleTypedLocation = (fields: { street: string; city?: string; postalCode: string }) => {
    if (!isOpen || !hasDeliveryPro || !navigator.onLine || !extractStreetNumber(fields.street)
      || parseSpecialAddressInput(fields.street).shouldSkipZoneValidation) return;
    const generation = searchRequestRef.current;
    typedLocateTimerRef.current = setTimeout(async () => {
      if (generation !== searchRequestRef.current || !navigator.onLine) return;
      setIsValidatingDelivery(true);
      try {
        const creds = await getResolvedTerminalCredentials();
        if (generation !== searchRequestRef.current) return;
        const result = await locateTypedAddress(fields, { branchId: creds.branchId || undefined });
        if (generation !== searchRequestRef.current || !navigator.onLine || !result.located) return;
        setSelectedAddressDetails({ ...result.details, city: fields.city, postalCode: fields.postalCode });
        setAddressCoordinates(result.details.coordinates || null);
        setProviderPostalCode(result.postalCodeDiffers ? result.providerPostalCode || null : null);
        setMapStreetName(streetNamesDiffer(fields.street, result.details.route) ? result.details.route! : null);
        await runValidation(fields.street, result.details);
      } catch {
        // Keep requires_selection when the provider or an old server cannot locate it.
      } finally {
        if (generation === searchRequestRef.current) setIsValidatingDelivery(false);
      }
    }, 700);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));

    if (field === 'address') {
      selectedCityRef.current = undefined;
      invalidateAddressWork();
      scheduleAddressSearch(value);
      clearValidation(value);
    } else if (field === 'postalCode') {
      const city = selectedAddressDetails?.city || selectedCityRef.current;
      invalidateAddressWork();
      clearValidation(formData.address);
      scheduleTypedLocation({ street: formData.address, city, postalCode: value });
    }
  };

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
    };
  }, []);

  const handleSubmit = async () => {
    if (!formData.address.trim()) {
      alert(t('modals.addNewAddress.addressRequired'));
      return;
    }

    const generation = searchRequestRef.current;
    const validation = await ensureValidationForSubmit();
    if (generation !== searchRequestRef.current) return;
    const decisionError = evaluateValidationDecision(validation);
    if (decisionError) {
      alert(decisionError);
      return;
    }

    setIsSubmitting(true);
    try {
      const isSpecialAddress = parseSpecialAddressInput(formData.address).shouldSkipZoneValidation;
      // Keep exact selected suggestion coordinates when persisting.
      const coords = hasDeliveryPro
        && !isSpecialAddress
        ? selectedAddressDetails?.coordinates || addressCoordinates || validation?.coordinates || null
        : null;
      const metadata = hasDeliveryPro
        ? {
            override_applied: overrideApplied,
            override_reason: overrideApplied ? overrideReason.trim() : null,
            validation_status: validation?.validation_status || null,
            zone_id: validation?.selectedZone?.id || null,
            validated_at: validation ? new Date().toISOString() : null,
            validation_source: validation?.validation_source || null,
            address_fingerprint:
              validation?.address_fingerprint
              || validationSnapshot
              || buildAddressFingerprint(formData.address.trim(), coords || undefined),
            place_id: selectedAddressDetails?.placeId || null,
            input_street_number: extractStreetNumber(formData.address.trim()) || null,
            resolved_street_number: selectedAddressDetails?.resolvedStreetNumber || null,
          }
        : {};

      const addressResult = await bridge.customers.addAddress(customer.id, {
        street: formData.address.trim(),
        street_address: formData.address.trim(),
        address: formData.address.trim(),
        postal_code: formData.postalCode.trim() || undefined,
        floor_number: formData.floorNumber.trim() || undefined,
        notes: formData.notes.trim() || undefined,
        address_type: 'delivery',
        is_default: false,
        coordinates: coords || undefined,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        ...metadata,
      });

      // A refused address (INVALID_COORDINATES, a customer the office no
      // longer has, this register's own refusals) is named; its `error` is a
      // machine code and is never shown. A queued write (office unreachable)
      // is saved on this register and counts as added.
      expectCustomerAddressWrite(t, addressResult, 'add', ADDRESS_SAVE_FAILED_KEY);

      onAddressAdded(
        customer,
        formData.address.trim(),
        formData.postalCode.trim() || undefined,
        formData.floorNumber.trim() || undefined,
        formData.notes.trim() || undefined
      );

      handleClose();
    } catch (error) {
      console.error('Error adding new address:', error);
      // Never a native error's raw text: the refusal's own message, else the generic one.
      alert(customerAddressWriteErrorText(t, error, ADDRESS_SAVE_FAILED_KEY));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  const fieldClass =
    'liquid-glass-modal-input pos-glass-field min-h-touch w-full px-4 py-2.5';
  const addressFieldClass = `${fieldClass} pl-10`;

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.addNewAddress.title')}
      size="lg"
      className="max-w-2xl! pos-progressive-form [&_.liquid-glass-modal-header]:border-b-0!"

    >
      <div className="space-y-3">
        <p className="liquid-glass-modal-text-muted text-sm">
          {t('modals.addNewAddress.subtitle', { name: customer.name })}
        </p>

        <div className="pos-glass-form-card">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl liquid-glass-modal-text-muted">
              <User className="w-5 h-5" />
            </div>
            <div>
              <p className="font-medium liquid-glass-modal-text">{customer.name}</p>
              <p className="text-sm liquid-glass-modal-text-muted">📞 {customer.phone}</p>
              {customer.email && (
                <p className="text-sm liquid-glass-modal-text-muted flex items-center gap-2">
                  <Mail className="w-4 h-4" aria-hidden="true" />
                  <span>{customer.email}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="pos-glass-form-card space-y-3">
          <div className="relative">
            <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
              {t('modals.addNewAddress.address')}
            </label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={formData.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={
                  hasDeliveryPro
                    ? t('modals.addNewAddress.addressPlaceholder')
                    : t('modals.addNewAddress.manualAddressPlaceholder')
                }
                className={addressFieldClass}
                required
              />
              {hasDeliveryPro && isLoadingAddresses && (
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-(--pos-s-border) border-t-yellow-400 rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            {!hasDeliveryPro && (
              <p className="mt-2 text-xs liquid-glass-modal-text-muted">
                {t('modals.addNewAddress.manualAddressEntryHint')}
              </p>
            )}

            {hasDeliveryPro && suggestions.length > 0 && (
              <div className="absolute z-10 w-full mt-1 pos-glass-form-card p-2! space-y-2 shadow-lg max-h-48 overflow-y-auto scrollbar-hide">
                {suggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    key={suggestion.place_id || index}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="pos-glass-tap-card min-h-touch w-full px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-yellow-400"
                  >
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-gray-400 mt-1 shrink-0" />
                      <div>
                        <p className="text-sm font-medium liquid-glass-modal-text">
                          {getSuggestionStreetLabel(suggestion)}
                        </p>
                        <p className="text-xs liquid-glass-modal-text-muted">
                          {suggestion.secondary_text || suggestion.formatted_address}
                          {formatAddressDistance(suggestion.distance_meters, i18n?.resolvedLanguage || i18n?.language) && ` · ${formatAddressDistance(suggestion.distance_meters, i18n?.resolvedLanguage || i18n?.language)}`}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {mapStreetName && <p className="mt-1 text-xs liquid-glass-modal-text-muted">{t('modals.addCustomer.mapStreetNameDiffers', { street: mapStreetName })}</p>}

          <AnimatePresence initial={false}>

            {hasDeliveryPro && validationResult && (
            <motion.div {...revealMotion} key="reveal-1" className="pos-glass-form-card space-y-3">
              <div className="text-sm font-medium liquid-glass-modal-text flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                {t('modals.addCustomer.deliveryValidation')}
              </div>

              {isValidatingDelivery && (
                <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-300 text-sm">
                  <Clock className="w-4 h-4 animate-spin" />
                  {t('modals.addCustomer.validatingAddress')}
                </div>
              )}

              {!isValidatingDelivery && (validationStatus === 'in_zone' || validationStatus === 'module_disabled') && (
                <div className="flex items-center gap-2 text-green-500 text-sm">
                  <CheckCircle className="w-4 h-4" />
                  {t('modals.addCustomer.deliveryAvailable')}
                </div>
              )}

              {!isValidatingDelivery && validationStatus !== 'in_zone' && (
                <div className={`flex items-center gap-2 text-sm ${validationStatus === 'unverified_offline' ? 'text-yellow-500' : 'text-red-500'}`}>
                  <AlertTriangle className="w-4 h-4" />
                  <span>
                    {validationResult.message
                      || (validationStatus === 'requires_selection'
                        ? t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.')
                        : t('modals.addCustomer.addressOutsideArea'))}
                  </span>
                </div>
              )}

              <AnimatePresence initial={false}>

                {(validationStatus === 'out_of_zone' || validationStatus === 'unverified_offline') && (
                <motion.div {...revealMotion} key="reveal-5" className="pos-glass-form-card p-3! space-y-2">
                  <label className="flex min-h-touch items-center gap-2 text-sm liquid-glass-modal-text">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-yellow-400"
                      checked={overrideApplied}
                      onChange={(e) => setOverrideApplied(e.target.checked)}
                    />
                    {validationStatus === 'out_of_zone'
                      ? t('modals.addCustomer.acceptOutOfZone', 'Accept out-of-zone delivery')
                      : t('modals.addCustomer.acceptOfflineUnverified', 'Accept offline unverified delivery')}
                  </label>
                  <textarea
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder={t('modals.addCustomer.overrideReasonPlaceholder', 'Add override reason (minimum 6 characters)')}
                    rows={2}
                    className={`${fieldClass} resize-none`}
                  />
                </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
              {t('modals.addNewAddress.postalCode')}
            </label>
            <input
              type="text"
              value={formData.postalCode}
              onChange={(e) => handleInputChange('postalCode', e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('modals.addNewAddress.postalPlaceholder')}
              className={fieldClass}
            />
            {providerPostalCode && <p className="mt-1 text-xs liquid-glass-modal-text-muted">{t('modals.addCustomer.mapPostalCodeDiffers', { code: providerPostalCode })}</p>}
          </div>

          <div>
            <FloorPresetPicker
              value={formData.floorNumber}
              onChange={(value) => handleInputChange('floorNumber', value)}
              onKeyPress={handleKeyPress}
              label={t('modals.addNewAddress.floorNumber')}
              placeholder={t('modals.addNewAddress.floorPlaceholder')}
              maxLength={100}
              inputClassName={fieldClass}
            />
            {(formData.floorNumber?.length ?? 0) >= 100 && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('common.validation.maxLength', { count: 100 })}
              </p>
            )}
          </div>

          </div>
          <div className="pos-glass-form-card">
            <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
              {t('modals.addNewAddress.deliveryNotes')}
            </label>
            <textarea
              value={formData.notes}
              onChange={(e) => handleInputChange('notes', e.target.value)}
              placeholder={t('modals.addNewAddress.notesPlaceholder')}
              rows={3}
              className={`${fieldClass} resize-none`}
            />
          </div>
        </div>


        <div className="px-6 pb-5 pt-2">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl"
          >
            {t('modals.addNewAddress.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || isValidatingDelivery || !formData.address.trim()}
            className="liquid-glass-modal-button liquid-glass-modal-success flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
          >
            <Home className="w-5 h-5" />
            {isSubmitting ? t('modals.addNewAddress.adding') : t('modals.addNewAddress.addAddress')}
          </button>
        </div>

        <p className="text-xs liquid-glass-modal-text-muted mt-3 text-center">
          {t('modals.addNewAddress.helpText')}
        </p>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

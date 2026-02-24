import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Clock, Home, Mail, MapPin, User } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { posApiPost } from '../../utils/api-helpers';
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
import { getResolvedTerminalCredentials } from '../../services/terminal-credentials';

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
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    address: '',
    postalCode: '',
    floorNumber: '',
    notes: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [selectedAddressDetails, setSelectedAddressDetails] = useState<AddressSelectionDetails | null>(null);
  const [addressCoordinates, setAddressCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [validationResult, setValidationResult] = useState<DeliveryValidationResult | null>(null);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus | 'idle'>('idle');
  const [validationSnapshot, setValidationSnapshot] = useState<string | null>(null);
  const [isValidatingDelivery, setIsValidatingDelivery] = useState(false);
  const [overrideApplied, setOverrideApplied] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
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
  }, [isOpen]);

  const clearValidation = (addressValue: string) => {
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
    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      return null;
    }

    const creds = await getResolvedTerminalCredentials();
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
      setIsValidatingDelivery(false);
    }
  };

  const ensureValidationForSubmit = async (): Promise<DeliveryValidationResult | null> => {
    const address = formData.address.trim();
    if (!address) {
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
    if (!result) {
      return t('modals.addCustomer.selectAddressForValidation', 'Select a real address from suggestions to validate delivery.');
    }

    if (result.validation_status === 'in_zone') {
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
    try {
      const creds = await getResolvedTerminalCredentials();
      await ensureAddressOfflineRuntime(creds.branchId || undefined);

      const results = await searchAddressSuggestions(input, {
        branchId: creds.branchId || undefined,
        limit: 5,
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

    if (input.length < 3) {
      searchRequestRef.current += 1;
      setIsLoadingAddresses(false);
      setSuggestions([]);
      return;
    }

    const requestId = ++searchRequestRef.current;
    setIsLoadingAddresses(true);
    searchDebounceRef.current = setTimeout(() => {
      void searchAddresses(input, requestId);
    }, 200);
  };

  const handleSuggestionClick = async (suggestion: any) => {
    try {
      const creds = await getResolvedTerminalCredentials();
      const resolved = await resolveAddressSuggestion(suggestion, formData.address, {
        branchId: creds.branchId || undefined,
      });

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
      setSelectedAddressDetails(details);
      setAddressCoordinates(details.coordinates || null);
      setSuggestions([]);

      await runValidation(resolved.streetAddress, details);
    } catch (error) {
      console.error('[AddNewAddressModal] details error:', error);
      const fallback =
        suggestion?.name ||
        String(suggestion?.formatted_address || '').split(',')[0] ||
        String(suggestion?.formatted_address || '');

      setFormData((prev) => ({ ...prev, address: fallback }));
      setSuggestions([]);
      clearValidation(fallback);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));

    if (field === 'address') {
      scheduleAddressSearch(value);
      clearValidation(value);
    }
  };

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      searchRequestRef.current += 1;
    };
  }, []);

  const handleSubmit = async () => {
    if (!formData.address.trim()) {
      alert(t('modals.addNewAddress.addressRequired'));
      return;
    }

    const validation = await ensureValidationForSubmit();
    const decisionError = evaluateValidationDecision(validation);
    if (decisionError) {
      alert(decisionError);
      return;
    }

    setIsSubmitting(true);
    try {
      // Keep exact selected suggestion coordinates when persisting.
      const coords = selectedAddressDetails?.coordinates || addressCoordinates || validation?.coordinates || null;
      const metadata = {
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
      };

      const addressResult = await posApiPost<any>(`pos/customers/${customer.id}/addresses`, {
        street: formData.address.trim(),
        street_address: formData.address.trim(),
        address: formData.address.trim(),
        postal_code: formData.postalCode.trim() || undefined,
        floor_number: formData.floorNumber.trim() || undefined,
        notes: formData.notes.trim() || undefined,
        address_type: 'delivery',
        is_default: false,
        coordinates: coords,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        ...metadata,
      });

      if (!addressResult.success) {
        throw new Error(addressResult.error || t('modals.addNewAddress.saveFailed'));
      }

      onAddressAdded(
        customer,
        formData.address.trim(),
        formData.postalCode.trim() || undefined,
        formData.floorNumber.trim() || undefined,
        formData.notes.trim() || undefined
      );

      onClose();
    } catch (error) {
      console.error('Error adding new address:', error);
      alert(t('modals.addNewAddress.addFailed', { error: error instanceof Error ? error.message : t('modals.addNewAddress.unknownError') }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.addNewAddress.title')}
      size="lg"
      className="!max-w-2xl"
    >
      <div className="p-6">
        <p className="liquid-glass-modal-text-muted mb-6">
          {t('modals.addNewAddress.subtitle', { name: customer.name })}
        </p>

        <div className="mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
          <div className="flex items-center gap-3">
            <User className="w-5 h-5 text-blue-600 dark:text-blue-400" />
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

        <div className="space-y-4">
          <div className="relative">
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.addNewAddress.address')}
            </label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={formData.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={t('modals.addNewAddress.addressPlaceholder')}
                className="w-full px-4 py-2 pl-10 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              {isLoadingAddresses && (
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            {suggestions.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border liquid-glass-modal-border rounded-xl shadow-lg max-h-48 overflow-y-auto">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.place_id || index}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="w-full px-4 py-3 text-left hover:bg-blue-500/10 transition-colors border-b border-gray-200/20 dark:border-gray-700/20 last:border-b-0"
                  >
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-gray-400 mt-1 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium liquid-glass-modal-text">
                          {suggestion.name}
                        </p>
                        <p className="text-xs liquid-glass-modal-text-muted">
                          {suggestion.formatted_address}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {validationResult && (
            <div className="liquid-glass-modal-card space-y-3">
              <div className="text-sm font-medium liquid-glass-modal-text flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                {t('modals.addCustomer.deliveryValidation')}
              </div>

              {isValidatingDelivery && (
                <div className="flex items-center gap-2 text-blue-500 text-sm">
                  <Clock className="w-4 h-4 animate-spin" />
                  {t('modals.addCustomer.validatingAddress')}
                </div>
              )}

              {!isValidatingDelivery && validationStatus === 'in_zone' && (
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

              {(validationStatus === 'out_of_zone' || validationStatus === 'unverified_offline') && (
                <div className="space-y-2 rounded-lg border border-orange-500/30 bg-orange-500/10 p-3">
                  <label className="flex items-center gap-2 text-sm text-orange-200">
                    <input
                      type="checkbox"
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
                    className="w-full px-3 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                  />
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.addNewAddress.postalCode')}
            </label>
            <input
              type="text"
              value={formData.postalCode}
              onChange={(e) => handleInputChange('postalCode', e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('modals.addNewAddress.postalPlaceholder')}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.addNewAddress.floorNumber')}
            </label>
            <input
              type="text"
              value={formData.floorNumber}
              onChange={(e) => handleInputChange('floorNumber', e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('modals.addNewAddress.floorPlaceholder')}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.addNewAddress.deliveryNotes')}
            </label>
            <textarea
              value={formData.notes}
              onChange={(e) => handleInputChange('notes', e.target.value)}
              placeholder={t('modals.addNewAddress.notesPlaceholder')}
              rows={3}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-gray-500/10 hover:bg-gray-500/20 liquid-glass-modal-text font-medium rounded-xl border border-gray-500/20 transition-all"
          >
            {t('modals.addNewAddress.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !formData.address.trim()}
            className="flex-1 px-4 py-3 bg-blue-500/20 hover:bg-blue-500/30 disabled:bg-gray-500/10 disabled:cursor-not-allowed text-blue-600 dark:text-blue-400 disabled:text-gray-500 font-medium rounded-xl border border-blue-500/30 disabled:border-gray-500/20 transition-all flex items-center justify-center gap-2"
          >
            <Home className="w-5 h-5" />
            {isSubmitting ? t('modals.addNewAddress.adding') : t('modals.addNewAddress.addAddress')}
          </button>
        </div>

        <p className="text-xs liquid-glass-modal-text-muted mt-3 text-center">
          {t('modals.addNewAddress.helpText')}
        </p>
      </div>
    </LiquidGlassModal>
  );
};

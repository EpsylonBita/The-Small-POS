import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock, MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
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

interface CustomerInfo {
  name: string;
  phone: string;
  address: string;
  postal_code?: string;
  notes?: string;
}

interface EditCustomerInfoModalProps {
  isOpen: boolean;
  orderCount: number;
  initialCustomerInfo: CustomerInfo;
  onSave: (customerInfo: CustomerInfo) => void;
  onClose: () => void;
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

export const EditCustomerInfoModal: React.FC<EditCustomerInfoModalProps> = ({
  isOpen,
  orderCount,
  initialCustomerInfo,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>(initialCustomerInfo);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<any[]>([]);
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
    if (!isOpen) {
      return;
    }

    setCustomerInfo(initialCustomerInfo);
    setAddressSuggestions([]);
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
  }, [isOpen, initialCustomerInfo]);

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
      console.error('[EditCustomerInfoModal] validation error:', error);
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
    const address = customerInfo.address.trim();
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
      setAddressSuggestions(results);
    } catch (error) {
      if (requestId !== searchRequestRef.current) {
        return;
      }
      console.error('Error searching addresses:', error);
      setAddressSuggestions([]);
      toast.error(t('modals.editCustomer.addressSuggestionsFailed'));
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
      setAddressSuggestions([]);
      return;
    }

    const requestId = ++searchRequestRef.current;
    setIsLoadingAddresses(true);
    searchDebounceRef.current = setTimeout(() => {
      void searchAddresses(input, requestId);
    }, 200);
  };

  const handleAddressSuggestionClick = async (suggestion: any) => {
    try {
      const creds = await getResolvedTerminalCredentials();
      const resolved = await resolveAddressSuggestion(suggestion, customerInfo.address, {
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

      setCustomerInfo((prev) => ({
        ...prev,
        address: resolved.streetAddress,
        postal_code: resolved.postalCode || prev.postal_code,
      }));
      setSelectedAddressDetails(details);
      setAddressCoordinates(details.coordinates || null);
      setAddressSuggestions([]);

      await runValidation(resolved.streetAddress, details);
      toast.success(t('modals.editCustomer.addressAndPostalUpdated'));
    } catch (error) {
      console.error('Error getting place details:', error);
      const fallback =
        suggestion?.name ||
        String(suggestion?.formatted_address || '').split(',')[0] ||
        String(suggestion?.formatted_address || '');

      setCustomerInfo((prev) => ({
        ...prev,
        address: fallback,
      }));
      setAddressSuggestions([]);
      clearValidation(fallback);
      toast.success(t('modals.editCustomer.addressUpdated'));
    }
  };

  const handleSave = async () => {
    if (!customerInfo.name.trim()) {
      toast.error(t('modals.editCustomer.nameRequired'));
      return;
    }

    if (!customerInfo.phone.trim()) {
      toast.error(t('modals.editCustomer.phoneRequired'));
      return;
    }

    const validation = await ensureValidationForSubmit();
    const decisionError = evaluateValidationDecision(validation);
    if (decisionError) {
      toast.error(decisionError);
      return;
    }

    setIsSaving(true);
    try {
      // Keep exact selected suggestion coordinates when persisting.
      const coords = selectedAddressDetails?.coordinates || addressCoordinates || validation?.coordinates || null;
      const payload = {
        ...customerInfo,
        coordinates: coords,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        delivery_validation: validation ? {
          override_applied: overrideApplied,
          override_reason: overrideApplied ? overrideReason.trim() : null,
          validation_status: validation.validation_status,
          zone_id: validation.selectedZone?.id || null,
          validated_at: new Date().toISOString(),
          validation_source: validation.validation_source || null,
          address_fingerprint:
            validation.address_fingerprint
            || validationSnapshot
            || buildAddressFingerprint(customerInfo.address.trim(), coords || undefined),
          place_id: selectedAddressDetails?.placeId || null,
          input_street_number: extractStreetNumber(customerInfo.address.trim()) || null,
          resolved_street_number: selectedAddressDetails?.resolvedStreetNumber || null,
        } : null,
      };
      onSave(payload as any);
      setIsSaving(false);
    } catch (error) {
      setIsSaving(false);
      toast.error(t('modals.editCustomer.saveFailed'));
    }
  };

  const handleClose = () => {
    setCustomerInfo(initialCustomerInfo);
    setAddressSuggestions([]);
    setSelectedAddressDetails(null);
    setAddressCoordinates(null);
    setValidationResult(null);
    setValidationStatus('idle');
    setValidationSnapshot(null);
    setOverrideApplied(false);
    setOverrideReason('');
    onClose();
  };

  const handleInputChange = (field: keyof CustomerInfo, value: string) => {
    setCustomerInfo((prev) => ({
      ...prev,
      [field]: value,
    }));

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

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.editCustomer.title')}
      size="xl"
      className="!max-w-3xl"
    >
      <div className="overflow-y-auto max-h-[70vh]">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          {t('modals.editCustomer.updateMessage', { count: orderCount })}
        </p>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.editCustomer.customerName')}
            </label>
            <input
              type="text"
              value={customerInfo.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              placeholder={t('modals.editCustomer.customerNamePlaceholder')}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.editCustomer.phoneNumber')}
            </label>
            <input
              type="tel"
              value={customerInfo.phone}
              onChange={(e) => handleInputChange('phone', e.target.value)}
              placeholder={t('modals.editCustomer.phoneNumberPlaceholder')}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="relative">
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.editCustomer.address')}
            </label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={customerInfo.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                placeholder={t('modals.editCustomer.addressPlaceholder')}
                className="w-full px-4 py-2 pl-10 pr-4 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {isLoadingAddresses && (
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            {addressSuggestions.length > 0 && (
              <div className="absolute z-60 w-full mt-1 bg-white/90 dark:bg-gray-800/90 border liquid-glass-modal-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {addressSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.place_id || index}
                    onClick={() => handleAddressSuggestionClick(suggestion)}
                    className="w-full px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors border-b border-gray-200 dark:border-gray-600 last:border-b-0"
                  >
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-gray-400 mt-1 flex-shrink-0" />
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
              {t('modals.editCustomer.postalCode')}
              {customerInfo.postal_code && (
                <span className="text-green-600 dark:text-green-400 text-xs ml-2">{t('modals.editCustomer.autoFilled')}</span>
              )}
            </label>
            <input
              type="text"
              value={customerInfo.postal_code || ''}
              onChange={(e) => handleInputChange('postal_code', e.target.value)}
              placeholder={t('modals.editCustomer.postalCodePlaceholder')}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('modals.editCustomer.specialNotes')}
            </label>
            <textarea
              value={customerInfo.notes || ''}
              onChange={(e) => handleInputChange('notes', e.target.value)}
              placeholder={t('modals.editCustomer.specialNotesPlaceholder')}
              rows={3}
              className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 px-4 py-3 bg-gray-500/10 hover:bg-gray-500/20 liquid-glass-modal-text font-medium rounded-xl border border-gray-500/20 transition-all"
          >
            {t('modals.editCustomer.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="flex-1 px-4 py-3 bg-blue-500/20 hover:bg-blue-500/30 disabled:bg-gray-500/10 disabled:cursor-not-allowed text-blue-600 dark:text-blue-400 disabled:text-gray-500 font-medium rounded-xl border border-blue-500/30 disabled:border-gray-500/20 transition-all"
          >
            {isSaving ? t('modals.editCustomer.saving') : t('modals.editCustomer.saveChanges')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default EditCustomerInfoModal;

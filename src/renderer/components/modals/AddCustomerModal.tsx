import React, { useState, useRef, useEffect } from 'react';
import { MapPin, User, Phone, Mail, FileText, Building, Users, AlertTriangle, CheckCircle, Clock, Hash, Minus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CountryCode } from 'libphonenumber-js/min';
import {
  CUSTOMER_PHONE_MAX_CHARACTERS,
  describeExpectedPhoneLengths,
  isCustomerPhoneRejectionShownWhileTyping,
  resolveCustomerPhoneEdit,
  toSupportedPhoneCountry,
  validateCustomerPhoneInput,
  type CustomerPhoneInputRejected,
  type CustomerPhoneInputResult,
} from '../../../../../shared/services/phone-input-validation';
import {
  extractSavedAddressCoordinates,
  toValidLatLng,
  type LatLng,
} from '../../../../../shared/utils/saved-address-coordinates';
import { Customer } from '../../../shared/types/customer';
import { customerService } from '../../services/CustomerService';
import { normalizeCustomerWriteResult } from '../../services/customer-write-result';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useTheme } from '../../contexts/theme-context';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  buildAddressFingerprint,
  createAddressSessionToken,
  ensureAddressOfflineRuntime,
  extractStreetNumber,
  getSuggestionStreetLabel,
  resolveAddressSuggestion,
  searchAddressSuggestions,
  upsertVerifiedLocalCandidate,
  validateAddressForDelivery,
  type AddressSuggestion,
  type DeliveryValidationResult,
  type ValidationStatus,
} from '../../services/address-workflow';
import {
  getResolvedTerminalCredentials,
} from '../../services/terminal-credentials';
import { parseSpecialAddressInput } from '../../utils/specialAddress';
import { MODULE_IDS, useAcquiredModules } from '../../hooks/useAcquiredModules';
import { FloorPresetPicker } from '../forms/FloorPresetPicker';

import { inputBase } from '../../styles/designSystem';

interface CustomerData {
  id?: string;
  phone: string;
  phone_country_code?: string | null;
  name?: string;
  email?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  name_on_ringer?: string;
  selected_address_id?: string | null;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude?: number | null;
  longitude?: number | null;
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
  /** Caller ID keeps this form mounted while its floating panel is minimized. */
  callerIdWorkspace?: {
    suspended: boolean;
    onMinimize: () => void;
  };
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string, details?: AddressSelectionDetails) => void;
  placeholder?: string;
  className?: string;
  searchEnabled?: boolean;
  /** Incremented by "pick the address again": focus the field and search `repickQuery`. */
  repickSignal?: number;
  repickQuery?: string;
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

const normalizePhoneCountryCode = (value: unknown): string => toSupportedPhoneCountry(value) ?? '';

const isInternationalPhone = (value: string): boolean => {
  const normalized = value.trim();
  return normalized.startsWith('+') || normalized.startsWith('00');
};

// Founder (05/09/2026): the operator never sees an ISO country field. A
// national number belongs to the STORE's country — the branch's
// `phone_country_code`, which the settings sync caches on this terminal as
// `restaurant.phone_country_code` (src-tauri/src/terminal_helpers.rs).
// International numbers carry their own +prefix and are sent exactly as typed.
// GR is only the fallback for a terminal that has not cached its branch
// country yet: it is what this form always used before and what the server's
// POS routes assume for a national number without a country
// (admin-dashboard/src/lib/pos-phone-country.ts), so such a terminal behaves
// exactly as it did before the store country was read.
const STORE_PHONE_COUNTRY_FALLBACK: CountryCode = 'GR';

type TranslateFn = ReturnType<typeof useTranslation>['t'];

/**
 * The phone field's verdict, from the shared rule both POS apps use
 * (shared/services/phone-input-validation.ts).
 *
 * Incident 2026-09-28 (Tomikro): an 11-digit mobile passed this form (it only
 * checked "not empty"), the office refused it and the queued customer blocked
 * the Z. Now the field turns red with «must have 10 digits (you entered 11)».
 *
 * Editing: validate and submit with ONE country — the customer's stored
 * country while the phone is unchanged, else the store's. An unchanged stored
 * phone never blocks the save (a few legacy phones fail today's rule) and is
 * left out of the update, so the office does not re-read it.
 */
interface PhoneAssessment {
  /** Country the number was read in; submitted as `phone_country_code` for national input. */
  country: CountryCode;
  result: CustomerPhoneInputResult;
  /** Edit mode: the phone equals the stored one. */
  unchanged: boolean;
  blocksSave: boolean;
}

const assessCustomerPhone = (input: {
  editing: boolean;
  phone: string;
  storeCountry: CountryCode;
  initialPhone?: string | null;
  initialCountry?: string | null;
}): PhoneAssessment => {
  if (input.editing) {
    const decision = resolveCustomerPhoneEdit({
      phone: input.phone,
      initialPhone: input.initialPhone,
      initialCountry: input.initialCountry,
      storeCountry: input.storeCountry,
    });
    return {
      country: decision.country ?? input.storeCountry,
      result: decision.result,
      unchanged: decision.unchanged,
      blocksSave: decision.blocksSave,
    };
  }
  const result = validateCustomerPhoneInput(input.phone, input.storeCountry);
  return { country: input.storeCountry, result, unchanged: false, blocksSave: !result.ok };
};

/** «Phone number must have 10 digits (you entered 11)» and the other rejections. */
const describePhoneRejection = (t: TranslateFn, result: CustomerPhoneInputRejected): string => {
  switch (result.reason) {
    case 'EMPTY':
      return t('modals.addCustomer.phoneRequired');
    case 'INVALID_CHARACTERS':
      return t('modals.addCustomer.phoneInvalidCharacters');
    case 'TOO_WIDE':
      return t('modals.addCustomer.phoneTooWide', { max: CUSTOMER_PHONE_MAX_CHARACTERS });
    case 'TOO_SHORT':
    case 'TOO_LONG': {
      // Interpolation names avoid `count`, so i18next never looks up plurals.
      const expected = describeExpectedPhoneLengths(result.expectedLengths);
      if (expected?.kind === 'exact') {
        return t('modals.addCustomer.phoneLengthExact', {
          expected: expected.count,
          entered: result.enteredDigits,
        });
      }
      if (expected?.kind === 'either') {
        return t('modals.addCustomer.phoneLengthEither', {
          first: expected.a,
          second: expected.b,
          entered: result.enteredDigits,
        });
      }
      if (expected?.kind === 'range') {
        return t('modals.addCustomer.phoneLengthRange', {
          min: expected.min,
          max: expected.max,
          entered: result.enteredDigits,
        });
      }
      return t('modals.addCustomer.phoneInvalid');
    }
    default:
      // INVALID (a plausible length that is no number of that country) and
      // COUNTRY_REQUIRED (unreachable here: the store country always resolves).
      return t('modals.addCustomer.phoneInvalid');
  }
};

/** An error whose message is already the operator's text, shown where it belongs. */
class CustomerFormError extends Error {
  constructor(
    readonly field: 'submit' | 'phone' | 'address',
    message: string,
  ) {
    super(message);
    this.name = 'CustomerFormError';
  }
}

/**
 * A customer or address write that was refused (`success:false`, see
 * CustomerService.CustomerWriteResult): the form shows it and stays open —
 * nothing was saved or queued on this register.
 *
 * Office refusals carry the HTTP status; this register's own refusals
 * (VERSION_REQUIRED, CUSTOMER_SYNC_IN_PROGRESS, CUSTOMER_NOT_SYNCED from the
 * native customer commands) carry none, so they are never worded as the
 * office's answer.
 */
const customerRejectionError = (
  t: TranslateFn,
  rejection: { code?: string | null; conflict?: boolean; status?: number | null },
  phoneRejection: CustomerPhoneInputRejected | null,
  fallbackKey: string,
  target: 'customer' | 'address' = 'customer',
): CustomerFormError => {
  const code = typeof rejection.code === 'string' ? rejection.code : null;
  if (rejection.conflict || code === 'VERSION_MISMATCH') {
    return new CustomerFormError(
      'submit',
      t('modals.addCustomer.conflictError', 'Customer was updated by another terminal. Please refresh.'),
    );
  }
  switch (code) {
    case 'INVALID_PHONE':
    case 'COUNTRY_CONTEXT_REQUIRED':
      if (target === 'customer') {
        return new CustomerFormError(
          'phone',
          phoneRejection ? describePhoneRejection(t, phoneRejection) : t('modals.addCustomer.phoneRejected'),
        );
      }
      break;
    case 'DUPLICATE':
      if (target === 'customer') {
        return new CustomerFormError('submit', t('modals.addCustomer.customerExists'));
      }
      break;
    case 'INVALID_COORDINATES':
      return new CustomerFormError('address', t('modals.addCustomer.addressLocationRejected'));
    case 'NOT_FOUND':
      return new CustomerFormError(
        'submit',
        t(target === 'address' ? 'modals.addCustomer.addressNotFound' : 'modals.addCustomer.customerNotFound'),
      );
    case 'VERSION_REQUIRED':
      return new CustomerFormError('submit', t('modals.addCustomer.versionRequired'));
    case 'CUSTOMER_SYNC_IN_PROGRESS':
      return new CustomerFormError('submit', t('modals.addCustomer.customerSyncInProgress'));
    case 'CUSTOMER_NOT_SYNCED':
      return new CustomerFormError('submit', t('modals.addCustomer.customerNotSynced'));
    default:
      break;
  }
  if (!code) {
    return new CustomerFormError('submit', t(fallbackKey));
  }
  const status = typeof rejection.status === 'number' ? rejection.status : null;
  return new CustomerFormError(
    'submit',
    status === null
      ? t('modals.addCustomer.saveRefusedLocally', { code })
      : t('modals.addCustomer.saveRejected', { code }),
  );
};

const ADD_ADDRESS_SAVE_TIMEOUT_MS = 35_000;

class AddAddressSaveTimeoutError extends Error {
  constructor() {
    super('Add address save timed out');
    this.name = 'AddAddressSaveTimeoutError';
  }
}

/**
 * The saved point of an address (or of a legacy customer row), or null when
 * it has none. Strict: an address without coordinates is never (0,0) — that
 * point used to be zone-checked and answered "out of zone" for about two
 * thirds of one store's saved addresses.
 */
const getStoredCoordinates = (source: any): LatLng | null =>
  source && typeof source === 'object' ? extractSavedAddressCoordinates(source) : null;

/** The first real point among the candidates (never (0,0), never half a pair). */
const firstValidPoint = (...candidates: unknown[]): LatLng | null => {
  for (const candidate of candidates) {
    const point = toValidLatLng(candidate);
    if (point) {
      return point;
    }
  }
  return null;
};

/**
 * The saved address that full "Edit customer" edits: the selected one, else
 * the default, else the first (the order the rest of the POS resolves a
 * customer's address in). Null when the customer has no saved address.
 */
const resolveEditTargetAddress = (customer?: CustomerData | null): any | null => {
  const addresses = Array.isArray(customer?.addresses)
    ? customer!.addresses!.filter(
        (address: any) => address && typeof address === 'object' && typeof address.id === 'string' && address.id.trim(),
      )
    : [];
  if (addresses.length === 0) {
    return null;
  }
  const selectedId = typeof customer?.selected_address_id === 'string' ? customer.selected_address_id : null;
  return (
    (selectedId && addresses.find((address: any) => address.id === selectedId))
    || addresses.find((address: any) => address.is_default)
    || addresses[0]
  );
};

const addressVersionOf = (address: any): number =>
  Number.isFinite(Number(address?.version)) ? Number(address.version) : -1;

interface AddressFieldsSnapshot {
  address: string;
  city: string;
  postalCode: string;
  floorNumber: string;
  nameOnRinger: string;
  notes: string;
}

const getStoredAddressSelectionDetails = (source: any): AddressSelectionDetails | null => {
  if (!source) {
    return null;
  }

  const details: AddressSelectionDetails = {
    city: typeof source.city === 'string' ? source.city : undefined,
    postalCode: typeof source.postal_code === 'string' ? source.postal_code : undefined,
    coordinates: getStoredCoordinates(source) || undefined,
    placeId: typeof source.place_id === 'string' ? source.place_id : undefined,
    resolvedStreetNumber:
      typeof source.resolved_street_number === 'string' ? source.resolved_street_number : undefined,
    addressFingerprint:
      typeof source.address_fingerprint === 'string' ? source.address_fingerprint : undefined,
    validationSource:
      source.validation_source === 'online' || source.validation_source === 'offline_cache'
        ? source.validation_source
        : undefined,
  };

  return Object.values(details).some(Boolean) ? details : null;
};

const AddressAutocomplete: React.FC<AddressAutocompleteProps> = ({
  value,
  onChange,
  placeholder,
  className = "",
  searchEnabled = true,
  repickSignal = 0,
  repickQuery,
}) => {
  const { t } = useTranslation();
  const placeholderText = placeholder ?? t('modals.addNewAddress.addressPlaceholder');
  const { resolvedTheme } = useTheme();
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const searchRequestRef = useRef(0);
  const sessionTokenRef = useRef<string | null>(null);
  const [terminalBranchId, setTerminalBranchId] = useState<string | null>(null);
  const bridge = getBridge();

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
        limit: 5,
        sessionToken: sessionTokenRef.current || undefined,
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

    // Debounce the search
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (!searchEnabled) {
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
      setIsLoading(false);
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setShowSuggestions(true);

    if (newValue.length < 3) {
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
      setIsLoading(false);
      setSuggestions([]);
      return;
    }

    const requestId = ++searchRequestRef.current;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = createAddressSessionToken();
    }
    setIsLoading(true);
    timeoutRef.current = setTimeout(() => {
      void searchAddresses(newValue, requestId);
    }, 200);
  };

  // "Pick the address again": search the saved text (with its city, so a
  // same-named street elsewhere is less likely) and show the suggestions.
  useEffect(() => {
    if (!repickSignal) {
      return;
    }
    inputRef.current?.focus();
    if (!searchEnabled) {
      return;
    }
    const query = (repickQuery ?? value).trim();
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setShowSuggestions(true);
    if (query.length < 3) {
      return;
    }
    const requestId = ++searchRequestRef.current;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = createAddressSessionToken();
    }
    setIsLoading(true);
    void searchAddresses(query, requestId);
    // Only a new request re-runs the search; typing uses handleInputChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repickSignal]);

  const handleSuggestionClick = async (suggestion: AddressSuggestion) => {
    try {
      const resolved = await resolveAddressSuggestion(suggestion, value, {
        branchId: terminalBranchId || undefined,
        sessionToken: sessionTokenRef.current || undefined,
      });
      // An offline or cached candidate can resolve to (0,0) or to no point at
      // all: that is "no coordinates", never a place to check the zone at.
      const resolvedPoint = toValidLatLng(resolved.coordinates);
      const candidatePoint = resolvedPoint ?? toValidLatLng(suggestion.location);
      void upsertVerifiedLocalCandidate({
        place_id: resolved.placeId || suggestion.place_id,
        branch_id: terminalBranchId || undefined,
        name: resolved.streetAddress,
        formatted_address: resolved.formattedAddress || suggestion.formatted_address || resolved.streetAddress,
        city: resolved.city || undefined,
        postal_code: resolved.postalCode || undefined,
        location: candidatePoint || undefined,
        resolved_street_number: resolved.resolvedStreetNumber || undefined,
        address_fingerprint: resolved.addressFingerprint,
        source: resolved.validationSource,
        verified: Boolean(candidatePoint),
      });

      onChange(resolved.streetAddress, {
        city: resolved.city || undefined,
        postalCode: resolved.postalCode || undefined,
        coordinates: resolvedPoint || undefined,
        placeId: resolved.placeId || suggestion.place_id,
        resolvedStreetNumber: resolved.resolvedStreetNumber,
        addressFingerprint: resolved.addressFingerprint,
        validationSource: resolved.validationSource,
        fromSuggestion: true,
      });
      setSuggestions([]);
      setShowSuggestions(false);
      sessionTokenRef.current = null;
    } catch (error) {
      console.error('Error getting place details:', error);
      const streetAddress =
        getSuggestionStreetLabel(suggestion)
        || String(suggestion?.formatted_address || '').split(',')[0]
        || String(suggestion?.formatted_address || '');
      onChange(streetAddress, { fromSuggestion: false });
      setSuggestions([]);
      setShowSuggestions(false);
      sessionTokenRef.current = null;
    }
  };

  useEffect(() => {
    if (!searchEnabled) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
      setSuggestions([]);
      setShowSuggestions(false);
      setIsLoading(false);
    }
  }, [searchEnabled]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      searchRequestRef.current += 1;
      sessionTokenRef.current = null;
    };
  }, []);

  return (
    <div className="relative">
      <div className="relative">
        <MapPin className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
          onFocus={() => {
            if (searchEnabled) {
              setShowSuggestions(true);
            }
          }}
          placeholder={placeholderText}
          autoComplete="off"
          className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${className}`}
        />
      </div>

      {/* Suggestions Dropdown */}
      {searchEnabled && showSuggestions && (suggestions.length > 0 || isLoading) && (
        <div className="absolute left-0 right-0 top-full z-[9999] mt-1 liquid-glass-modal-card shadow-2xl max-h-60 overflow-y-auto scrollbar-hide">
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
              className="w-full text-left p-3 active:bg-white/10 dark:active:bg-white/5 transition-colors border-b border-gray-200/20 dark:border-gray-600/20 last:border-b-0"
            >
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-amber-500 dark:text-amber-300 mt-1 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {getSuggestionStreetLabel(suggestion)}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {suggestion.secondary_text || suggestion.formatted_address}
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
  callerIdWorkspace,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const bridge = getBridge();
  const { hasModule } = useAcquiredModules();
  const hasDeliveryModule = hasModule(MODULE_IDS.DELIVERY);
  const hasDeliveryZonesModule = hasModule(MODULE_IDS.DELIVERY_ZONES);
  const hasDeliveryPro = hasDeliveryModule && hasDeliveryZonesModule;

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
    phoneCountryCode: '',
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

  // Store country for national phone numbers (see STORE_PHONE_COUNTRY_FALLBACK).
  const [storePhoneCountry, setStorePhoneCountry] = useState<CountryCode>(STORE_PHONE_COUNTRY_FALLBACK);
  const readStorePhoneCountry = async (): Promise<CountryCode> => {
    const terminalConfig = bridge?.terminalConfig as
      | { getSetting?: (category: string, key?: string) => Promise<unknown> }
      | undefined;
    if (typeof terminalConfig?.getSetting !== 'function') {
      return STORE_PHONE_COUNTRY_FALLBACK;
    }
    try {
      return (
        toSupportedPhoneCountry(await terminalConfig.getSetting('restaurant', 'phone_country_code'))
        ?? STORE_PHONE_COUNTRY_FALLBACK
      );
    } catch {
      return STORE_PHONE_COUNTRY_FALLBACK;
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    let active = true;
    const loadStoreCountry = () => {
      void readStorePhoneCountry().then((country) => {
        if (active) {
          setStorePhoneCountry(country);
        }
      });
    };
    loadStoreCountry();
    onEvent('terminal-settings-updated', loadStoreCountry);
    onEvent('terminal-config-updated', loadStoreCountry);
    return () => {
      active = false;
      offEvent('terminal-settings-updated', loadStoreCountry);
      offEvent('terminal-config-updated', loadStoreCountry);
    };
    // readStorePhoneCountry only reads the bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bridge.terminalConfig]);

  // Phone field: red once blurred or submitted, or at once for a verdict more
  // typing cannot fix (shared isCustomerPhoneRejectionShownWhileTyping).
  const [phoneBlurred, setPhoneBlurred] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Full "Edit customer": the saved address its address fields edit, and the
  // values they opened with (an unchanged address is not written again).
  const editTargetAddressRef = useRef<any | null>(null);
  const [initialAddressFields, setInitialAddressFields] = useState<AddressFieldsSnapshot | null>(null);
  // A saved address opened for editing WITHOUT a real point: its delivery zone
  // was never checked. While the cashier leaves it as it is, saving is not
  // blocked and nothing is zone-checked; «pick the address again» checks it.
  const [uncheckedStoredAddress, setUncheckedStoredAddress] =
    useState<Pick<AddressFieldsSnapshot, 'address' | 'city' | 'postalCode'> | null>(null);
  const [repickSignal, setRepickSignal] = useState(0);
  // The customer's version after a successful update in this session, so a
  // retry after a failed address save does not trip over its own change.
  const savedCustomerVersionRef = useRef<number | null>(null);

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
      setPhoneBlurred(false);
      setSubmitAttempted(false);
      setInitialAddressFields(null);
      setUncheckedStoredAddress(null);
      setRepickSignal(0);
      editTargetAddressRef.current = null;
      savedCustomerVersionRef.current = null;

      const emptyForm = {
        phone: '',
        phoneCountryCode: '',
        name: '',
        email: '',
        nameOnRinger: '',
        address: '',
        city: '',
        postalCode: '',
        floorNumber: '',
        notes: '',
      };

      // Open a saved address: its stored point (strict, never (0,0)), or the
      // "zone not checked" state when it has none.
      const openSavedAddress = (source: any, fields: AddressFieldsSnapshot, editingSavedAddress: boolean) => {
        const storedCoordinates = getStoredCoordinates(source);
        const storedDetails = getStoredAddressSelectionDetails(source);
        setAddressCoordinates(storedCoordinates);
        setSelectedAddressDetails(storedDetails);
        setValidationSnapshot(storedDetails?.addressFingerprint || null);
        setUncheckedStoredAddress(
          editingSavedAddress && !storedCoordinates && fields.address.trim()
            ? { address: fields.address, city: fields.city, postalCode: fields.postalCode }
            : null,
        );
      };

      if (initialCustomer) {
        const customerFields = {
          phone: initialCustomer.phone || '',
          phoneCountryCode: normalizePhoneCountryCode(initialCustomer.phone_country_code),
          name: initialCustomer.name || '',
          email: initialCustomer.email || '',
        };

        if (isEditAddressMode && initialCustomer.editAddressId) {
          // Edit Address mode - find the address to edit and prefill its data
          const addressToEdit = initialCustomer.addresses?.find(
            (addr: any) => addr.id === initialCustomer.editAddressId
          );
          if (addressToEdit) {
            const fields: AddressFieldsSnapshot = {
              nameOnRinger: addressToEdit.name_on_ringer || '',
              address: addressToEdit.street_address || addressToEdit.street || '',
              city: addressToEdit.city || '',
              postalCode: addressToEdit.postal_code || '',
              floorNumber: addressToEdit.floor_number || '',
              notes: addressToEdit.delivery_notes ?? addressToEdit.notes ?? '',
            };
            setFormData({ ...customerFields, ...fields });
            openSavedAddress(addressToEdit, fields, true);
          } else {
            // Address not found, fall back to empty address fields
            setFormData({ ...emptyForm, ...customerFields });
          }
        } else if (isAddAddressMode) {
          // Add Address mode - only prefill customer info, leave address fields EMPTY for new address
          setFormData({ ...emptyForm, ...customerFields });
        } else {
          // Full edit: the address fields edit the selected (else default)
          // saved address, exactly like the address editor. A customer with
          // no saved address keeps the legacy customer-level fields.
          const targetAddress = mode === 'edit' ? resolveEditTargetAddress(initialCustomer) : null;
          editTargetAddressRef.current = targetAddress;
          const fields: AddressFieldsSnapshot = targetAddress
            ? {
                nameOnRinger: targetAddress.name_on_ringer || '',
                address: targetAddress.street_address || targetAddress.street || '',
                city: targetAddress.city || '',
                postalCode: targetAddress.postal_code || '',
                floorNumber: targetAddress.floor_number || '',
                notes: targetAddress.delivery_notes || targetAddress.notes || initialCustomer.notes || '',
              }
            : {
                nameOnRinger: initialCustomer.name_on_ringer || '',
                address: initialCustomer.address || '',
                city: initialCustomer.city || '',
                postalCode: initialCustomer.postal_code || '',
                floorNumber: initialCustomer.floor_number || '',
                notes: initialCustomer.notes || '',
              };
          setFormData({ ...customerFields, ...fields });
          setInitialAddressFields(fields);
          openSavedAddress(targetAddress ?? initialCustomer, fields, mode === 'edit');
        }
      } else if (initialPhone) {
        // New customer with just phone prefilled
        setFormData({ ...emptyForm, phone: initialPhone });
      } else {
        // Completely new - reset everything
        setFormData(emptyForm);
      }
    }
  }, [isOpen, initialPhone, initialCustomer, isAddAddressMode, isEditAddressMode, hasDeliveryPro, mode]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionLockRef = useRef(false);
  const submissionGenerationRef = useRef(0);
  const isSubmissionLocked = () => submissionLockRef.current;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deliveryValidationResult, setDeliveryValidationResult] = useState<DeliveryValidationResult | null>(null);
  const [deliveryValidationStatus, setDeliveryValidationStatus] = useState<ValidationStatus | 'idle'>('idle');
  const [showDeliveryValidation, setShowDeliveryValidation] = useState(false);
  const [addressCoordinates, setAddressCoordinates] = useState<LatLng | null>(null);
  const [isValidatingDelivery, setIsValidatingDelivery] = useState(false);
  const [selectedAddressDetails, setSelectedAddressDetails] = useState<AddressSelectionDetails | null>(null);
  const [validationSnapshot, setValidationSnapshot] = useState<string | null>(null);
  const [overrideApplied, setOverrideApplied] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const parsedAddressInput = React.useMemo(
    () => parseSpecialAddressInput(formData.address),
    [formData.address],
  );
  const isSpecialAddressMode = parsedAddressInput.shouldSkipZoneValidation;
  const normalizedStreetAddress = parsedAddressInput.shouldSkipZoneValidation
    ? parsedAddressInput.normalizedAddress
    : formData.address.trim();

  // A saved address without a point, still exactly as it was opened: its
  // stored coordinates are left alone and its zone is not checked.
  const keepsUncheckedStoredAddress = Boolean(
    uncheckedStoredAddress
    && formData.address === uncheckedStoredAddress.address
    && formData.city === uncheckedStoredAddress.city
    && formData.postalCode === uncheckedStoredAddress.postalCode
    && !firstValidPoint(selectedAddressDetails?.coordinates, addressCoordinates),
  );
  // Founder (29/09/2026): never «out of zone» for an address nobody checked.
  // Say the zone was not checked and offer to pick the address again; saving
  // is not blocked.
  const showZoneNotChecked = hasDeliveryPro && keepsUncheckedStoredAddress && !isSpecialAddressMode;
  const repickQuery = [formData.address.trim(), formData.city.trim()].filter(Boolean).join(', ');

  const phoneAssessment = React.useMemo(
    () => isAddressOnlyMode
      ? null
      : assessCustomerPhone({
          editing: mode === 'edit' && Boolean(initialCustomer?.id),
          phone: formData.phone,
          storeCountry: storePhoneCountry,
          initialPhone: initialCustomer?.phone,
          initialCountry: initialCustomer?.phone_country_code,
        }),
    [isAddressOnlyMode, mode, initialCustomer?.id, initialCustomer?.phone, initialCustomer?.phone_country_code, formData.phone, storePhoneCountry],
  );
  const phoneRejection: CustomerPhoneInputRejected | null =
    phoneAssessment && !phoneAssessment.result.ok && phoneAssessment.result.reason !== 'EMPTY'
      ? phoneAssessment.result
      : null;
  const livePhoneError = phoneRejection && phoneAssessment?.blocksSave
    && (phoneBlurred || submitAttempted || isCustomerPhoneRejectionShownWhileTyping(phoneRejection))
    ? describePhoneRejection(t, phoneRejection)
    : '';
  const phoneErrorText = errors.phone || livePhoneError;
  // Editing a customer whose stored phone fails today's rule: say so, but the
  // number is kept as it is and the save goes ahead.
  const phoneKeptWarning = !phoneErrorText && phoneRejection && phoneAssessment && !phoneAssessment.blocksSave
    ? describePhoneRejection(t, phoneRejection)
    : '';

  const handleInputChange = (field: string, value: string) => {
    if ((field === 'city' || field === 'postalCode') && value !== formData[field]) {
      clearAddressValidation(formData.address);
    }
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const clearAddressValidation = (addressValue: string) => {
    const parsedAddress = parseSpecialAddressInput(addressValue);
    const normalizedAddress = hasDeliveryPro
      ? addressValue.trim()
      : parsedAddress.normalizedAddress;
    setSelectedAddressDetails(null);
    setAddressCoordinates(null);
    setDeliveryValidationResult(null);
    setValidationSnapshot(null);
    setOverrideApplied(false);
    setOverrideReason('');

    if (!normalizedAddress) {
      setShowDeliveryValidation(false);
      setDeliveryValidationStatus('idle');
      return;
    }

    if (!hasDeliveryPro || parsedAddress.shouldSkipZoneValidation) {
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
    const parsedAddress = parseSpecialAddressInput(address);
    const trimmedAddress = hasDeliveryPro
      ? address.trim()
      : parsedAddress.normalizedAddress;
    if (!trimmedAddress) {
      return null;
    }

    if (!hasDeliveryPro) {
      setShowDeliveryValidation(false);
      setDeliveryValidationStatus('idle');
      return null;
    }

    setIsValidatingDelivery(true);
    try {
      // Only a real point is ever zone-checked; none means a text check.
      const coords = firstValidPoint(details?.coordinates, addressCoordinates) || undefined;
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
      setShowDeliveryValidation(validation.validation_status !== 'module_disabled');
      setValidationSnapshot(validation.address_fingerprint || fallbackFingerprint);
      const validatedPoint = toValidLatLng(validation.coordinates);
      if (validatedPoint) {
        setAddressCoordinates(validatedPoint);
      } else if (coords) {
        setAddressCoordinates(coords);
      }

      if (
        validation.validation_status === 'in_zone'
        || validation.validation_status === 'module_disabled'
      ) {
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
    const address = normalizedStreetAddress;
    if (!address) {
      return null;
    }

    if (!hasDeliveryPro) {
      return null;
    }

    const coords = firstValidPoint(selectedAddressDetails?.coordinates, addressCoordinates) || undefined;
    const currentFingerprint = buildAddressFingerprint(address, coords);

    if (deliveryValidationResult && validationSnapshot === currentFingerprint) {
      return deliveryValidationResult;
    }

    return validateDeliveryAddress(address, selectedAddressDetails);
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
      setAddressCoordinates(toValidLatLng(details?.coordinates));
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

  const validateForm = (assessment: PhoneAssessment | null) => {
    const newErrors: Record<string, string> = {};

    // The phone is read-only while an address is added or edited: a stored
    // phone never blocks an address save.
    if (!isAddressOnlyMode) {
      if (!formData.phone.trim()) {
        newErrors.phone = t('modals.addCustomer.phoneRequired');
      } else if (assessment?.blocksSave && !assessment.result.ok) {
        newErrors.phone = describePhoneRejection(t, assessment.result);
      }
    }

    if (!formData.name.trim()) {
      newErrors.name = t('modals.addCustomer.nameRequired');
    }

    if (!normalizedStreetAddress) {
      newErrors.address = t('modals.addCustomer.streetRequired');
    }

    if (!formData.floorNumber.trim()) {
      newErrors.floorNumber = t('modals.addCustomer.floorRequired');
    }

    if (!formData.nameOnRinger.trim()) {
      newErrors.nameOnRinger = t('modals.addCustomer.nameOnRingerRequired');
    }

    if (overrideApplied && overrideReason.trim().length < 6) {
      newErrors.overrideReason = t('modals.addCustomer.overrideReasonRequired', 'Override reason must be at least 6 characters.');
    }

    if (formData.email && !/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = t('modals.addCustomer.emailInvalid');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmissionLocked()) return;

    submissionLockRef.current = true;
    const submissionGeneration = ++submissionGenerationRef.current;
    setIsSubmitting(true);
    setSubmitAttempted(true);

    try {
      console.log('[AddCustomerModal.handleSubmit] mode:', mode, 'customer:', initialCustomer?.id ?? null);

      // Validate with the store country this terminal holds right now, and
      // submit exactly the country the number was validated with.
      const storeCountry = await readStorePhoneCountry();
      if (storeCountry !== storePhoneCountry) {
        setStorePhoneCountry(storeCountry);
      }
      const submitPhoneAssessment = isAddressOnlyMode
        ? null
        : assessCustomerPhone({
            editing: mode === 'edit' && Boolean(initialCustomer?.id),
            phone: formData.phone,
            storeCountry,
            initialPhone: initialCustomer?.phone,
            initialCountry: initialCustomer?.phone_country_code,
          });

      if (!validateForm(submitPhoneAssessment)) {
        console.log('[AddCustomerModal.handleSubmit] Validation failed');
        return;
      }

      const submittedPhone = formData.phone;
      const submittedPhoneCountryCode = isInternationalPhone(submittedPhone)
        ? null
        : submitPhoneAssessment?.country ?? storeCountry;
      const submittedPhoneRejection =
        submitPhoneAssessment && !submitPhoneAssessment.result.ok ? submitPhoneAssessment.result : null;

      let validationForSubmit: DeliveryValidationResult | null = null;
      // A saved address without a point that the cashier left as it is is not
      // zone-checked (and never by its text alone, which can land on a
      // same-named street elsewhere): the save goes ahead, the notice stays.
      if (hasDeliveryPro && !keepsUncheckedStoredAddress) {
        validationForSubmit = await ensureAddressValidationForSubmit();
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
      }

      console.log('[AddCustomerModal.handleSubmit] Starting submission...');
      const refreshed = await getResolvedTerminalCredentials().catch(() => ({
        branchId: terminalBranchId || undefined,
      } as any));
      const activeValidation = hasDeliveryPro && !keepsUncheckedStoredAddress
        ? (validationForSubmit || deliveryValidationResult)
        : null;
      // Persist the exact selected suggestion point first (Google/OSM details), then fallback.
      // Only a real point: never (0,0), never half a pair.
      const persistedCoords = !parsedAddressInput.shouldSkipZoneValidation
        ? firstValidPoint(selectedAddressDetails?.coordinates, addressCoordinates, activeValidation?.coordinates)
        : null;
      // A saved address without a point, left as it is, keeps whatever point
      // the office holds: its coordinates are left out of the write rather
      // than sent as null.
      const coordinateFields = keepsUncheckedStoredAddress
        ? {}
        : {
            coordinates: persistedCoords,
            latitude: persistedCoords?.lat ?? null,
            longitude: persistedCoords?.lng ?? null,
          };
      const validatedAt = hasDeliveryPro && activeValidation ? new Date().toISOString() : null;
      const normalizedOverrideReason = overrideApplied ? overrideReason.trim() : '';
      const validationMetadata = hasDeliveryPro
        ? {
            override_applied: overrideApplied,
            override_reason: normalizedOverrideReason || null,
            validation_status: showZoneNotChecked
              ? 'requires_selection'
              : activeValidation?.validation_status || null,
            zone_id: activeValidation?.selectedZone?.id || null,
            validated_at: validatedAt,
            validation_source: activeValidation?.validation_source || null,
            address_fingerprint:
              activeValidation?.address_fingerprint
              || validationSnapshot
              || buildAddressFingerprint(normalizedStreetAddress, persistedCoords || undefined),
            place_id: selectedAddressDetails?.placeId || null,
            input_street_number: extractStreetNumber(normalizedStreetAddress) || null,
            resolved_street_number: selectedAddressDetails?.resolvedStreetNumber || null,
            house_number_match: activeValidation?.house_number_match ?? true,
          }
        : null;

      // Handle ADD ADDRESS mode - save new address to existing customer via IPC
      if (mode === 'addAddress' && initialCustomer?.id) {
        console.log('[AddCustomerModal] Adding new address for customer:', initialCustomer.id)

        // Use IPC service to avoid CORS
        const addressData = {
          street_address: normalizedStreetAddress, // Map to DB column name
          city: formData.city ? formData.city.trim() : '',
          postal_code: formData.postalCode ? formData.postalCode.trim() : null,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
          notes: formData.notes ? formData.notes.trim() : null,
          name_on_ringer: formData.nameOnRinger.trim() || null,
          address_type: 'delivery',
          is_default: false,
          coordinates: persistedCoords,
          latitude: persistedCoords?.lat ?? null,
          longitude: persistedCoords?.lng ?? null,
          ...(validationMetadata ?? {}),
        };

        // Result from IPC is { success: boolean, data?: any, error?: string }
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          customerService.addCustomerAddress(initialCustomer.id, addressData),
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
              () => reject(new AddAddressSaveTimeoutError()),
              ADD_ADDRESS_SAVE_TIMEOUT_MS,
            );
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        }) as any;

        if (result && result.success) {
          const newAddress = result.data;
          console.log('[AddCustomerModal] addAddress success - address:', newAddress?.id ?? null);
          // Return the customer with the new address info
          const updatedCustomer = {
            ...initialCustomer,
            // Update legacy fields for immediate UI feedback if needed,
            // though proper selection should use selected_address_id
            address: normalizedStreetAddress,
            postal_code: formData.postalCode ? formData.postalCode.trim() : initialCustomer.postal_code,
            floor_number: formData.floorNumber ? formData.floorNumber.trim() : initialCustomer.floor_number,
            notes: formData.notes ? formData.notes.trim() : initialCustomer.notes,
            name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : initialCustomer.name_on_ringer,
            // Include the new address ID
            selected_address_id: newAddress?.id,
            // Ensure addresses array includes the new one if we have it locally
            addresses: initialCustomer.addresses ? [...initialCustomer.addresses, newAddress] : [newAddress]
          };

          onCustomerAdded(updatedCustomer);
        } else {
          // A refused address (INVALID_COORDINATES, NOT_FOUND, this register's
          // own refusals) is named; anything else gets the generic message.
          throw customerRejectionError(
            t,
            normalizeCustomerWriteResult(result),
            null,
            'modals.addCustomer.addressSaveFailed',
            'address',
          );
        }
        return;
      }

      // Handle EDIT ADDRESS mode - update existing address in customer_addresses table
      if (mode === 'editAddress' && initialCustomer?.id && initialCustomer?.editAddressId) {
        console.log('[AddCustomerModal] Updating address:', initialCustomer.editAddressId, 'for customer:', initialCustomer.id);

        const addressData = {
          street_address: normalizedStreetAddress,
          city: formData.city ? formData.city.trim() : null,
          postal_code: formData.postalCode ? formData.postalCode.trim() : null,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
          notes: formData.notes ? formData.notes.trim() : null,
          name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : null,
          ...coordinateFields,
          customer_id: initialCustomer.id,
          ...(validationMetadata ?? {}),
        };

        // Find the address to get its current version
        const addressToEdit = initialCustomer.addresses?.find(
          (addr: any) => addr.id === initialCustomer.editAddressId
        );

        // Use customerService to update the address
        const result = await customerService.updateCustomerAddress(
          initialCustomer.editAddressId,
          addressData,
          addressVersionOf(addressToEdit),
        ) as any;

        if (result && result.success) {
          const updatedAddress = result.data;
          // Update the addresses array with the edited address
          const updatedAddresses = initialCustomer.addresses?.map((addr: any) =>
            addr.id === initialCustomer.editAddressId
              ? { ...addr, ...updatedAddress, notes: formData.notes.trim(), delivery_notes: formData.notes.trim() }
              : addr
          ) || [];

          // Return the customer with updated addresses
          const updatedCustomer = {
            ...initialCustomer,
            addresses: updatedAddresses,
            // Keep editAddressId so OrderFlow knows which address was edited
            editAddressId: initialCustomer.editAddressId,
            // The address just edited is the one the order goes to (a legacy
            // placeholder comes back from the office with its new id).
            selected_address_id: updatedAddress?.id || initialCustomer.editAddressId,
          };

          onCustomerAdded(updatedCustomer);
        } else {
          throw customerRejectionError(
            t,
            normalizeCustomerWriteResult(result),
            null,
            'modals.addCustomer.addressSaveFailed',
            'address',
          );
        }
        return;
      }

      // Handle EDIT mode - update existing customer via IPC
      if (mode === 'edit' && initialCustomer?.id) {
        console.log('[AddCustomerModal] Updating existing customer via IPC:', initialCustomer.id);

        const initialFields = initialAddressFields;
        const addressFieldKeys = ['address', 'city', 'postalCode', 'floorNumber', 'nameOnRinger', 'notes'] as const;
        const notesChanged = !initialFields || formData.notes.trim() !== initialFields.notes.trim();
        const addressFieldsChanged = !initialFields
          || addressFieldKeys.some((key) => formData[key].trim() !== initialFields[key].trim());
        const targetAddress = editTargetAddressRef.current;
        const storedPoint = getStoredCoordinates(targetAddress ?? initialCustomer);
        const pointChanged = !keepsUncheckedStoredAddress
          && (persistedCoords?.lat !== storedPoint?.lat || persistedCoords?.lng !== storedPoint?.lng);
        // Founder (29/09/2026): full "Edit customer" saves its address changes
        // to the selected (else default) address, exactly like the address
        // editor. An untouched address is not written again.
        const writesAddress = Boolean(normalizedStreetAddress) && (addressFieldsChanged || pointChanged);

        const updates = {
          // An unchanged phone is left out: the office keeps it as stored and
          // does not re-read it with today's rule or another country.
          ...(submitPhoneAssessment?.unchanged
            ? {}
            : { phone: submittedPhone, phone_country_code: submittedPhoneCountryCode }),
          name: formData.name.trim(),
          email: formData.email ? formData.email.trim() : undefined,
          address: normalizedStreetAddress,
          city: formData.city ? formData.city.trim() : undefined,
          postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
          // With a saved address the notes field is that address's delivery
          // notes: a change is written to the address only (below), so a
          // separate customer-level note is never replaced. A customer with
          // no saved address keeps the legacy customer-level notes, written
          // only when the cashier changed them.
          notes: !targetAddress && notesChanged && formData.notes.trim() ? formData.notes.trim() : undefined,
          name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
          ...coordinateFields,
          delivery_validation: validationMetadata,
        };

        // Use optimistic versioning if available, otherwise fetch fresh version
        let currentVersion: number | null | undefined = savedCustomerVersionRef.current ?? initialCustomer.version;

        // If no version, fetch fresh customer data to get current version
        if (currentVersion === undefined || currentVersion === null) {
          console.log('[AddCustomerModal] No version found, fetching fresh customer data...');
          try {
            // First invalidate cache to ensure we get fresh data
            await bridge.customers.invalidateCache(initialCustomer.phone);

            const freshCustomer = await bridge.customers.lookupByPhone(initialCustomer.phone);
            if (freshCustomer?.version !== undefined && freshCustomer?.version !== null) {
              currentVersion = freshCustomer.version;
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
          throw new CustomerFormError(
            'submit',
            t('modals.addCustomer.versionRequired', 'Unable to update customer - please refresh and try again'),
          );
        }

        const result = await customerService.updateCustomer(initialCustomer.id, updates as any, currentVersion);
        if (!result.success) {
          throw customerRejectionError(t, result, submittedPhoneRejection, 'modals.addCustomer.updateFailed');
        }
        const savedVersion = Number((result.data as any)?.version);
        if (Number.isFinite(savedVersion)) {
          savedCustomerVersionRef.current = savedVersion;
        }

        let addressWrite: any = null;
        if (writesAddress) {
          const addressData = {
            street_address: normalizedStreetAddress,
            city: formData.city ? formData.city.trim() : null,
            postal_code: formData.postalCode ? formData.postalCode.trim() : null,
            floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
            name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : null,
            ...(notesChanged ? { notes: formData.notes.trim() || null } : {}),
            ...coordinateFields,
            customer_id: initialCustomer.id,
            ...(validationMetadata ?? {}),
          };
          try {
            addressWrite = targetAddress?.id
              ? await customerService.updateCustomerAddress(
                  targetAddress.id,
                  addressData,
                  addressVersionOf(targetAddress),
                )
              : await customerService.addCustomerAddress(initialCustomer.id, {
                  ...addressData,
                  address_type: 'delivery',
                  is_default: true,
                });
          } catch (addressError) {
            console.error('[AddCustomerModal] Saving the edited address failed:', addressError);
            addressWrite = null;
          }
          if (!addressWrite?.success) {
            throw customerRejectionError(
              t,
              normalizeCustomerWriteResult(addressWrite),
              null,
              'modals.addCustomer.addressSaveFailed',
              'address',
            );
          }
        }

        // Hand on the addresses as they are now, not as the form opened.
        const baseAddresses: any[] = Array.isArray(initialCustomer.addresses) ? initialCustomer.addresses : [];
        const savedAddress = addressWrite?.data && typeof addressWrite.data === 'object' ? addressWrite.data : null;
        const freshAddresses: any[] =
          Array.isArray(addressWrite?.customer?.addresses) && addressWrite.customer.addresses.length > 0
            ? addressWrite.customer.addresses
            : savedAddress
              ? targetAddress
                ? baseAddresses.map((addr: any) => (addr?.id === targetAddress.id ? { ...addr, ...savedAddress } : addr))
                : [...baseAddresses, savedAddress]
              : baseAddresses;

        const updatedCustomer = {
          ...(result.data as any),
          // Include address data from form for immediate use
          address: normalizedStreetAddress,
          city: formData.city ? formData.city.trim() : undefined,
          postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
          // The customer's own notes stay as saved; the edited delivery notes
          // travel with the address.
          notes: targetAddress
            ? ((result.data as any)?.notes ?? initialCustomer.notes ?? undefined)
            : formData.notes ? formData.notes.trim() : undefined,
          name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
          addresses: freshAddresses,
          selected_address_id:
            savedAddress?.id || targetAddress?.id || initialCustomer.selected_address_id || null,
        };
        onCustomerAdded(updatedCustomer);
        setFormData({
          phone: '',
          phoneCountryCode: '',
          name: '',
          email: '',
          nameOnRinger: '',
          address: '',
          city: '',
          postalCode: '',
          floorNumber: '',
          notes: '',
        });
        return;
      }

      // Handle NEW mode - create customer via IPC
      console.log('[AddCustomerModal] Creating new customer via IPC');

      const newCustomerData = {
        phone: submittedPhone,
        phone_country_code: submittedPhoneCountryCode,
        name: formData.name.trim(),
        email: formData.email ? formData.email.trim() : undefined,
        address: normalizedStreetAddress,
        city: formData.city ? formData.city.trim() : undefined,
        postal_code: formData.postalCode ? formData.postalCode.trim() : undefined,
        floor_number: formData.floorNumber ? formData.floorNumber.trim() : undefined,
        notes: formData.notes ? formData.notes.trim() : undefined,
        name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : undefined,
        // Branch association - assign customer to the terminal's branch
        branch_id: terminalBranchId || refreshed.branchId || undefined,
        // Include delivery validation data and coordinates
        coordinates: hasDeliveryPro ? persistedCoords : null,
        latitude: persistedCoords?.lat ?? null,
        longitude: persistedCoords?.lng ?? null,
        delivery_validation: hasDeliveryPro && activeValidation ? {
          validated: true,
          delivery_available: activeValidation.deliveryAvailable,
          zone_name: activeValidation.selectedZone?.name ?? null,
          delivery_fee: activeValidation.selectedZone?.delivery_fee ?? null,
          minimum_order_amount: activeValidation.selectedZone?.minimum_order_amount ?? null,
          ...(validationMetadata ?? {}),
        } : null,
      };

      // A refused create (success:false) saved and queued nothing: show why and
      // keep the form open. Only a real connection failure is saved offline.
      const createResult = await customerService.createCustomer(newCustomerData as any);
      if (!createResult.success) {
        throw customerRejectionError(t, createResult, submittedPhoneRejection, 'modals.addCustomer.failed');
      }
      const createdCustomer = createResult.data as any;

      if (createdCustomer?.id) {
        // Enrich with form data to ensure city/floor are immediately available
        // (matches the enrichment pattern used by EDIT mode at lines 928-940)
        const enrichedAddressFields = {
          street_address: normalizedStreetAddress,
          city: formData.city ? formData.city.trim() : '',
          postal_code: formData.postalCode ? formData.postalCode.trim() : null,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : null,
          notes: formData.notes ? formData.notes.trim() : null,
          name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : null,
          ...(persistedCoords
            ? {
                coordinates: persistedCoords,
                latitude: persistedCoords.lat,
                longitude: persistedCoords.lng,
              }
            : {}),
          is_default: true,
        };

        // Ensure addresses array has at least the address from form data
        const existingAddresses = createdCustomer.addresses || [];
        const enrichedAddresses = existingAddresses.length > 0
          ? existingAddresses.map((addr: any, i: number) =>
              i === 0 ? { ...addr, ...enrichedAddressFields } : addr
            )
          : normalizedStreetAddress
            ? [{ id: 'local-new', customer_id: createdCustomer.id, ...enrichedAddressFields }]
            : [];

        const enrichedCustomer = {
          ...createdCustomer,
          address: normalizedStreetAddress,
          city: formData.city ? formData.city.trim() : createdCustomer.city,
          postal_code: formData.postalCode ? formData.postalCode.trim() : createdCustomer.postal_code,
          floor_number: formData.floorNumber ? formData.floorNumber.trim() : createdCustomer.floor_number,
          notes: formData.notes ? formData.notes.trim() : createdCustomer.notes,
          name_on_ringer: formData.nameOnRinger ? formData.nameOnRinger.trim() : createdCustomer.name_on_ringer,
          coordinates: hasDeliveryPro ? persistedCoords : createdCustomer.coordinates,
          latitude: persistedCoords?.lat ?? createdCustomer.latitude ?? null,
          longitude: persistedCoords?.lng ?? createdCustomer.longitude ?? null,
          selected_address_id:
            createdCustomer.selected_address_id ||
            enrichedAddresses[0]?.id ||
            null,
          addresses: enrichedAddresses,
        };
        onCustomerAdded(enrichedCustomer);

        // Reset form
        setFormData({
          phone: '',
          phoneCountryCode: '',
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
        throw new CustomerFormError('submit', t('modals.addCustomer.failed'));
      }
    } catch (error) {
      console.error('[AddCustomerModal.handleSubmit] Error:', error);
      console.error('[AddCustomerModal.handleSubmit] Mode was:', mode, 'initialCustomer:', initialCustomer?.id);
      // Raw native or office text never reaches the form: a known rejection
      // lands on its field, anything else gets the mode's own message.
      if (error instanceof CustomerFormError) {
        setErrors({ [error.field]: error.message });
      } else if (isAddAddressMode) {
        setErrors({
          submit: error instanceof AddAddressSaveTimeoutError
            ? t('modals.addCustomer.addressSaveTimedOut')
            : t('modals.addCustomer.addressSaveFailed'),
        });
      } else if (isEditAddressMode) {
        setErrors({ submit: t('modals.addCustomer.addressSaveFailed') });
      } else if (mode === 'edit') {
        setErrors({ submit: t('modals.addCustomer.updateFailed') });
      } else {
        setErrors({ submit: t('modals.addCustomer.failed') });
      }
    } finally {
      if (submissionGenerationRef.current === submissionGeneration) {
        console.log('[AddCustomerModal.handleSubmit] Finally block - isSubmitting set to false');
        submissionLockRef.current = false;
        setIsSubmitting(false);
      }
    }
  };

  const handleSafeClose = () => {
    if (isSubmissionLocked()) return;
    submissionGenerationRef.current += 1;
    onClose();
  };
  const handleSafeMinimize = () => {
    if (isSubmissionLocked()) return;
    callerIdWorkspace?.onMinimize();
  };

  // Cleanup validation timeout on unmount
  useEffect(() => {
    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      submissionGenerationRef.current += 1;
      submissionLockRef.current = false;
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

  if (callerIdWorkspace?.suspended) return null;

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleSafeClose}
      title={callerIdWorkspace ? undefined : getModalTitle()}
      header={callerIdWorkspace ? (
        <div className="liquid-glass-modal-header">
          <h2 className="liquid-glass-modal-title">{getModalTitle()}</h2>
          <div className="ml-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSafeMinimize}
              disabled={isSubmitting}
              className="liquid-glass-modal-close"
              aria-label={t('modals.addCustomer.minimize', 'Minimize')}
            >
              <Minus className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={handleSafeClose}
              disabled={isSubmitting}
              className="liquid-glass-modal-close"
              aria-label={t('common.actions.close', 'Close')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      ) : undefined}
      ariaLabel={callerIdWorkspace ? getModalTitle() : undefined}
      size={callerIdWorkspace ? 'lg' : 'sm'}
      className={callerIdWorkspace ? '!max-w-4xl' : '!max-w-lg'}
      closeOnBackdrop={!isSubmitting}
      closeOnEscape={!isSubmitting}
    >
      {/* Form Content */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Phone Number - disabled in addAddress mode */}
        <div>
          <label
            htmlFor="add-customer-phone"
            className="block text-sm font-medium liquid-glass-modal-text mb-2"
          >
            {t('modals.addCustomer.phoneLabel').replace(' *', '')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Phone className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
            <input
              id="add-customer-phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => handleInputChange('phone', e.target.value)}
              onBlur={() => setPhoneBlurred(true)}
              placeholder={t('modals.addCustomer.phonePlaceholder')}
              aria-invalid={phoneErrorText ? true : undefined}
              aria-describedby={
                phoneErrorText
                  ? 'add-customer-phone-error'
                  : phoneKeptWarning
                    ? 'add-customer-phone-warning'
                    : undefined
              }
              className={`${inputBase(resolvedTheme)} pl-10 pr-4 ${isAddressOnlyMode ? 'opacity-60 cursor-not-allowed' : ''} ${phoneErrorText ? '!border-red-500 focus:!ring-red-500/50' : ''}`}
              disabled={isAddressOnlyMode}
              readOnly={isAddressOnlyMode}
            />
          </div>
          {phoneErrorText && (
            <p
              id="add-customer-phone-error"
              role="alert"
              className="mt-1 text-sm text-red-600 dark:text-red-400"
            >
              {phoneErrorText}
            </p>
          )}
          {phoneKeptWarning && (
            <p
              id="add-customer-phone-warning"
              className="mt-1 text-sm text-amber-700 dark:text-amber-300"
            >
              <span className="block">{phoneKeptWarning}</span>
              <span className="block">{t('modals.addCustomer.phoneKeptAsSaved')}</span>
            </p>
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
              placeholder={
                hasDeliveryPro
                  ? t('modals.addCustomer.streetPlaceholder')
                  : t('modals.addCustomer.manualAddressPlaceholder')
              }
              className="pr-3"
              searchEnabled={hasDeliveryPro}
              repickSignal={repickSignal}
              repickQuery={repickQuery}
            />
          </div>
          {errors.address && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.address}</p>
          )}
          {showZoneNotChecked && (
            <div
              role="status"
              data-testid="add-customer-zone-not-checked"
              className="mt-2 space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3"
            >
              <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <span>{t('modals.addCustomer.zoneNotChecked')}</span>
              </div>
              <button
                type="button"
                onClick={() => setRepickSignal((signal) => signal + 1)}
                className="liquid-glass-modal-button rounded-2xl px-3 py-2 text-sm"
              >
                {t('modals.addCustomer.repickAddress')}
              </button>
            </div>
          )}
          {!hasDeliveryPro && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('modals.addCustomer.manualAddressEntryHint')}
            </p>
          )}
        </div>

        {isSpecialAddressMode && (
          <div className="liquid-glass-modal-card">
            <div className="flex items-start gap-3 text-sm text-emerald-800 dark:text-emerald-100">
              <Hash className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
              <div className="space-y-1">
                <p className="font-medium">
                  {t('modals.addCustomer.specialAddressModeTitle', 'Special address label detected')}
                </p>
                <p className="text-emerald-700/90 dark:text-emerald-100/80">
                  {t(
                    'modals.addCustomer.specialAddressModeDescription',
                    {
                      address: normalizedStreetAddress,
                      defaultValue:
                        'This address will be saved as "{{address}}". Delivery zone validation is skipped for this entry.',
                    },
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Delivery Validation */}
        {hasDeliveryPro && showDeliveryValidation && !showZoneNotChecked && (
          <div className="liquid-glass-modal-card">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <MapPin className="w-4 h-4" />
                {t('modals.addCustomer.deliveryValidation')}
              </div>

              {/* Validation Status */}
              <div className="min-h-[24px]">
                {isValidatingDelivery && (
                  <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-300">
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
                          {isAddAddressMode
                            ? t('modals.addCustomer.validationError')
                            : deliveryValidationResult.message
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
                <div className="bg-black/20 rounded-2xl p-3 space-y-2 border border-white/5">
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
                <div className="space-y-2 rounded-2xl border border-orange-500/30 bg-orange-500/10 p-3">
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
            <Building className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
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
            <Hash className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
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
            <User className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
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
            <Mail className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
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
            {t('modals.addCustomer.nameOnRingerLabel')}
          </label>
          <div className="relative">
            <Users className="liquid-glass-modal-field-icon absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" />
            <input
              type="text"
              value={formData.nameOnRinger}
              onChange={(e) => handleInputChange('nameOnRinger', e.target.value)}
              placeholder={t('modals.addCustomer.nameOnRingerPlaceholder')}
              required
              aria-required="true"
              className={`${inputBase(resolvedTheme)} pl-10 pr-4`}
            />
          </div>
          {errors.nameOnRinger && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.nameOnRinger}</p>
          )}
        </div>

        {/* Floor Number */}
        <div>
          <FloorPresetPicker
            value={formData.floorNumber}
            onChange={(value) => handleInputChange('floorNumber', value)}
            label={t('modals.addCustomer.floorLabel')}
            placeholder={t('modals.addCustomer.floorPlaceholder')}
            inputClassName={inputBase(resolvedTheme)}
            maxLength={100}
            required
          />
          {(formData.floorNumber?.length ?? 0) >= 100 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('modals.addCustomer.floorTooLong', { max: 100 })}
            </p>
          )}
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
            <FileText className="liquid-glass-modal-field-icon absolute left-3 top-3 w-5 h-5" />
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
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-600 dark:text-red-400 text-sm">
            {errors.submit}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={handleSafeClose}
            disabled={isSubmitting}
            className="liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-2xl"
          >
            {t('modals.addCustomer.cancel')}
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="liquid-glass-modal-button liquid-glass-modal-success flex-1 rounded-2xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
          >
            {isSubmitting
              ? t('modals.addCustomer.saving')
              : (mode === 'addAddress' || mode === 'editAddress')
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

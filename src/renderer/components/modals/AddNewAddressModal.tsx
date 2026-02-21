import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, Home, User, Phone, Mail } from 'lucide-react';
import { getApiUrl } from '../../../config/environment';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { getCachedTerminalCredentials, refreshTerminalCredentialCache } from '../../services/terminal-credentials';

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
  onAddressAdded: (customer: Customer, newAddress: string, postalCode?: string, floorNumber?: string, notes?: string) => void;
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
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);

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

  const searchAddresses = async (input: string) => {
    if (input.length < 3) {
      setSuggestions([]);
      return;
    }

    setIsLoading(true);
    try {
      // Call the admin dashboard API which will use Google Maps MCP
      const response = await fetch(getApiUrl('google-maps/search-places'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: input + ', Greece', // Restrict to Greece
          location: { latitude: 37.9755, longitude: 23.7348 }, // Athens center
          radius: 50000 // 50km radius
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
      if (result && result.places && Array.isArray(result.places)) {
        setSuggestions(result.places.slice(0, 5)); // Limit to 5 suggestions
      } else {
        setSuggestions([]);
      }
    } catch (error) {
      console.error('Error searching addresses:', error);
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuggestionClick = async (suggestion: any) => {
    try {
      // Get place details to extract postal code
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

      const detailsResult = await response.json();
      
      let fullAddress = suggestion.formatted_address;
      let postalCode = '';

      if (detailsResult && detailsResult.result) {
        const addressComponents = detailsResult.result.address_components || [];
        
        // Extract postal code
        const postalCodeComponent = addressComponents.find((component: any) => 
          component.types.includes('postal_code')
        );
        
        if (postalCodeComponent) {
          postalCode = postalCodeComponent.long_name;
        }
      }

      setFormData(prev => ({
        ...prev,
        address: fullAddress,
        postalCode: postalCode
      }));
      setSuggestions([]);
    } catch (error) {
      console.error('Error getting place details:', error);
      // Fallback: just use the suggestion address
      setFormData(prev => ({
        ...prev,
        address: suggestion.formatted_address
      }));
      setSuggestions([]);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    
    if (field === 'address') {
      searchAddresses(value);
    }
  };

  const handleSubmit = async () => {
    if (!formData.address.trim()) {
      alert(t('modals.addNewAddress.addressRequired'));
      return;
    }


    setIsLoading(true);
    try {
      // First, save the new address to the database using POS endpoint
      const headers = await getPosAuthHeaders();
      const addAddressResponse = await fetch(getApiUrl(`pos/customers/${customer.id}/addresses`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          street: formData.address.trim(),
          street_address: formData.address.trim(),
          address: formData.address.trim(),
          postal_code: formData.postalCode.trim() || undefined,
          floor_number: formData.floorNumber.trim() || undefined,
          notes: formData.notes.trim() || undefined,
          address_type: 'delivery',
          is_default: false // This is a secondary address, not the default
        }),
      });

      if (!addAddressResponse.ok) {
        throw new Error(t('modals.addNewAddress.saveFailed'));
      }

      const addressResult = await addAddressResponse.json();

      if (!addressResult.success) {
        throw new Error(addressResult.error || t('modals.addNewAddress.saveFailed'));
      }


      // Call the callback with the updated customer information
      onAddressAdded(
        customer,
        formData.address.trim(),
        formData.postalCode.trim() || undefined,
        formData.floorNumber.trim() || undefined,
        formData.notes.trim() || undefined
      );
      
      // Reset form
      setFormData({
        address: '',
        postalCode: '',
        floorNumber: '',
        notes: '',
      });
      
      onClose();
    } catch (error) {
      console.error('Error adding new address:', error);
      alert(t('modals.addNewAddress.addFailed', { error: error instanceof Error ? error.message : t('modals.addNewAddress.unknownError') }));
    } finally {
      setIsLoading(false);
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
    >

        <div className="p-6">
          <p className="liquid-glass-modal-text-muted mb-6">
            {t('modals.addNewAddress.subtitle', { name: customer.name })}
          </p>

          {/* Customer Info */}
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

          {/* Address Form */}
          <div className="space-y-4">
            {/* Address Input with Autocomplete */}
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
              </div>

              {/* Address Suggestions */}
              {suggestions.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border liquid-glass-modal-border rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={index}
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

            {/* Postal Code */}
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

            {/* Floor Number */}
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

            {/* Notes */}
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

          {/* Action Buttons */}
          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-3 bg-gray-500/10 hover:bg-gray-500/20 liquid-glass-modal-text font-medium rounded-xl border border-gray-500/20 transition-all"
            >
              {t('modals.addNewAddress.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={isLoading || !formData.address.trim()}
              className="flex-1 px-4 py-3 bg-blue-500/20 hover:bg-blue-500/30 disabled:bg-gray-500/10 disabled:cursor-not-allowed text-blue-600 dark:text-blue-400 disabled:text-gray-500 font-medium rounded-xl border border-blue-500/30 disabled:border-gray-500/20 transition-all flex items-center justify-center gap-2"
            >
              <Home className="w-5 h-5" />
              {isLoading ? t('modals.addNewAddress.adding') : t('modals.addNewAddress.addAddress')}
            </button>
          </div>

          {/* Help Text */}
          <p className="text-xs liquid-glass-modal-text-muted mt-3 text-center">
            {t('modals.addNewAddress.helpText')}
          </p>
        </div>
    </LiquidGlassModal>
  );
};

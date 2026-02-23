import React, { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { getApiUrl } from '../../../config/environment';
import { LiquidGlassModal } from '../ui/pos-glass-components';

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

export const EditCustomerInfoModal: React.FC<EditCustomerInfoModalProps> = ({
  isOpen,
  orderCount,
  initialCustomerInfo,
  onSave,
  onClose
}) => {
  const { t } = useTranslation();
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>(initialCustomerInfo);
  const [isValidating, setIsValidating] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<any[]>([]);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setCustomerInfo(initialCustomerInfo);
      setAddressSuggestions([]);
    }
  }, [isOpen, initialCustomerInfo]);

  // Google Maps address search
  const searchAddresses = async (input: string) => {
    if (input.length < 3) {
      setAddressSuggestions([]);
      return;
    }

    setIsLoadingAddresses(true);
    try {
      // Call the admin dashboard API which uses real Google Maps Places API
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
        setAddressSuggestions(result.places.slice(0, 5)); // Limit to 5 suggestions
      } else {
        setAddressSuggestions([]);
      }
    } catch (error) {
      console.error('Error searching addresses:', error);
      setAddressSuggestions([]);
      toast.error(t('modals.editCustomer.addressSuggestionsFailed'));
    } finally {
      setIsLoadingAddresses(false);
    }
  };

  // Handle address suggestion selection
  const handleAddressSuggestionClick = async (suggestion: any) => {
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

      setCustomerInfo(prev => ({
        ...prev,
        address: fullAddress,
        postal_code: postalCode
      }));
      setAddressSuggestions([]);
      toast.success(t('modals.editCustomer.addressAndPostalUpdated'));
    } catch (error) {
      console.error('Error getting place details:', error);
      // Fallback: just use the suggestion address
      setCustomerInfo(prev => ({
        ...prev,
        address: suggestion.formatted_address
      }));
      setAddressSuggestions([]);
      toast.success(t('modals.editCustomer.addressUpdated'));
    }
  };

  const handleSave = async () => {
    // Validate required fields
    if (!customerInfo.name.trim()) {
      toast.error(t('modals.editCustomer.nameRequired'));
      return;
    }

    if (!customerInfo.phone.trim()) {
      toast.error(t('modals.editCustomer.phoneRequired'));
      return;
    }

    setIsValidating(true);
    
    try {
      // Simulate validation delay
      await new Promise(resolve => setTimeout(resolve, 500));
      onSave(customerInfo);
      setIsValidating(false);
    } catch (error) {
      setIsValidating(false);
      toast.error(t('modals.editCustomer.saveFailed'));
    }
  };

  const handleClose = () => {
    setCustomerInfo(initialCustomerInfo); // Reset form
    setAddressSuggestions([]);
    onClose();
  };

  const handleInputChange = (field: keyof CustomerInfo, value: string) => {
    setCustomerInfo(prev => ({
      ...prev,
      [field]: value
    }));

    // Trigger address search for address field
    if (field === 'address') {
      searchAddresses(value);
    }
  };

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
            {/* Customer Name */}
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

            {/* Phone Number */}
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

            {/* Address with Google Maps Autocomplete */}
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
                {/* Loading indicator */}
                {isLoadingAddresses && (
                  <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                    <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
                  </div>
                )}
              </div>
              
              {/* Address Suggestions Dropdown */}
              {addressSuggestions.length > 0 && (
                <div className="absolute z-60 w-full mt-1 bg-white/90 dark:bg-gray-800/90 border liquid-glass-modal-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {addressSuggestions.map((suggestion, index) => (
                    <button
                      key={index}
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

            {/* Postal Code - Auto-populated */}
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

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
                {t('modals.editCustomer.specialNotes')}
              </label>
              <textarea
                value={customerInfo.notes || ''}
                onChange={(e) => handleInputChange('notes', e.target.value)}
                placeholder={t('modals.editCustomer.specialNotesPlaceholder')}
                className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                rows={3}
                maxLength={300}
              />
              <div className="text-xs liquid-glass-modal-text-muted mt-1">
                {t('modals.editCustomer.characterCount', { current: (customerInfo.notes || '').length, max: 300 })}
              </div>
            </div>
          </div>
          
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              disabled={isValidating}
              className="flex-1 px-4 py-2 border liquid-glass-modal-border liquid-glass-modal-text hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors disabled:opacity-50 rounded-lg"
            >
              {t('modals.editCustomer.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isValidating || !customerInfo.name.trim() || !customerInfo.phone.trim()}
              className={`
                flex-1 px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2
                ${(!customerInfo.name.trim() || !customerInfo.phone.trim() || isValidating)
                  ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
                }
              `}
            >
              {isValidating && (
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              {isValidating ? t('modals.editCustomer.saving') : t('modals.editCustomer.saveChanges')}
            </button>
          </div>

          {/* Help text */}
          <p className="text-xs liquid-glass-modal-text-muted mt-3 text-center">
            {t('modals.editCustomer.helpText')}
          </p>
        </div>
    </LiquidGlassModal>
  );
};

export default EditCustomerInfoModal;
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiUrl } from '../../../config/environment';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface CustomerAddress {
  id: string;
  street_address: string;
  city: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  address_type: string;
  is_default: boolean;
  created_at: string;
}

interface EditAddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  address: CustomerAddress;
  customerId: string;
  onAddressUpdated: (updatedAddress: CustomerAddress) => void;
}

const EditAddressModal: React.FC<EditAddressModalProps> = ({
  isOpen,
  onClose,
  address,
  customerId,
  onAddressUpdated
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    address: '',
    postal_code: '',
    floor_number: '',
    notes: '',
    address_type: 'delivery',
    is_default: false
  });

  useEffect(() => {
    if (isOpen && address) {
      setFormData({
        address: `${address.street_address}, ${address.city}`,
        postal_code: address.postal_code || '',
        floor_number: address.floor_number || '',
        notes: address.notes || '',
        address_type: address.address_type,
        is_default: address.is_default
      });
    }
  }, [isOpen, address]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {

      const response = await fetch(getApiUrl(`customers/${customerId}/addresses/${address.id}`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      if (result.success && result.address) {
        onAddressUpdated(result.address);
        onClose();
      } else {
        console.error('Failed to update address:', result.error);
        alert(t('modals.editAddress.updateFailed', { error: result.error || t('modals.editAddress.unknownError') }));
      }
    } catch (error) {
      console.error('Error updating address:', error);
      alert(t('modals.editAddress.updateError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.editAddress.title')}
      size="md"
      className="max-h-[90vh]"
    >
      <div className="overflow-y-auto">
            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Address Field */}
              <div>
                <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
                  {t('modals.editAddress.streetAddress')}
                </label>
                <input
                  type="text"
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('modals.editAddress.streetPlaceholder')}
                />
              </div>

              {/* Postal Code Field */}
              <div>
                <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
                  {t('modals.editAddress.postalCode')}
                </label>
                <input
                  type="text"
                  name="postal_code"
                  value={formData.postal_code}
                  onChange={handleChange}
                  className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('modals.editAddress.postalPlaceholder')}
                />
              </div>

              {/* Floor Number Field */}
              <div>
                <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
                  {t('modals.editAddress.floorNumber')}
                </label>
                <input
                  type="text"
                  name="floor_number"
                  value={formData.floor_number}
                  onChange={handleChange}
                  className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('modals.editAddress.floorPlaceholder')}
                />
              </div>

              {/* Address Type Field */}
              <div>
                <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
                  {t('modals.editAddress.addressType')}
                </label>
                <select
                  name="address_type"
                  value={formData.address_type}
                  onChange={handleChange}
                  className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="delivery">{t('modals.editAddress.addressTypes.delivery')}</option>
                  <option value="home">{t('modals.editAddress.addressTypes.home')}</option>
                  <option value="work">{t('modals.editAddress.addressTypes.work')}</option>
                  <option value="other">{t('modals.editAddress.addressTypes.other')}</option>
                </select>
              </div>

              {/* Notes Field */}
              <div>
                <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
                  {t('modals.editAddress.deliveryNotes')}
                </label>
                <textarea
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows={3}
                  className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                  placeholder={t('modals.editAddress.notesPlaceholder')}
                />
              </div>

              {/* Default Address Checkbox */}
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  name="is_default"
                  checked={formData.is_default}
                  onChange={handleChange}
                  className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                />
                <label className="text-sm font-medium liquid-glass-modal-text">
                  {t('modals.editAddress.setDefault')}
                </label>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 mt-8">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isLoading}
                  className="flex-1 px-6 py-3 rounded-lg font-medium transition-all bg-gray-200/80 dark:bg-gray-700/80 liquid-glass-modal-text hover:bg-gray-300/80 dark:hover:bg-gray-600/80 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('modals.editAddress.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 px-6 py-3 rounded-lg font-medium transition-all bg-blue-500/90 dark:bg-blue-600/90 text-white hover:bg-blue-600/90 dark:hover:bg-blue-500/90 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                >
                  {isLoading ? t('modals.editAddress.updating') : t('modals.editAddress.updateAddress')}
                </button>
              </div>
            </form>
      </div>
    </LiquidGlassModal>
  );
};

export default EditAddressModal;
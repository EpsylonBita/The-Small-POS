import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { getBridge } from '../../../lib';
import {
  customerAddressWriteErrorText,
  expectCustomerAddressWrite,
} from '../../utils/customer-address-write-refusal';

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
  const bridge = getBridge();
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
      const raw = await bridge.customers.updateAddress(
        address.id,
        {
          customer_id: customerId,
          address: formData.address,
          street_address: formData.address,
          postal_code: formData.postal_code,
          floor_number: formData.floor_number,
          notes: formData.notes,
          address_type: formData.address_type,
          is_default: formData.is_default,
        },
        0,
      );

      // A refusal (INVALID_COORDINATES, NOT_FOUND, a version conflict, this
      // register's own refusals) is named; its `error` is a machine code and
      // is never shown. A queued write (office unreachable) is saved here.
      const result = expectCustomerAddressWrite<CustomerAddress>(t, raw, 'update', 'modals.editAddress.updateError');
      onAddressUpdated(result.data ?? address);
      onClose();
    } catch (error) {
      console.error('Error updating address:', error);
      alert(customerAddressWriteErrorText(t, error, 'modals.editAddress.updateError'));
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

  const fieldClass =
    'liquid-glass-modal-input pos-glass-field min-h-touch w-full px-4 py-2.5';

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.editAddress.title')}
      size="md"
      className="max-w-lg! max-h-[90vh] pos-progressive-form [&_.liquid-glass-modal-header]:border-b-0!"
      footer={(
              <div className="flex gap-3 px-6 pb-5 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isLoading}
                  className="liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
                >
                  {t('modals.editAddress.cancel')}
                </button>
                <button
                  type="submit"
                  form="edit-address-form"
                  disabled={isLoading}
                  className="liquid-glass-modal-button liquid-glass-modal-success flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
                >
                  {isLoading ? t('modals.editAddress.updating') : t('modals.editAddress.updateAddress')}
                </button>
              </div>
      )}
    >
      <div className="overflow-y-auto scrollbar-hide">
            {/* Form */}
            <form onSubmit={handleSubmit} id="edit-address-form" className="space-y-3">
              <div className="pos-glass-form-card space-y-3">
              {/* Address Field */}
              <div>
                <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                  {t('modals.editAddress.streetAddress')}
                </label>
                <input
                  type="text"
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                  required
                  className={fieldClass}
                  placeholder={t('modals.editAddress.streetPlaceholder')}
                />
              </div>

              {/* Postal Code Field */}
              <div>
                <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                  {t('modals.editAddress.postalCode')}
                </label>
                <input
                  type="text"
                  name="postal_code"
                  value={formData.postal_code}
                  onChange={handleChange}
                  className={fieldClass}
                  placeholder={t('modals.editAddress.postalPlaceholder')}
                />
              </div>

              {/* Floor Number Field */}
              <div>
                <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                  {t('modals.editAddress.floorNumber')}
                </label>
                <input
                  type="text"
                  name="floor_number"
                  value={formData.floor_number}
                  onChange={handleChange}
                  className={fieldClass}
                  placeholder={t('modals.editAddress.floorPlaceholder')}
                  maxLength={100}
                />
                {(formData.floor_number?.length ?? 0) >= 100 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    {t('common.validation.maxLength', { count: 100 })}
                  </p>
                )}
              </div>

              {/* Address Type Field */}
              <div>
                <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                  {t('modals.editAddress.addressType')}
                </label>
                <select
                  name="address_type"
                  value={formData.address_type}
                  onChange={handleChange}
                  className={fieldClass}
                >
                  <option value="delivery">{t('modals.editAddress.addressTypes.delivery')}</option>
                  <option value="home">{t('modals.editAddress.addressTypes.home')}</option>
                  <option value="work">{t('modals.editAddress.addressTypes.work')}</option>
                  <option value="other">{t('modals.editAddress.addressTypes.other')}</option>
                </select>
              </div>

              </div>
              {/* Notes Field */}
              <div className="pos-glass-form-card">
                <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                  {t('modals.editAddress.deliveryNotes')}
                </label>
                <textarea
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows={3}
                  className={`${fieldClass} resize-none`}
                  placeholder={t('modals.editAddress.notesPlaceholder')}
                />
              </div>

              {/* Default Address Checkbox */}
              <label className="pos-glass-form-card flex min-h-touch cursor-pointer items-center space-x-3">
                <input
                  type="checkbox"
                  name="is_default"
                  checked={formData.is_default}
                  onChange={handleChange}
                  className="h-5 w-5 shrink-0 rounded-xl accent-yellow-500 focus-visible:outline-2 focus-visible:outline-yellow-400"
                />
                <span className="text-sm font-medium liquid-glass-modal-text">
                  {t('modals.editAddress.setDefault')}
                </span>
              </label>


            </form>
      </div>
    </LiquidGlassModal>
  );
};

export default EditAddressModal;

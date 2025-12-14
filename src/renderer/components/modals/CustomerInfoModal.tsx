import React, { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal, POSGlassButton, POSGlassInput } from '../ui/pos-glass-components';
import { DeliveryValidationComponent } from '../delivery/DeliveryValidationComponent';
import { DeliveryBoundaryValidationResponse } from '../../../../../shared/types/delivery-validation';

interface CustomerInfo {
  name: string;
  phone: string;
  address: string;
  coordinates?: { lat: number; lng: number };
  deliveryValidation?: DeliveryBoundaryValidationResponse;
}

interface CustomerInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (customerInfo: CustomerInfo) => void;
  initialData: CustomerInfo;
  orderType: 'dine-in' | 'pickup' | 'delivery';
  orderAmount?: number;
  staffId?: string;
  staffRole?: 'staff' | 'manager' | 'admin';
}

export const CustomerInfoModal: React.FC<CustomerInfoModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  orderType,
  orderAmount = 0,
  staffId = 'pos_user',
  staffRole = 'staff'
}) => {
  const { t } = useTranslation();
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>(initialData);
  const [deliveryValidation, setDeliveryValidation] = useState<DeliveryBoundaryValidationResponse | null>(null);
  const [canProceed, setCanProceed] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setCustomerInfo(initialData);
      setDeliveryValidation(null);
      setCanProceed(orderType !== 'delivery'); // For delivery, wait for validation
    }
  }, [isOpen, initialData, orderType]);

  const handleValidationResult = (result: DeliveryBoundaryValidationResponse) => {
    setDeliveryValidation(result);
    setCanProceed(result.uiState?.canProceed || false);

    // Update customer info with validation data
    setCustomerInfo(prev => ({
      ...prev,
      deliveryValidation: result,
      coordinates: result.coordinates
    }));
  };

  const handleAddressChange = (address: string, coordinates?: { lat: number; lng: number }) => {
    setCustomerInfo(prev => ({
      ...prev,
      address,
      coordinates
    }));
  };

  const handleSave = () => {
    // Validate required fields
    if (!customerInfo.name.trim()) {
      toast.error(t('modals.customerInfo.nameRequired'));
      return;
    }

    if (!customerInfo.phone.trim()) {
      toast.error(t('modals.customerInfo.phoneRequired'));
      return;
    }

    // Validate phone number format (basic validation)
    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    if (!phoneRegex.test(customerInfo.phone)) {
      toast.error(t('modals.customerInfo.invalidPhone'));
      return;
    }

    // For delivery orders, address and validation are required
    if (orderType === 'delivery') {
      if (!customerInfo.address.trim()) {
        toast.error(t('modals.customerInfo.addressRequired'));
        return;
      }

      if (!canProceed) {
        toast.error(t('modals.customerInfo.resolveValidation'));
        return;
      }

      if (!deliveryValidation?.deliveryAvailable && !deliveryValidation?.override?.applied) {
        toast.error(t('modals.customerInfo.deliveryNotAvailable'));
        return;
      }
    }

    onSave(customerInfo);
    onClose();
  };

  const handleInputChange = (field: keyof CustomerInfo, value: string) => {
    setCustomerInfo(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const getAddressLabel = () => {
    switch (orderType) {
      case 'delivery':
        return t('modals.customerInfo.deliveryAddress');
      case 'dine-in':
        return t('modals.customerInfo.tableNumber');
      case 'pickup':
        return t('modals.customerInfo.notes');
      default:
        return t('modals.customerInfo.address');
    }
  };

  const getAddressPlaceholder = () => {
    switch (orderType) {
      case 'delivery':
        return t('modals.customerInfo.deliveryAddressPlaceholder');
      case 'dine-in':
        return t('modals.customerInfo.tableNumberPlaceholder');
      case 'pickup':
        return t('modals.customerInfo.notesPlaceholder');
      default:
        return t('modals.customerInfo.addressPlaceholder');
    }
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.customerInfo.title')}
      size="md"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="space-y-4">
        {/* Customer Name */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.customerInfo.customerName')}
          </label>
          <POSGlassInput
            type="text"
            value={customerInfo.name}
            onChange={(e) => handleInputChange('name', e.target.value)}
            placeholder={t('modals.customerInfo.customerNamePlaceholder')}
            autoFocus
          />
        </div>

        {/* Phone Number */}
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.customerInfo.phoneNumber')}
          </label>
          <POSGlassInput
            type="tel"
            value={customerInfo.phone}
            onChange={(e) => handleInputChange('phone', e.target.value)}
            placeholder={t('modals.customerInfo.phoneNumberPlaceholder')}
          />
        </div>

        {/* Address/Notes Field with Delivery Validation */}
        <div>
          {orderType === 'delivery' ? (
            <DeliveryValidationComponent
              orderAmount={orderAmount}
              onValidationResult={handleValidationResult}
              onAddressChange={handleAddressChange}
              staffId={staffId}
              staffRole={staffRole}
              className="bg-white/5 border border-white/10 rounded-lg p-4"
            />
          ) : (
            <>
              <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
                {getAddressLabel()}
              </label>
              <POSGlassInput
                type="text"
                value={customerInfo.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                placeholder={getAddressPlaceholder()}
              />
            </>
          )}
        </div>

        {/* Order Type Display */}
        <div className="p-3 bg-white/10 dark:bg-gray-800/20 rounded-lg border liquid-glass-modal-border">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium liquid-glass-modal-text">{t('modals.customerInfo.orderType')}:</span>
            <span className="text-sm font-semibold text-blue-300 capitalize">
              {orderType.replace('-', ' ')}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex space-x-3 mt-6">
          <POSGlassButton
            variant="secondary"
            onClick={onClose}
            className="flex-1"
          >
            {t('modals.customerInfo.cancel')}
          </POSGlassButton>
          <POSGlassButton
            variant="primary"
            onClick={handleSave}
            className={`flex-1 ${!canProceed && orderType === 'delivery' ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={!canProceed && orderType === 'delivery'}
          >
            {orderType === 'delivery' && deliveryValidation?.override?.applied
              ? t('modals.customerInfo.saveOverride')
              : orderType === 'delivery' && !deliveryValidation?.deliveryAvailable
              ? t('modals.customerInfo.saveValidation')
              : t('modals.customerInfo.save')}
          </POSGlassButton>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
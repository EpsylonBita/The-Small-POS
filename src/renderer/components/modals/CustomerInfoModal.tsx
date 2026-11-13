import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal, POSGlassButton, POSGlassInput } from '../ui/pos-glass-components';
import { DeliveryValidationComponent } from '../delivery/DeliveryValidationComponent';
import { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';
import { FloorPresetPicker } from '../forms/FloorPresetPicker';

interface CustomerInfo {
  name: string;
  phone: string;
  address: string;
  floor_number?: string;
  name_on_ringer?: string;
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
  // Presentation only: preserve every existing reveal condition (founder 11/11/2026).
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };
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

      if (!customerInfo.floor_number?.trim()) {
        toast.error(t('modals.customerInfo.floorRequired'));
        return;
      }

      if (!customerInfo.name_on_ringer?.trim()) {
        toast.error(t('modals.customerInfo.nameOnRingerRequired'));
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
      className="max-w-lg! pos-progressive-form [&_.liquid-glass-modal-header]:border-b-0!"
      closeOnBackdrop={true}
      closeOnEscape={true}
      footer={(
        <div className="flex space-x-3 px-6 pb-5 pt-2">
          <POSGlassButton
            variant="error"
            onClick={onClose}
            className="flex-1"
          >
            {t('modals.customerInfo.cancel')}
          </POSGlassButton>
          <POSGlassButton
            variant="success"
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
      )}
    >
      <div className="space-y-3">
        <div className="pos-glass-form-card space-y-3">
        {/* Customer Name */}
        <div>
          <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
            {t('modals.customerInfo.customerName')}
          </label>
          <POSGlassInput
            className="pos-glass-field min-h-touch"
            type="text"
            value={customerInfo.name}
            onChange={(e) => handleInputChange('name', e.target.value)}
            placeholder={t('modals.customerInfo.customerNamePlaceholder')}
            autoFocus
          />
        </div>

        {/* Phone Number */}
        <div>
          <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
            {t('modals.customerInfo.phoneNumber')}
          </label>
          <POSGlassInput
            className="pos-glass-field min-h-touch"
            type="tel"
            value={customerInfo.phone}
            onChange={(e) => handleInputChange('phone', e.target.value)}
            placeholder={t('modals.customerInfo.phoneNumberPlaceholder')}
          />
        </div>

        </div>

        {/* Address/Notes Field with Delivery Validation */}
        <div className="pos-glass-form-card">
          {orderType === 'delivery' ? (
            <DeliveryValidationComponent
              orderAmount={orderAmount}
              onValidationResult={handleValidationResult}
              onAddressChange={handleAddressChange}
              staffId={staffId}
              staffRole={staffRole}
              initialAddress={customerInfo.address}
              className="pos-glass-form-card"
            />
          ) : (
            <>
              <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
                {getAddressLabel()}
              </label>
              <POSGlassInput
                className="pos-glass-field min-h-touch"
                type="text"
                value={customerInfo.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                placeholder={getAddressPlaceholder()}
              />
            </>
          )}
        </div>

        <AnimatePresence initial={false}>

          {orderType === 'delivery' && (
          <motion.div {...revealMotion} key="reveal-1" className="pos-glass-form-card grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FloorPresetPicker
              value={customerInfo.floor_number || ''}
              onChange={(value) => handleInputChange('floor_number', value)}
              label={t('modals.customerInfo.floorNumber')}
              placeholder={t('modals.addCustomer.floorPlaceholder')}
              inputClassName="liquid-glass-modal-input pos-glass-field min-h-touch w-full"
              required
            />

            <div>
              <label className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
                {t('modals.customerInfo.nameOnRinger')}
              </label>
              <POSGlassInput
                className="pos-glass-field min-h-touch"
                type="text"
                value={customerInfo.name_on_ringer || ''}
                onChange={(e) => handleInputChange('name_on_ringer', e.target.value)}
                placeholder={t('modals.addCustomer.nameOnRingerPlaceholder')}
                required
                aria-required="true"
              />
            </div>
          </motion.div>
          )}
        </AnimatePresence>

        {/* Order Type Display */}
        <div className="pos-glass-form-card p-3!">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium liquid-glass-modal-text">{t('modals.customerInfo.orderType')}:</span>
            <span className="text-sm font-semibold liquid-glass-modal-text capitalize">
              {orderType.replace('-', ' ')}
            </span>
          </div>
        </div>


      </div>
    </LiquidGlassModal>
  );
};

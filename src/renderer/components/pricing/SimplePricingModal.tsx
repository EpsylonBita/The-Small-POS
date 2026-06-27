import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, ShoppingBag, Truck } from 'lucide-react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';

interface PricingData {
  pickup_price: number;
  delivery_price: number;
}

interface SimplePricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (pricing: PricingData) => void;
  initialPricing?: PricingData;
  title?: string;
}

const SimplePricingModal: React.FC<SimplePricingModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialPricing = { pickup_price: 0, delivery_price: 0 },
  title
}) => {
  const [formData, setFormData] = useState<PricingData>(initialPricing);
  const { t } = useTranslation();
  const titleToShow = title ?? t('modals.simplePricing.title');

  const handleChange = (field: keyof PricingData, value: number) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onClose();
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={titleToShow}
      size="sm"
      className="max-w-xl"
      contentClassName="space-y-5"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="liquid-glass-modal-card space-y-4 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-yellow-400 text-black shadow-[0_10px_24px_rgba(250,204,21,0.22)]">
              <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="liquid-glass-modal-text text-lg font-semibold">
                {t('modals.simplePricing.orderTypePricing')}
              </h3>
              <p className="liquid-glass-modal-text-muted mt-1 text-sm leading-5">
                {t('modals.simplePricing.pricingHelp')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="pickup_price"
                className="flex items-center gap-2 text-sm font-semibold liquid-glass-modal-text"
              >
                <ShoppingBag className="h-4 w-4 text-yellow-400" aria-hidden="true" />
                {t('modals.simplePricing.pickupPrice')}
              </label>
              <input
                type="number"
                id="pickup_price"
                value={formData.pickup_price}
                onChange={(e) => handleChange('pickup_price', parseFloat(e.target.value) || 0)}
                step="0.01"
                min="0"
                className="liquid-glass-modal-input w-full px-3 py-3 focus:ring-2 focus:ring-yellow-400/60"
                placeholder={t('forms.placeholders.amount')}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="delivery_price"
                className="flex items-center gap-2 text-sm font-semibold liquid-glass-modal-text"
              >
                <Truck className="h-4 w-4 text-emerald-500 dark:text-emerald-300" aria-hidden="true" />
                {t('modals.simplePricing.deliveryPrice')}
              </label>
              <input
                type="number"
                id="delivery_price"
                value={formData.delivery_price}
                onChange={(e) => handleChange('delivery_price', parseFloat(e.target.value) || 0)}
                step="0.01"
                min="0"
                className="liquid-glass-modal-input w-full px-3 py-3 focus:ring-2 focus:ring-yellow-400/60"
                placeholder={t('forms.placeholders.amount')}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
          <POSGlassButton
            type="button"
            variant="error"
            fullWidth
            onClick={onClose}
            className="justify-center"
          >
            {t('common.actions.cancel', 'Cancel')}
          </POSGlassButton>
          <POSGlassButton
            type="submit"
            variant="success"
            fullWidth
            icon={<Save className="h-4 w-4" aria-hidden="true" />}
            className="justify-center"
          >
            {t('modals.simplePricing.savePricing')}
          </POSGlassButton>
        </div>
      </form>
    </LiquidGlassModal>
  );
};

export default SimplePricingModal;

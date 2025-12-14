import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Save, Truck, ShoppingBag } from 'lucide-react';

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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-md transform transition-all duration-300">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            {titleToShow}
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Order Type Pricing Section */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <ShoppingBag className="h-5 w-5" />
              Order Type Pricing
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Pickup Price */}
              <div className="space-y-2">
                <label 
                  htmlFor="pickup_price" 
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2"
                >
                  <ShoppingBag className="h-4 w-4 text-blue-500" />
                  Pickup Price (€)
                </label>
                <input
                  type="number"
                  id="pickup_price"
                  value={formData.pickup_price}
                  onChange={(e) => handleChange('pickup_price', parseFloat(e.target.value) || 0)}
                  step="0.01"
                  min="0"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder={t('forms.placeholders.amount')}
                />
              </div>

              {/* Delivery Price */}
              <div className="space-y-2">
                <label 
                  htmlFor="delivery_price" 
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2"
                >
                  <Truck className="h-4 w-4 text-emerald-500" />
                  Delivery Price (€)
                </label>
                <input
                  type="number"
                  id="delivery_price"
                  value={formData.delivery_price}
                  onChange={(e) => handleChange('delivery_price', parseFloat(e.target.value) || 0)}
                  step="0.01"
                  min="0"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder={t('forms.placeholders.amount')}
                />
              </div>
            </div>
            
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
              Set different prices for pickup and delivery orders. This allows for flexible pricing strategies.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
              <Save className="h-4 w-4" />
              Save Pricing
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SimplePricingModal;
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useAcquiredModules } from '../../hooks/useAcquiredModules';
import { Package, Truck, Utensils } from 'lucide-react';

interface OrderTypeSelectorProps {
  orderType: "dine-in" | "pickup" | "delivery";
  setOrderType: React.Dispatch<React.SetStateAction<"dine-in" | "pickup" | "delivery">>;
}

/**
 * OrderTypeSelector Component
 * 
 * Displays order type options (dine-in, pickup, delivery) based on acquired modules.
 * Delivery option is only shown when the delivery module is acquired.
 * 
 * Requirements: 10.2, 10.3
 * - 10.2: Hide delivery order type when module not acquired
 * - 10.3: Enable delivery features on module acquisition
 */
export const OrderTypeSelector: React.FC<OrderTypeSelectorProps> = ({
  orderType,
  setOrderType,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { hasDeliveryModule } = useAcquiredModules();

  // Filter available order types based on acquired modules
  const availableOrderTypes = useMemo(() => {
    const types: Array<"dine-in" | "pickup" | "delivery"> = ["dine-in", "pickup"];
    if (hasDeliveryModule) {
      types.push("delivery");
    }
    return types;
  }, [hasDeliveryModule]);

  // Determine grid columns based on available types
  const gridCols = availableOrderTypes.length === 3 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div>
      <h3 className={`text-lg font-semibold mb-3 ${
        resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
      }`}>{t('forms.orderType.header')}</h3>
      <div className={`grid ${gridCols} gap-4`}>
        {availableOrderTypes.map((type) => (
          <button
            key={type}
            onClick={() => setOrderType(type)}
            className={`p-4 border rounded-lg text-center transition-all duration-300 backdrop-blur-sm ${
              orderType === type
                ? "border-blue-500 bg-blue-50 text-blue-700"
                : resolvedTheme === 'dark'
                  ? "border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500/70 hover:bg-gray-700/50"
                  : "border-gray-200 bg-white/50 text-gray-700 hover:border-gray-300 hover:bg-white/70"
            } hover:scale-[1.02] transform focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
          >
            <div className="text-2xl mb-2 flex items-center justify-center">
              {type === "dine-in" && <Utensils className="w-6 h-6" />}
              {type === "pickup" && <Package className="w-6 h-6" />}
              {type === "delivery" && <Truck className="w-6 h-6" />}
            </div>
            <div className="font-medium capitalize">
              {type === "dine-in"
                ? t('forms.orderType.dineIn')
                : type === "pickup"
                  ? t('forms.orderType.pickup')
                  : t('forms.orderType.delivery')}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}; 

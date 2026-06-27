import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useAcquiredModules } from '../../hooks/useAcquiredModules';
import { Truck } from 'lucide-react';
import TableOrderIcon from '../icons/TableOrderIcon';
import PickupOrderIcon from '../icons/PickupOrderIcon';

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
  const { hasDeliveryModule, hasTablesModule } = useAcquiredModules();

  // Filter available order types based on acquired modules. Pickup is always available; dine-in
  // requires the Tables module (it seats a table), delivery requires the Delivery module.
  const availableOrderTypes = useMemo(() => {
    const types: Array<"dine-in" | "pickup" | "delivery"> = [];
    if (hasTablesModule) {
      types.push("dine-in");
    }
    types.push("pickup");
    if (hasDeliveryModule) {
      types.push("delivery");
    }
    return types;
  }, [hasTablesModule, hasDeliveryModule]);

  // Determine grid columns based on available types (1, 2, or 3 options).
  const gridCols =
    availableOrderTypes.length === 3
      ? 'grid-cols-3'
      : availableOrderTypes.length === 2
        ? 'grid-cols-2'
        : 'grid-cols-1';

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
            className={`flex flex-col items-center justify-center min-h-[88px] p-4 border rounded-2xl text-center transition-all duration-300 backdrop-blur-sm ${
              orderType === type
                ? resolvedTheme === 'dark'
                  ? "border-yellow-400/50 bg-yellow-400/15 text-yellow-200"
                  : "border-yellow-400 bg-yellow-400 text-black"
                : resolvedTheme === 'dark'
                  ? "border-gray-600/50 bg-gray-700/30 text-gray-300 active:border-gray-500/70 active:bg-gray-700/50"
                  : "border-gray-200 bg-white/50 text-gray-700 active:border-gray-300 active:bg-white/70"
            } active:scale-[0.98] transform focus:outline-none focus:ring-2 focus:ring-yellow-400/40`}
          >
            <div className="text-2xl mb-2 flex items-center justify-center">
              {type === "dine-in" && <TableOrderIcon className="w-6 h-6" />}
              {type === "pickup" && <PickupOrderIcon className="w-6 h-6" />}
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

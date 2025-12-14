import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { Plus, Minus } from 'lucide-react';

interface CustomizationOption {
  id: string;
  name: string;
  price: number;
}

interface Customization {
  id: string;
  name: string;
  required: boolean;
  options: CustomizationOption[];
}

interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  preparationTime: number;
  image?: string;
  is_customizable?: boolean;
  customizations?: Customization[];
}

interface MenuItemCardProps {
  item: MenuItem;
  orderType?: 'pickup' | 'delivery';
  onSelect: () => void;
  onQuickAdd?: (item: MenuItem, quantity: number) => void;
}

export const MenuItemCard: React.FC<MenuItemCardProps> = ({ item, orderType = 'delivery', onSelect, onQuickAdd }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [quickQuantity, setQuickQuantity] = useState(1);
  const [showQuantitySelector, setShowQuantitySelector] = useState(false);

  // For customizable items, always open the modal
  // For non-customizable items, show quick add with quantity selector
  const handleCardClick = () => {
    if (item.is_customizable) {
      onSelect();
    } else if (onQuickAdd) {
      setShowQuantitySelector(true);
    } else {
      onSelect();
    }
  };

  const handleQuickAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onQuickAdd) {
      onQuickAdd(item, quickQuantity);
      setQuickQuantity(1);
      setShowQuantitySelector(false);
    }
  };

  const handleIncrement = (e: React.MouseEvent) => {
    e.stopPropagation();
    setQuickQuantity(prev => prev + 1);
  };

  const handleDecrement = (e: React.MouseEvent) => {
    e.stopPropagation();
    setQuickQuantity(prev => Math.max(1, prev - 1));
  };

  const handleCancelQuickAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    setQuickQuantity(1);
    setShowQuantitySelector(false);
  };

  return (
    <div
      onClick={handleCardClick}
      className={`p-2 sm:p-3 rounded-xl border cursor-pointer transition-all duration-200 hover:scale-[1.02] sm:hover:scale-[1.05] active:scale-95 aspect-square flex flex-col touch-feedback min-h-[100px] sm:min-h-[120px] relative ${
        resolvedTheme === 'dark'
          ? 'bg-gray-700/30 border-gray-600/30 hover:bg-gray-700/50 hover:border-gray-500/50 active:bg-gray-600/50'
          : 'bg-white/30 border-gray-200/30 hover:bg-white/50 hover:border-gray-300/50 active:bg-gray-100/50'
      }`}
      role="button"
      tabIndex={0}
      aria-label={`Select ${item.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      {/* Quick Quantity Selector Overlay */}
      {showQuantitySelector && !item.is_customizable && (
        <div
          className={`absolute inset-0 rounded-xl flex flex-col items-center justify-center z-10 backdrop-blur-sm ${
            resolvedTheme === 'dark' ? 'bg-gray-800/95' : 'bg-white/95'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <span className={`text-xs mb-2 font-medium ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {t('menu.item.quantity')}
          </span>
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={handleDecrement}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-600 hover:bg-gray-500 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
            >
              <Minus size={16} />
            </button>
            <span className={`text-xl font-bold min-w-[2rem] text-center ${
              resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
            }`}>
              {quickQuantity}
            </span>
            <button
              onClick={handleIncrement}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-600 hover:bg-gray-500 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCancelQuickAdd}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-600 hover:bg-gray-500 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
            >
              {t('common.actions.cancel')}
            </button>
            <button
              onClick={handleQuickAdd}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white transition-all"
            >
              {t('common.actions.add')} ({quickQuantity})
            </button>
          </div>
        </div>
      )}

      {/* Customizable Label - Orange Text Only */}
      {item.is_customizable && (
        <div className="mb-1.5">
          <span className="text-xs font-medium text-orange-500">
            {t('menu.item.customizable')}
          </span>
        </div>
      )}

      {/* Item Name - Compact */}
      <h3 className={`text-xs sm:text-sm font-bold mb-1 sm:mb-2 line-clamp-2 ${
        resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
      }`}>
        {item.name}
      </h3>

      {/* Spacer to push price to bottom */}
      <div className="flex-1" />

      {/* Price Section - Compact */}
      <div className="flex flex-col">
        <span className={`text-sm sm:text-base font-bold ${
          resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
        }`}>
          {item.is_customizable ? t('menu.item.from') : ''}€{item.price.toFixed(2)}
        </span>
        <span className={`text-[10px] sm:text-xs ${
          resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
        }`}>
          {orderType === 'pickup' ? t('menu.item.pickup') : t('menu.item.delivery')}
        </span>
      </div>
    </div>
  );
};

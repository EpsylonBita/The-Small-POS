import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { Plus, Minus, Settings2 } from 'lucide-react';

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
  ingredients?: string[] | null;
  customizations?: Customization[];
}

interface MenuItemCardProps {
  item: MenuItem;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onSelect: () => void;
  onQuickAdd?: (item: MenuItem, quantity: number) => void;
  onPreview?: (item: MenuItem, anchorRect: DOMRect) => void;
}

export const MenuItemCard: React.FC<MenuItemCardProps> = ({ item, onSelect, onQuickAdd, onPreview }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  const [quickQuantity, setQuickQuantity] = useState(1);
  const [showQuantitySelector, setShowQuantitySelector] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handlePointerDown = () => {
    clearHoldTimer();
    suppressNextClickRef.current = false;
    holdTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = true;
      if (cardRef.current) {
        onPreview?.(item, cardRef.current.getBoundingClientRect());
      }
    }, 550);
  };

  const handlePointerEnd = () => {
    clearHoldTimer();
  };

  // For customizable items, always open the modal
  // For non-customizable items, add directly to cart with quantity 1
  const handleCardClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (item.is_customizable) {
      onSelect();
    } else if (onQuickAdd) {
      onQuickAdd(item, 1); // Add directly to cart - quantity can be adjusted in cart
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
      ref={cardRef}
      onClick={handleCardClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      className={`p-3 rounded-xl border cursor-pointer transition-colors duration-150 active:scale-[0.98] flex flex-col touch-feedback min-h-[132px] sm:min-h-[144px] relative ${
        item.is_customizable
          ? resolvedTheme === 'dark'
            ? 'bg-orange-500/15 border-orange-500/30 active:bg-orange-500/25'
            : 'bg-amber-100/95 border-amber-400/90 shadow-[0_10px_24px_rgba(15,23,42,0.08)] active:bg-amber-200/80'
          : resolvedTheme === 'dark'
            ? 'bg-gray-700/30 border-gray-600/30 active:bg-gray-600/50'
            : 'bg-white border-slate-300/80 shadow-[0_10px_24px_rgba(15,23,42,0.08)] active:bg-slate-50'
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

      {/* Customizable indicator */}
      {item.is_customizable && (
        <div className="mb-1.5">
          <Settings2
            className={`h-5 w-5 ${resolvedTheme === 'dark' ? 'text-orange-300' : 'text-amber-800'}`}
            aria-label={t('menu.item.customizable')}
            role="img"
          />
        </div>
      )}

      {/* Item Name - Larger and Clearer */}
      <h3 className={`text-lg font-bold mb-1.5 line-clamp-2 leading-tight antialiased ${
        resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
      }`}>
        {item.name}
      </h3>

      {/* Item Description */}
      {item.description && (
        <p className={`text-sm font-semibold leading-snug line-clamp-2 mb-1.5 antialiased ${
          resolvedTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-800'
        }`}>
          {item.description}
        </p>
      )}

      {/* Spacer to push price to bottom */}
      <div className="flex-1 min-h-1" />

      {/* Price Section - Clear and Readable */}
      <div className="mt-auto flex justify-end">
        <span className={`text-lg font-extrabold tracking-tight antialiased text-right ${
          resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-800'
        }`}>
          {item.is_customizable ? t('menu.item.from') : ''}€{item.price.toFixed(2)}
        </span>
      </div>
    </div>
  );
};

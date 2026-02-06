import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { Package, Shuffle, Gift, Tag } from 'lucide-react';
import { formatCurrency } from '../../utils/format';
import type { MenuCombo } from '@shared/types/combo';
import { getComboPrice, calculateComboSavings } from '@shared/types/combo';

interface ComboCardProps {
  combo: MenuCombo;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onSelect: (combo: MenuCombo) => void;
}

export const ComboCard: React.FC<ComboCardProps> = ({ combo, orderType = 'pickup', onSelect }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { language } = useI18n();

  const price = getComboPrice(combo, orderType);
  const savings = calculateComboSavings(combo, orderType);
  const name = language === 'el' && combo.name_el ? combo.name_el : combo.name_en;
  const description = language === 'el' && combo.description_el ? combo.description_el : combo.description_en;

  const getTypeIcon = () => {
    switch (combo.combo_type) {
      case 'choice': return <Shuffle className="w-3.5 h-3.5" />;
      case 'bogo': return <Gift className="w-3.5 h-3.5" />;
      default: return <Package className="w-3.5 h-3.5" />;
    }
  };

  const getTypeLabel = () => {
    switch (combo.combo_type) {
      case 'choice': return t('menu.combos.types.choice', 'Choice');
      case 'bogo': return t('menu.combos.types.bogo', 'Offer');
      default: return t('menu.combos.types.fixed', 'Combo');
    }
  };

  const getBogoLabel = () => {
    if (combo.combo_type !== 'bogo') return null;
    const buy = combo.buy_quantity || 2;
    const get = combo.get_quantity || 1;
    const discount = combo.get_discount_percent ?? 100;
    const isFree = discount === 100;
    return t('menu.combos.bogo.shortLabel', {
      buy,
      get,
      discount: isFree ? t('menu.combos.bogo.free', 'FREE') : `${discount}% off`,
      defaultValue: `Buy ${buy} Get ${get} ${isFree ? 'FREE' : `${discount}% off`}`,
    });
  };

  const getItemsList = () => {
    if (combo.combo_type === 'bogo') return null;
    if (!combo.items || combo.items.length === 0) return null;

    return combo.items.slice(0, 3).map((item, index) => {
      const qty = item.quantity > 1 ? `${item.quantity}x ` : '';
      if (item.selection_type === 'category_choice' && item.category) {
        const catName = language === 'el' && item.category.name_el
          ? item.category.name_el
          : item.category.name || item.category.name_en || '';
        return (
          <span key={index} className={`text-xs ${resolvedTheme === 'dark' ? 'text-blue-400' : 'text-blue-600'}`}>
            {qty}{t('menu.combos.anyFrom', { category: catName, defaultValue: `Any ${catName}` })}
          </span>
        );
      }

      const itemName = item.subcategory
        ? (language === 'el' && item.subcategory.name_el ? item.subcategory.name_el : item.subcategory.name || item.subcategory.name_en || '')
        : '';
      return (
        <span key={index} className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
          {qty}{itemName}
        </span>
      );
    });
  };

  return (
    <div
      onClick={() => onSelect(combo)}
      className={`relative flex flex-col rounded-xl border transition-all duration-200 cursor-pointer
        hover:scale-[1.02] active:scale-[0.98] overflow-hidden
        ${resolvedTheme === 'dark'
          ? 'bg-gray-800 border-gray-700 hover:border-blue-500'
          : 'bg-white border-gray-200 hover:border-blue-400 hover:shadow-md'
        }`}
    >
      {/* Image or gradient header */}
      {combo.image_url ? (
        <div className="relative h-28 overflow-hidden">
          <img
            src={combo.image_url}
            alt={name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        </div>
      ) : (
        <div className={`h-16 flex items-center justify-center ${
          combo.combo_type === 'bogo'
            ? 'bg-gradient-to-r from-amber-500/20 to-orange-500/20'
            : combo.combo_type === 'choice'
              ? 'bg-gradient-to-r from-blue-500/20 to-indigo-500/20'
              : 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20'
        }`}>
          {React.cloneElement(getTypeIcon() as React.ReactElement<{ className?: string }>, { className: 'w-8 h-8 opacity-40' })}
        </div>
      )}

      {/* Type badge */}
      <div className={`absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
        ${combo.combo_type === 'bogo'
          ? 'bg-amber-500 text-white'
          : combo.combo_type === 'choice'
            ? 'bg-blue-500 text-white'
            : 'bg-emerald-500 text-white'
        }`}
      >
        {getTypeIcon()}
        {getTypeLabel()}
      </div>

      {/* Savings badge */}
      {savings > 0 && (
        <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-red-500 text-white">
          <Tag className="w-3 h-3" />
          -{formatCurrency(savings)}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 p-3">
        <h3 className={`font-semibold text-sm leading-tight antialiased ${
          resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
        }`}>
          {name}
        </h3>

        {description && (
          <p className={`mt-1 text-xs line-clamp-2 antialiased ${
            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
          }`}>
            {description}
          </p>
        )}

        {/* BOGO label */}
        {combo.combo_type === 'bogo' && (
          <div className={`mt-2 px-2 py-1 rounded text-xs font-semibold text-center ${
            resolvedTheme === 'dark'
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-amber-50 text-amber-700'
          }`}>
            {getBogoLabel()}
          </div>
        )}

        {/* Items list (for fixed/choice combos) */}
        {combo.combo_type !== 'bogo' && combo.items && combo.items.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {getItemsList()}
            {combo.items.length > 3 && (
              <span className={`text-xs ${resolvedTheme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                +{combo.items.length - 3} {t('common.more', 'more')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Price footer */}
      <div className={`px-3 pb-3 pt-1 border-t ${
        resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-100'
      }`}>
        <span className={`text-lg font-bold antialiased ${
          resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
        }`}>
          {combo.combo_type === 'bogo' ? (
            <span className="text-sm">{t('menu.combos.bogo.autoApplied', 'Auto-applied')}</span>
          ) : (
            formatCurrency(price)
          )}
        </span>
      </div>
    </div>
  );
};

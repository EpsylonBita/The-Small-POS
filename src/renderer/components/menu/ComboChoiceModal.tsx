import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { X, Check, ChevronDown } from 'lucide-react';
import { formatCurrency } from '../../utils/format';
import { menuService, MenuItem } from '../../services/MenuService';
import type { MenuCombo, MenuComboItem } from '@shared/types/combo';

interface ComboChoiceModalProps {
  isOpen: boolean;
  combo: MenuCombo;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onClose: () => void;
  onConfirm: (combo: MenuCombo, chosenItems: ChosenComboItem[]) => void;
}

export interface ChosenComboItem {
  slotIndex: number;
  subcategory_id: string;
  name: string;
  name_en?: string;
  name_el?: string;
  quantity: number;
  unit_price: number;
}

export const ComboChoiceModal: React.FC<ComboChoiceModalProps> = ({
  isOpen,
  combo,
  orderType = 'pickup',
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { language } = useI18n();

  // State: chosen item for each category_choice slot
  const [choices, setChoices] = useState<Record<number, ChosenComboItem | null>>({});
  // Category items fetched from menu service
  const [categoryItems, setCategoryItems] = useState<Record<string, MenuItem[]>>({});
  const [loading, setLoading] = useState(false);
  // Dropdown open state
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);

  // Get combo items sorted by display_order
  const comboItems = (combo.items || []).sort((a, b) => a.display_order - b.display_order);

  // Identify category_choice slots
  const choiceSlots = comboItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.selection_type === 'category_choice' && item.category_id);

  // Fetch items for each category used in choice slots
  useEffect(() => {
    if (!isOpen) return;
    const categoryIds = [...new Set(choiceSlots.map(({ item }) => item.category_id!))];
    if (categoryIds.length === 0) return;

    const fetchCategoryItems = async () => {
      setLoading(true);
      try {
        const results: Record<string, MenuItem[]> = {};
        for (const catId of categoryIds) {
          const items = await menuService.getMenuItemsByCategory(catId);
          results[catId] = items;
        }
        setCategoryItems(results);
      } catch (err) {
        console.error('Error fetching category items for combo choice:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchCategoryItems();
  }, [isOpen, combo.id]);

  // Reset choices when modal opens
  useEffect(() => {
    if (isOpen) {
      setChoices({});
      setOpenDropdown(null);
    }
  }, [isOpen]);

  const getItemPrice = (item: MenuItem) => {
    if (orderType === 'delivery') return item.delivery_price || item.price;
    if (orderType === 'dine-in') return item.dine_in_price || item.pickup_price || item.price;
    return item.pickup_price || item.price;
  };

  const handleSelectItem = (slotIndex: number, comboItem: MenuComboItem, menuItem: MenuItem) => {
    const name = language === 'el' && menuItem.name_el ? menuItem.name_el : menuItem.name;
    setChoices((prev) => ({
      ...prev,
      [slotIndex]: {
        slotIndex,
        subcategory_id: menuItem.id,
        name: name || '',
        name_en: menuItem.name_en || menuItem.name,
        name_el: menuItem.name_el,
        quantity: comboItem.quantity,
        unit_price: getItemPrice(menuItem),
      },
    }));
    setOpenDropdown(null);
  };

  // Check if all choice slots are filled
  const allChoicesFilled = choiceSlots.every(({ index }) => choices[index] != null);

  const handleConfirm = () => {
    // Build the full list of chosen items
    const chosenItems: ChosenComboItem[] = comboItems.map((item, index) => {
      if (item.selection_type === 'category_choice' && choices[index]) {
        return choices[index]!;
      }
      // Fixed/specific items
      const name = item.subcategory
        ? (language === 'el' && item.subcategory.name_el ? item.subcategory.name_el : item.subcategory.name || item.subcategory.name_en || '')
        : '';
      return {
        slotIndex: index,
        subcategory_id: item.subcategory_id || '',
        name,
        name_en: item.subcategory?.name_en,
        name_el: item.subcategory?.name_el,
        quantity: item.quantity,
        unit_price: item.subcategory ? getSubcategoryPrice(item.subcategory) : 0,
      };
    });
    onConfirm(combo, chosenItems);
  };

  const getSubcategoryPrice = (sub: NonNullable<MenuComboItem['subcategory']>) => {
    if (orderType === 'delivery') return sub.delivery_price ?? sub.pickup_price ?? sub.base_price;
    if (orderType === 'dine-in') return sub.dine_in_price ?? sub.pickup_price ?? sub.base_price;
    return sub.pickup_price ?? sub.base_price;
  };

  if (!isOpen) return null;

  const comboName = language === 'el' && combo.name_el ? combo.name_el : combo.name_en;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1050]" onClick={onClose}>
      <div
        className={`relative w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden ${
          resolvedTheme === 'dark' ? 'bg-gray-800' : 'bg-white'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${
          resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
        }`}>
          <h2 className={`text-lg font-bold ${
            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
          }`}>
            {comboName}
          </h2>
          <button onClick={onClose} className={`p-1 rounded-full ${
            resolvedTheme === 'dark' ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
          }`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-3 scrollbar-hide">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : (
            comboItems.map((item, index) => {
              const isChoice = item.selection_type === 'category_choice' && item.category_id;
              const chosen = choices[index];

              if (!isChoice) {
                // Fixed item - just display
                const name = item.subcategory
                  ? (language === 'el' && item.subcategory.name_el ? item.subcategory.name_el : item.subcategory.name || item.subcategory.name_en || '')
                  : '';
                return (
                  <div key={index} className={`flex items-center gap-3 rounded-lg border p-3 ${
                    resolvedTheme === 'dark' ? 'border-gray-700 bg-gray-750' : 'border-gray-200 bg-gray-50'
                  }`}>
                    <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    <span className={`font-medium flex-1 ${
                      resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                    }`}>
                      {item.quantity > 1 && `${item.quantity}x `}{name}
                    </span>
                  </div>
                );
              }

              // Category choice slot - dropdown
              const catItems = categoryItems[item.category_id!] || [];
              const catName = item.category
                ? (language === 'el' && item.category.name_el ? item.category.name_el : item.category.name || item.category.name_en || '')
                : '';

              return (
                <div key={index} className="space-y-1">
                  <label className={`text-xs font-semibold uppercase tracking-wider ${
                    resolvedTheme === 'dark' ? 'text-blue-400' : 'text-blue-600'
                  }`}>
                    {item.quantity > 1 && `${item.quantity}x `}
                    {t('menu.combos.choice.pickFrom', { category: catName, defaultValue: `Pick from ${catName}` })}
                  </label>
                  <div className="relative">
                    <button
                      onClick={() => setOpenDropdown(openDropdown === index ? null : index)}
                      className={`w-full flex items-center justify-between rounded-lg border p-3 transition-colors ${
                        chosen
                          ? resolvedTheme === 'dark'
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-blue-400 bg-blue-50'
                          : resolvedTheme === 'dark'
                            ? 'border-gray-600 hover:border-gray-500'
                            : 'border-gray-300 hover:border-gray-400'
                      }`}
                    >
                      <span className={chosen
                        ? resolvedTheme === 'dark' ? 'text-white font-medium' : 'text-gray-900 font-medium'
                        : resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                      }>
                        {chosen ? chosen.name : t('menu.combos.choice.selectItem', 'Select an item...')}
                      </span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${openDropdown === index ? 'rotate-180' : ''} ${
                        resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                      }`} />
                    </button>

                    {openDropdown === index && (
                      <div className={`absolute left-0 right-0 mt-1 rounded-lg border shadow-lg z-10 max-h-48 overflow-y-auto scrollbar-hide ${
                        resolvedTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                      }`}>
                        {catItems.length === 0 ? (
                          <div className={`p-3 text-sm ${
                            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            {t('menu.combos.choice.noItems', 'No items available')}
                          </div>
                        ) : (
                          catItems.map((menuItem) => {
                            const itemName = language === 'el' && menuItem.name_el
                              ? menuItem.name_el : menuItem.name;
                            const isSelected = chosen?.subcategory_id === menuItem.id;
                            return (
                              <button
                                key={menuItem.id}
                                onClick={() => handleSelectItem(index, item, menuItem)}
                                className={`w-full flex items-center justify-between p-3 text-left transition-colors ${
                                  isSelected
                                    ? resolvedTheme === 'dark'
                                      ? 'bg-blue-500/20'
                                      : 'bg-blue-50'
                                    : resolvedTheme === 'dark'
                                      ? 'hover:bg-gray-700'
                                      : 'hover:bg-gray-50'
                                }`}
                              >
                                <span className={resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}>
                                  {itemName}
                                </span>
                                <span className={`text-sm ${
                                  resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                                }`}>
                                  {formatCurrency(getItemPrice(menuItem))}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className={`p-4 border-t ${
          resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
        }`}>
          <button
            onClick={handleConfirm}
            disabled={!allChoicesFilled}
            className={`w-full py-3 rounded-xl font-semibold transition-all ${
              allChoicesFilled
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-400 text-gray-500 cursor-not-allowed'
            }`}
          >
            {t('menu.combos.choice.addToCart', 'Add to Cart')}
          </button>
        </div>
      </div>
    </div>
  );
};

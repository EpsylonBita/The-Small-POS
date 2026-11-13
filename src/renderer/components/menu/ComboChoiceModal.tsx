import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { Check, ChevronDown } from 'lucide-react';
import { formatCurrency } from '../../utils/format';
import { menuService, MenuItem } from '../../services/MenuService';
import type { MenuCombo, MenuComboItem } from '@shared/types/combo';
import { LiquidGlassModal } from '../ui/pos-glass-components';

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
  const reduceMotion = useReducedMotion();
  // Choice results contain dropdowns: reveal without height/overflow clipping.
  const resultsMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0 },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const },
  };
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { language } = useI18n();
  const isDark = resolvedTheme === 'dark';

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
  const footer = (
    <div className="px-6 pb-5 pt-2">
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!allChoicesFilled}
        className={`min-h-touch w-full rounded-2xl border py-3 font-semibold transition-transform duration-150 ${
          allChoicesFilled
            ? 'border-(--pos-s-yellow) bg-(--pos-s-yellow) text-black active:scale-[0.98] active:bg-yellow-500'
            : isDark
              ? 'cursor-not-allowed border-white/10 bg-white/6 text-white/35'
              : 'cursor-not-allowed border-black/10 bg-black/6 text-black/35'
        }`}
      >
        {t('menu.combos.choice.addToCart', 'Add to Cart')}
      </button>
    </div>
  );

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={comboName}
      size="sm"
      className="max-w-lg [&_.liquid-glass-modal-header]:border-b-0!"
      contentClassName="max-h-[60vh] overflow-y-auto p-4 scrollbar-hide"
      footer={footer}
    >
      <div className="space-y-3">
          <AnimatePresence initial={false}>{loading ? (
            <motion.div key="loading" {...resultsMotion} className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
            </motion.div>
          ) : (
            <motion.div key="choices" {...resultsMotion} className="space-y-3">{comboItems.map((item, index) => {
              const isChoice = item.selection_type === 'category_choice' && item.category_id;
              const chosen = choices[index];

              if (!isChoice) {
                // Fixed item - just display
                const name = item.subcategory
                  ? (language === 'el' && item.subcategory.name_el ? item.subcategory.name_el : item.subcategory.name || item.subcategory.name_en || '')
                  : '';
                return (
                  <div key={index} className="pos-glass-form-card p-3! flex items-center gap-3">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="font-medium flex-1 liquid-glass-modal-text">
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
                <div key={index} className="pos-glass-form-card space-y-1">
                  <label className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
                    {item.quantity > 1 && `${item.quantity}x `}
                    {t('menu.combos.choice.pickFrom', { category: catName, defaultValue: `Pick from ${catName}` })}
                  </label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenDropdown(openDropdown === index ? null : index)}
                      className="pos-glass-field min-h-touch flex w-full items-center justify-between p-3 text-left"
                    >
                      <span className={chosen ? 'liquid-glass-modal-text font-medium' : 'liquid-glass-modal-text-muted'}>
                        {chosen ? chosen.name : t('menu.combos.choice.selectItem', 'Select an item...')}
                      </span>
                      <ChevronDown className={`w-4 h-4 transition-transform liquid-glass-modal-text-muted ${openDropdown === index ? 'rotate-180' : ''}`} />
                    </button>

                    {openDropdown === index && (
                      <div className="pos-glass-form-card p-1! absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto shadow-lg backdrop-blur-xl scrollbar-hide space-y-1">
                        {catItems.length === 0 ? (
                          <div className="p-3 text-sm liquid-glass-modal-text-muted">
                            {t('menu.combos.choice.noItems', 'No items available')}
                          </div>
                        ) : (
                          catItems.map((menuItem) => {
                            const itemName = language === 'el' && menuItem.name_el
                              ? menuItem.name_el : menuItem.name;
                            const isSelected = chosen?.subcategory_id === menuItem.id;
                            return (
                              <button
                                type="button"
                                key={menuItem.id}
                                onClick={() => handleSelectItem(index, item, menuItem)}
                                className={`min-h-touch flex w-full items-center justify-between rounded-2xl border p-3 text-left ${isSelected ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]' : 'pos-glass-tap-card liquid-glass-modal-text'}`}
                              >
                                <span className="font-medium">
                                  {itemName}
                                </span>
                                <span className={`text-sm ${isSelected ? 'text-(--pos-s-sel-fg)' : 'liquid-glass-modal-text-muted'}`}>
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
            })}</motion.div>
          )}</AnimatePresence>
      </div>
    </LiquidGlassModal>
  );
};

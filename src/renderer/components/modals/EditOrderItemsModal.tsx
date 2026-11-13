import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { liquidGlassModalButton } from '../../styles/designSystem';
import { getBridge } from '../../../lib';

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  unit_price?: number;
  total_price?: number;
  notes?: string;
  customizations?: any[];
}

interface EditOrderItemsModalProps {
  isOpen: boolean;
  orderCount: number;
  orderId?: string; // Added orderId prop to fetch items if initialItems is empty
  orderNumber?: string; // Order number for display in modal header (Requirements: 7.7)
  initialItems: OrderItem[];
  onSave: (items: OrderItem[], orderNotes?: string) => Promise<void> | void;
  onClose: () => void;
}

export const EditOrderItemsModal: React.FC<EditOrderItemsModalProps> = ({
  isOpen,
  orderCount,
  orderId,
  orderNumber,
  initialItems,
  onSave,
  onClose
}) => {
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const { t } = useTranslation();
  const bridge = getBridge();
  const [items, setItems] = useState<OrderItem[]>(initialItems);
  const [orderNotes, setOrderNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  // Fetch items from backend when modal opens with empty initialItems
  const fetchOrderItems = useCallback(async (id: string): Promise<OrderItem[]> => {
    try {
      // First try to get order from local DB
      const localOrderResponse: any = await bridge.orders.getById(id);
      const localOrder = localOrderResponse?.data ?? localOrderResponse;
      if (localOrder?.items && Array.isArray(localOrder.items) && localOrder.items.length > 0) {
        console.log('[EditOrderItemsModal] Loaded items from local DB:', localOrder.items.length);
        return localOrder.items.map((item: any) => ({
          id: item.id,
          name: item.name || 'Unknown Item',
          quantity: item.quantity || 1,
          price: item.price || item.unit_price || 0,
          unit_price: item.unit_price || item.price || 0,
          total_price: item.total_price || (item.price || item.unit_price || 0) * (item.quantity || 1),
          notes: item.notes,
          customizations: item.customizations
        }));
      }

      // Fallback: fetch from Supabase
      const supabaseResult: any = await bridge.orders.fetchItemsFromSupabase(id);
      const supabaseItems = Array.isArray(supabaseResult) ? supabaseResult : supabaseResult?.data;
      if (Array.isArray(supabaseItems) && supabaseItems.length > 0) {
        console.log('[EditOrderItemsModal] Loaded items from Supabase:', supabaseItems.length);
        return supabaseItems.map((item: any) => ({
          id: item.id,
          name: item.name || 'Unknown Item',
          quantity: item.quantity || 1,
          price: item.price || item.unit_price || 0,
          unit_price: item.unit_price || item.price || 0,
          total_price: item.total_price || (item.price || item.unit_price || 0) * (item.quantity || 1),
          notes: item.notes,
          customizations: item.customizations
        }));
      }

      return [];
    } catch (error) {
      console.error('[EditOrderItemsModal] Failed to fetch items:', error);
      return [];
    }
  }, [bridge.orders]);

  // Reset form and fetch items when modal opens
  useEffect(() => {
    if (isOpen) {
      setOrderNotes('');
      
      // If initialItems is empty but we have an orderId, fetch items
      if ((!initialItems || initialItems.length === 0) && orderId) {
        setIsLoadingItems(true);
        fetchOrderItems(orderId)
          .then(fetchedItems => {
            setItems(fetchedItems);
          })
          .catch(error => {
            console.error('[EditOrderItemsModal] Error fetching items:', error);
            toast.error(t('modals.editOrderItems.loadFailed') || 'Failed to load order items');
            setItems([]);
          })
          .finally(() => {
            setIsLoadingItems(false);
          });
      } else {
        setItems([...initialItems]);
      }
    }
  }, [isOpen, initialItems, orderId, fetchOrderItems, t]);



  const handleSave = async () => {
    // Validate items
    const validItems = items.filter(item => item.quantity > 0);

    if (validItems.length === 0) {
      toast.error(t('modals.editOrderItems.atLeastOneItem'));
      return;
    }

    setIsSaving(true);

    try {
      await onSave(validItems, orderNotes);
      setIsSaving(false);
    } catch (error) {
      setIsSaving(false);
      toast.error(t('modals.editOrderItems.saveFailed'));
    }
  };

  const handleClose = () => {
    setItems([...initialItems]); // Reset form
    setOrderNotes('');
    onClose();
  };

  const updateItemQuantity = (itemId: string, quantity: number) => {
    setItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const newQuantity = Math.max(0, quantity);
        const unitPrice = item.unit_price || item.price || 0;
        const newTotalPrice = unitPrice * newQuantity;
        return { 
          ...item, 
          quantity: newQuantity,
          total_price: newTotalPrice
        };
      }
      return item;
    }));
  };

  const updateItemNotes = (itemId: string, notes: string) => {
    setItems(prev => prev.map(item =>
      item.id === itemId
        ? { ...item, notes }
        : item
    ));
  };

  const removeItem = (itemId: string) => {
    setItems(prev => prev.filter(item => item.id !== itemId));
  };

  const calculateTotal = () => {
    return items.reduce((total, item) => {
      // Use total_price if available (includes customizations), otherwise calculate from price * quantity
      const itemTotal = item.total_price || ((item.unit_price || item.price || 0) * item.quantity);
      return total + itemTotal;
    }, 0);
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={orderNumber ? `${t('modals.editOrderItems.title')} - #${orderNumber}` : t('modals.editOrderItems.title')}
      size="lg"
      closeOnBackdrop={false}
      closeOnEscape={true}
      className="max-w-2xl! max-h-[90vh] [&_.liquid-glass-modal-header]:border-b-0!"
    >
      <p className="mb-6 liquid-glass-modal-text-muted">
        {t('modals.editOrderItems.message', { count: orderCount })}
      </p>

      <div className="flex-1 overflow-y-auto space-y-3 mb-3 scrollbar-hide">
        {/* Order Items */}
        <div className="space-y-3">
          <AnimatePresence initial={false}>{items.map((item) => (
            <motion.div {...revealMotion} key={item.id} className="pos-glass-form-card">
              <div className="flex items-center justify-between mb-3">
                <div className="flex-1">
                  <h4 className="font-medium liquid-glass-modal-text">{item.name}</h4>
                  <p className="text-sm liquid-glass-modal-text-muted">${(item.unit_price || item.price || 0).toFixed(2)} {t('modals.editOrderItems.each')}</p>
                </div>

                {/* Quantity Controls */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => updateItemQuantity(item.id, item.quantity - 1)}
                    aria-label={t('common.decrease', 'Decrease')}
                    className="pos-glass-field h-11 w-11 shrink-0 flex items-center justify-center"
                  >
                    -
                  </button>

                  <input
                    type="number"
                    value={item.quantity}
                    onChange={(e) => updateItemQuantity(item.id, parseInt(e.target.value) || 0)}
                    className={`liquid-glass-modal-input pos-glass-field min-h-touch w-16 text-center`}
                    min="0"
                  />

                  <button
                    type="button"
                    onClick={() => updateItemQuantity(item.id, item.quantity + 1)}
                    aria-label={t('common.increase', 'Increase')}
                    className="pos-glass-field h-11 w-11 shrink-0 flex items-center justify-center"
                  >
                    +
                  </button>

                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    aria-label={t('common.remove', 'Remove')}
                    className="pos-glass-field h-11 w-11 shrink-0 flex items-center justify-center"
                  >
                    x
                  </button>
                </div>
              </div>

              {/* Item Notes */}
              <div>
                <input
                  type="text"
                  value={item.notes || ''}
                  onChange={(e) => updateItemNotes(item.id, e.target.value)}
                  placeholder={t('modals.editOrderItems.itemNotesPlaceholder')}
                  className={`liquid-glass-modal-input pos-glass-field min-h-touch w-full text-sm`}
                />
              </div>

              {/* Item Total */}
              <div className="mt-2 text-right">
                <span className="text-sm font-medium liquid-glass-modal-text">
                  {t('modals.editOrderItems.subtotal')}: ${(item.total_price || ((item.unit_price || item.price || 0) * item.quantity)).toFixed(2)}
                </span>
              </div>
            </motion.div>
          ))}</AnimatePresence>
          
          {/* Loading state */}
          <AnimatePresence initial={false}>{isLoadingItems && (
            <motion.div {...revealMotion} className="flex items-center justify-center py-8">
              <svg className="animate-spin h-8 w-8 text-yellow-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="ml-2 liquid-glass-modal-text">{t('modals.editOrderItems.loading') || 'Loading items...'}</span>
            </motion.div>
          )}</AnimatePresence>
          
          {/* Empty state */}
          <AnimatePresence initial={false}>{!isLoadingItems && items.length === 0 && (
            <motion.div {...revealMotion} className="text-center py-8 liquid-glass-modal-text-muted">
              {t('modals.editOrderItems.noItems') || 'No items in this order'}
            </motion.div>
          )}</AnimatePresence>
        </div>

        {/* Order Notes */}
        <div className="pos-glass-form-card">
          <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-2">
            {t('modals.editOrderItems.orderNotes')}
          </label>
          <textarea
            value={orderNotes}
            onChange={(e) => setOrderNotes(e.target.value)}
            placeholder={t('modals.editOrderItems.orderNotesPlaceholder')}
            className={`liquid-glass-modal-input pos-glass-field min-h-touch w-full resize-none`}
            rows={3}
            maxLength={500}
          />
          <div className="text-xs liquid-glass-modal-text-muted mt-1">
            {t('modals.editOrderItems.characterCount', { current: orderNotes.length, max: 500 })}
          </div>
        </div>
      </div>

      {/* Total and Actions */}
      <div className="px-6 pb-5 pt-2">
        <div className="flex items-center justify-between mb-4">
          <span className="text-lg font-semibold liquid-glass-modal-text">
            {t('modals.editOrderItems.total')}: ${calculateTotal().toFixed(2)}
          </span>
          <span className="text-sm liquid-glass-modal-text-muted">
            {t('modals.editOrderItems.itemsCount', { count: items.filter(item => item.quantity > 0).length })}
          </span>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleClose}
            disabled={isSaving}
            className={`${liquidGlassModalButton('secondary')} flex-1 disabled:opacity-50`}
          >
            {t('modals.editOrderItems.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || items.filter(item => item.quantity > 0).length === 0}
            className={`${liquidGlassModalButton('primary')} flex-1 disabled:opacity-50 flex items-center justify-center gap-2`}
          >
            {isSaving && (
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-current" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            )}
            {isSaving ? t('modals.editOrderItems.saving') : t('modals.editOrderItems.saveChanges')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default EditOrderItemsModal;

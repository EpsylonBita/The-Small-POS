import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useTheme } from '../../contexts/theme-context';
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';

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
  onSave: (items: OrderItem[], orderNotes?: string) => void;
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
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [items, setItems] = useState<OrderItem[]>(initialItems);
  const [orderNotes, setOrderNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  // Fetch items from backend when modal opens with empty initialItems
  const fetchOrderItems = useCallback(async (id: string): Promise<OrderItem[]> => {
    try {
      // First try to get order from local DB
      const localOrder = await window.electronAPI?.invoke('order:get-by-id', { orderId: id });
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
      const supabaseItems = await window.electronAPI?.invoke('order:fetch-items-from-supabase', { orderId: id });
      if (supabaseItems && Array.isArray(supabaseItems) && supabaseItems.length > 0) {
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
  }, []);

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
      // Simulate save delay
      await new Promise(resolve => setTimeout(resolve, 500));
      onSave(validItems, orderNotes);
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
      className="max-h-[90vh]"
    >
      <p className="mb-6 liquid-glass-modal-text-muted">
        {t('modals.editOrderItems.message', { count: orderCount })}
      </p>

      <div className="flex-1 overflow-y-auto space-y-4 mb-6">
        {/* Order Items */}
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="border liquid-glass-modal-border rounded-lg p-4 bg-gray-50/50 dark:bg-gray-800/50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex-1">
                  <h4 className="font-medium liquid-glass-modal-text">{item.name}</h4>
                  <p className="text-sm liquid-glass-modal-text-muted">${(item.unit_price || item.price || 0).toFixed(2)} {t('modals.editOrderItems.each')}</p>
                </div>

                {/* Quantity Controls */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateItemQuantity(item.id, item.quantity - 1)}
                    className="w-8 h-8 rounded-full bg-red-100/50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200/50 dark:hover:bg-red-900/50 transition-colors flex items-center justify-center"
                  >
                    -
                  </button>

                  <input
                    type="number"
                    value={item.quantity}
                    onChange={(e) => updateItemQuantity(item.id, parseInt(e.target.value) || 0)}
                    className={`${inputBase(resolvedTheme)} w-16 text-center`}
                    min="0"
                  />

                  <button
                    onClick={() => updateItemQuantity(item.id, item.quantity + 1)}
                    className="w-8 h-8 rounded-full bg-green-100/50 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-200/50 dark:hover:bg-green-900/50 transition-colors flex items-center justify-center"
                  >
                    +
                  </button>

                  <button
                    onClick={() => removeItem(item.id)}
                    className="w-8 h-8 rounded-full bg-gray-500/20 hover:bg-red-500/20 liquid-glass-modal-text hover:text-red-600 transition-colors flex items-center justify-center"
                  >
                    ×
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
                  className={`${inputBase(resolvedTheme)} text-sm`}
                />
              </div>

              {/* Item Total */}
              <div className="mt-2 text-right">
                <span className="text-sm font-medium liquid-glass-modal-text">
                  {t('modals.editOrderItems.subtotal')}: ${(item.total_price || ((item.unit_price || item.price || 0) * item.quantity)).toFixed(2)}
                </span>
              </div>
            </div>
          ))}
          
          {/* Loading state */}
          {isLoadingItems && (
            <div className="flex items-center justify-center py-8">
              <svg className="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="ml-2 liquid-glass-modal-text">{t('modals.editOrderItems.loading') || 'Loading items...'}</span>
            </div>
          )}
          
          {/* Empty state */}
          {!isLoadingItems && items.length === 0 && (
            <div className="text-center py-8 liquid-glass-modal-text-muted">
              {t('modals.editOrderItems.noItems') || 'No items in this order'}
            </div>
          )}
        </div>

        {/* Order Notes */}
        <div className="border-t liquid-glass-modal-border pt-4">
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
            {t('modals.editOrderItems.orderNotes')}
          </label>
          <textarea
            value={orderNotes}
            onChange={(e) => setOrderNotes(e.target.value)}
            placeholder={t('modals.editOrderItems.orderNotesPlaceholder')}
            className={`${inputBase(resolvedTheme)} resize-none`}
            rows={3}
            maxLength={500}
          />
          <div className="text-xs liquid-glass-modal-text-muted mt-1">
            {t('modals.editOrderItems.characterCount', { current: orderNotes.length, max: 500 })}
          </div>
        </div>
      </div>

      {/* Total and Actions */}
      <div className="border-t liquid-glass-modal-border pt-4">
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
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
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
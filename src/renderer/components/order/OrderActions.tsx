import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';

interface OrderActionsProps {
  orderId: string;
  orderType: string;
  onOrderAction: (orderId: string, action: string, notes?: string) => void;
}

export const OrderActions: React.FC<OrderActionsProps> = ({
  orderId,
  orderType,
  onOrderAction,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showDriverModal, setShowDriverModal] = useState(false);
  const [cancelNotes, setCancelNotes] = useState('');

  // Mock drivers data
  const mockDrivers = [
    { id: "1", name: "Alex Rodriguez", phone: "555-0101", status: "available" },
    { id: "2", name: "Maria Garcia", phone: "555-0102", status: "busy" },
    { id: "3", name: "David Kim", phone: "555-0103", status: "available" },
    { id: "4", name: "Lisa Chen", phone: "555-0104", status: "offline" }
  ];

  const handleAction = useCallback((action: string, notes?: string) => {
    
    switch (action) {
      case 'cancel':
        setShowCancelModal(false);
        setCancelNotes('');
        onOrderAction(orderId, action, notes);
        break;
      case 'delivered':
        if (orderType === 'delivery') {
          setShowDriverModal(true);
        } else {
          onOrderAction(orderId, action);
        }
        break;
      case 'assign_driver':
        setShowDriverModal(false);
        onOrderAction(orderId, action, notes);
        break;
      default:
        onOrderAction(orderId, action, notes);
    }
    setShowDropdown(false);
  }, [orderId, orderType, onOrderAction]);

  return (
    <div className="relative">
      {/* Three dots button */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className={`p-2 rounded-full transition-all duration-200 ${
          resolvedTheme === 'dark'
            ? 'text-white/70 hover:text-white hover:bg-white/10'
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100/50'
        }`}
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <div className={`absolute right-0 top-full mt-2 w-48 rounded-lg shadow-lg border z-50 ${
          resolvedTheme === 'dark'
            ? 'bg-gray-800/95 border-gray-700/50 backdrop-blur-xl'
            : 'bg-white/95 border-gray-200/50 backdrop-blur-xl'
        }`}>
          <div className="py-1">
            <button
              onClick={() => handleAction('edit')}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                resolvedTheme === 'dark'
                  ? 'text-gray-300 hover:bg-gray-700/50 hover:text-white'
                  : 'text-gray-700 hover:bg-gray-100/50 hover:text-gray-900'
              }`}
            >
              {t('orders.actions.editOrder')}
            </button>
            <button
              onClick={() => handleAction('delivered')}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                resolvedTheme === 'dark'
                  ? 'text-gray-300 hover:bg-gray-700/50 hover:text-white'
                  : 'text-gray-700 hover:bg-gray-100/50 hover:text-gray-900'
              }`}
            >
              {t('orders.actions.markAsDelivered')}
            </button>
            <button
              onClick={() => setShowCancelModal(true)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                resolvedTheme === 'dark'
                  ? 'text-red-300 hover:bg-red-900/20 hover:text-red-200'
                  : 'text-red-600 hover:bg-red-50 hover:text-red-700'
              }`}
            >
              {t('orders.actions.cancelOrder')}
            </button>
          </div>
        </div>
      )}

      {/* Cancel Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className={`bg-white/95 backdrop-blur-xl rounded-xl p-6 max-w-md w-full mx-4 ${
            resolvedTheme === 'dark' ? 'bg-gray-800/95 text-white' : 'text-gray-900'
          }`}>
            <h3 className="text-lg font-semibold mb-4">{t('orders.cancel.title')}</h3>
            <p className="text-sm mb-4">{t('orders.cancel.reasonPrompt')}</p>
            <textarea
              value={cancelNotes}
              onChange={(e) => setCancelNotes(e.target.value)}
              placeholder={t('orders.cancel.reasonPlaceholder')}
              className={`w-full p-3 border rounded-lg resize-none ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-700/50 border-gray-600 text-white'
                  : 'bg-white border-gray-300'
              }`}
              rows={3}
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setShowCancelModal(false)}
                className="flex-1 px-4 py-2 border rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleAction('cancel', cancelNotes)}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >
                {t('orders.cancel.confirmCancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Driver Assignment Modal */}
      {showDriverModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className={`bg-white/95 backdrop-blur-xl rounded-xl p-6 max-w-md w-full mx-4 ${
            resolvedTheme === 'dark' ? 'bg-gray-800/95 text-white' : 'text-gray-900'
          }`}>
            <h3 className="text-lg font-semibold mb-4">{t('orders.driver.assignTitle')}</h3>
            <div className="space-y-2">
              {mockDrivers.filter(driver => driver.status === 'available').map(driver => (
                <button
                  key={driver.id}
                  onClick={() => handleAction('assign_driver', driver.id)}
                  className={`w-full text-left p-3 border rounded-lg transition-colors ${
                    resolvedTheme === 'dark'
                      ? 'border-gray-600 hover:bg-gray-700/50'
                      : 'border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium">{driver.name}</div>
                  <div className="text-sm opacity-70">{driver.phone}</div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowDriverModal(false)}
              className="w-full mt-4 px-4 py-2 border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}; 
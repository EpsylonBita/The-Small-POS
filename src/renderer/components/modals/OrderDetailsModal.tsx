import React from "react";
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface OrderDetailsModalProps {
  isOpen: boolean;
  orderId: string;
  onClose: () => void;
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  orderId,
  onClose,
}) => {
  const { t } = useTranslation();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.orderDetails.title', { orderId })}
      size="xl"
      className="max-h-[90vh]"
    >
      <div className="overflow-y-auto">
          {/* Modal Content */}
          <div className="bg-blue-50/50 dark:bg-blue-900/20 border liquid-glass-modal-border p-4 rounded-lg mb-6">
            <p className="text-center liquid-glass-modal-text">
              {t('modals.orderDetails.placeholder')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Order Details Section */}
            <div className="bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4 liquid-glass-modal-text">
                {t('modals.orderDetails.orderInformation')}
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.orderID')}:</span>
                  <span className="liquid-glass-modal-text font-medium">{orderId}</span>
                </div>
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.status')}:</span>
                  <span className="text-blue-600 dark:text-blue-300 font-medium">{t('modals.orderDetails.processing')}</span>
                </div>
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.date')}:</span>
                  <span className="liquid-glass-modal-text font-medium">
                    {new Date().toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.type')}:</span>
                  <span className="liquid-glass-modal-text font-medium">{t('modals.orderDetails.delivery')}</span>
                </div>
              </div>
            </div>

            {/* Customer Information Section */}
            <div className="bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4 liquid-glass-modal-text">
                {t('modals.orderDetails.customerInformation')}
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.name')}:</span>
                  <span className="liquid-glass-modal-text font-medium">John Doe</span>
                </div>
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.phone')}:</span>
                  <span className="liquid-glass-modal-text font-medium">(555) 123-4567</span>
                </div>
                <div className="flex justify-between pb-2 border-b liquid-glass-modal-border">
                  <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.address')}:</span>
                  <span className="liquid-glass-modal-text font-medium">123 Main St, Anytown</span>
                </div>
              </div>
            </div>
          </div>

          {/* Order Items Section - Sample Data */}
          <div className="mt-8 p-6 rounded-lg bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border">
            <h3 className="text-lg font-semibold mb-4 liquid-glass-modal-text">
              {t('modals.orderDetails.orderItems')}
            </h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-white/50 dark:bg-gray-900/20">
                  <tr>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium liquid-glass-modal-text-muted uppercase tracking-wider"
                    >
                      {t('modals.orderDetails.item')}
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium liquid-glass-modal-text-muted uppercase tracking-wider"
                    >
                      {t('modals.orderDetails.quantity')}
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium liquid-glass-modal-text-muted uppercase tracking-wider"
                    >
                      {t('modals.orderDetails.price')}
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium liquid-glass-modal-text-muted uppercase tracking-wider"
                    >
                      {t('modals.orderDetails.total')}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white/30 dark:bg-gray-900/20 divide-gray-200/20 dark:divide-gray-700 divide-y">
                  {/* Sample item */}
                  <tr>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium liquid-glass-modal-text">
                        Pizza Margherita
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      2
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      $12.99
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      $25.98
                    </td>
                  </tr>
                  <tr>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium liquid-glass-modal-text">
                        Garlic Bread
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      1
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      $4.50
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm liquid-glass-modal-text-muted">
                      $4.50
                    </td>
                  </tr>
                </tbody>
                <tfoot className="bg-white/50 dark:bg-gray-900/20">
                  <tr className="font-bold">
                    <td
                      colSpan={3}
                      className="px-6 py-3 text-right text-sm font-bold liquid-glass-modal-text"
                    >
                      {t('modals.orderDetails.total')}:
                    </td>
                    <td className="px-6 py-3 text-sm font-bold liquid-glass-modal-text">
                      $30.48
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

    </LiquidGlassModal>
  );
};

export default OrderDetailsModal;
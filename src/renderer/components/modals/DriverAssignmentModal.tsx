import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface Driver {
  id: string;
  name: string;
  phone: string;
  status: 'available' | 'busy' | 'offline';
  current_orders?: number;
}

interface DriverAssignmentModalProps {
  isOpen: boolean;
  orderCount: number;
  branchId?: string;
  onDriverAssign: (driver: Driver) => void;
  onClose: () => void;
}

export const DriverAssignmentModal: React.FC<DriverAssignmentModalProps> = ({
  isOpen,
  orderCount,
  branchId,
  onDriverAssign,
  onClose
}) => {
  const { t } = useTranslation();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchDrivers();
    }
  }, [isOpen, branchId]);

  const fetchDrivers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Prefer the branchId passed from parent; otherwise use the terminal's configured branch
      let effectiveBranchId = branchId as string | undefined;
      if (!effectiveBranchId) {
        effectiveBranchId = await (window as any).electronAPI?.getTerminalBranchId?.();
      }

      const result = await (window as any).electronAPI?.getActiveDrivers?.(effectiveBranchId);
      if (result?.success) {
        const list = (result.data || []) as Driver[];
        list.sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));
        setDrivers(list);
      } else {
        setError(result?.error || t('modals.driverAssignment.fetchFailed'));
      }
    } catch (err) {
      setError(t('modals.driverAssignment.fetchFailed'));
      console.error('Error fetching drivers:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDriverSelect = (driver: Driver) => {
    if (driver.status === 'available' && (driver.current_orders || 0) < 3) {
      onDriverAssign(driver);
      toast.success(t('modals.driverAssignment.assignedTo', { name: driver.name }));
      onClose();
    } else if (driver.status !== 'available') {
      toast.error(t('modals.driverAssignment.notAvailable', { name: driver.name }));
    } else {
      toast.error(t('modals.driverAssignment.tooManyOrders', { name: driver.name }));
    }
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.driverAssignment.title')}
      size="md"
      closeOnBackdrop={false}
    >
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            {t('modals.driverAssignment.message', { count: orderCount })}
          </p>

          {/* Loading State */}
          {isLoading && (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 mb-6">
              {error}
            </div>
          )}

          {/* Empty State */}
          {!isLoading && drivers.length === 0 && !error && (
            <div className="text-center py-8 liquid-glass-modal-text-muted">
              {t('modals.driverAssignment.noDrivers')}
            </div>
          )}

          {/* Drivers List */}
          {!isLoading && drivers.length > 0 && (
            <div className="space-y-3 mb-6">
              {drivers.map((driver) => {
                const isDisabled = driver.status !== 'available' || (driver.current_orders || 0) >= 3;
                return (
                  <button
                    key={driver.id}
                    onClick={() => handleDriverSelect(driver)}
                    disabled={isDisabled}
                    className={`
                      w-full border rounded-lg p-3 transition-all duration-200 text-left
                      ${!isDisabled
                        ? 'border-blue-200/50 dark:border-blue-400/30 bg-blue-50/50 dark:bg-blue-500/10 hover:bg-blue-100/50 dark:hover:bg-blue-500/20'
                        : 'border-gray-200/50 dark:border-gray-600 bg-gray-50/50 dark:bg-gray-800 cursor-not-allowed'
                      }
                    `}
                  >
                    <div className="font-medium liquid-glass-modal-text">{driver.name}</div>
                  </button>
                );
              })}
            </div>
          )}
    </LiquidGlassModal>
  );
};

export default DriverAssignmentModal;
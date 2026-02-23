import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { getBridge } from '../../../lib';

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
  const bridge = getBridge();
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
        effectiveBranchId = await bridge.terminalConfig.getBranchId();
      }

      const result = await bridge.drivers.getActive(effectiveBranchId || '');
      const list = Array.isArray(result)
        ? result
        : Array.isArray((result as any)?.data)
          ? (result as any).data
          : [];

      if (!Array.isArray(result) && (result as any)?.success === false) {
        setError((result as any)?.error || t('modals.driverAssignment.fetchFailed'));
        return;
      }

      const normalized = (list as Driver[]).slice().sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));
      setDrivers(normalized);
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
      className="!max-w-lg"
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
                      liquid-glass-modal-button w-full justify-start p-3 h-auto
                      ${!isDisabled
                    ? ''
                    : 'opacity-50 cursor-not-allowed'
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

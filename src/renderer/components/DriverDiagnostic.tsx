import React, { useState } from 'react';
import { POSGlassModal } from './ui/pos-glass-components';
import toast from 'react-hot-toast';

interface DiagnosticResult {
  total: number;
  withDriver: number;
  withoutDriver: number;
  earningsCount: number;
  ordersWithoutDriver: Array<{
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
  }>;
  recentDriverShifts: Array<{
    id: string;
    staff_id: string;
    status: string;
    check_in_time: string;
    check_out_time?: string;
  }>;
}

export const DriverDiagnostic: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const [isChecking, setIsChecking] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState('');

  const handleCheck = async () => {
    setIsChecking(true);
    try {
      const response = await (window as any).electronAPI?.checkDeliveredOrders();
      if (response?.success) {
        setResult(response.data);
        toast.success(`Found ${response.data.total} delivery orders`);
      } else {
        toast.error(response?.error || 'Failed to check orders');
      }
    } catch (error) {
      console.error('Check failed:', error);
      toast.error('Failed to check orders');
    } finally {
      setIsChecking(false);
    }
  };

  const handleFix = async () => {
    if (!selectedDriverId) {
      toast.error('Please select a driver first');
      return;
    }

    setIsFixing(true);
    try {
      const response = await (window as any).electronAPI?.fixMissingDriverIds(selectedDriverId);
      if (response?.success) {
        toast.success(response.message || 'Orders fixed successfully');
        // Re-check to update the display
        await handleCheck();
      } else {
        toast.error(response?.error || 'Failed to fix orders');
      }
    } catch (error) {
      console.error('Fix failed:', error);
      toast.error('Failed to fix orders');
    } finally {
      setIsFixing(false);
    }
  };

  return (
    <POSGlassModal isOpen={isOpen} onClose={onClose} title="Driver Orders Diagnostic" size="lg">
      <div className="space-y-6">
        {/* Check Button */}
        <div className="flex justify-between items-center">
          <p className="text-sm text-white/70">
            Check for delivery orders without driver assignment
          </p>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="px-4 py-2 bg-blue-500/20 border border-blue-400/30 rounded-lg hover:bg-blue-500/30 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {isChecking ? 'Checking...' : 'Check Orders'}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-blue-500/10 border border-blue-400/20 rounded-lg p-3">
                <div className="text-2xl font-bold text-white">{result.total}</div>
                <div className="text-sm text-white/60">Total Delivered</div>
              </div>
              <div className="bg-green-500/10 border border-green-400/20 rounded-lg p-3">
                <div className="text-2xl font-bold text-green-400">{result.withDriver}</div>
                <div className="text-sm text-white/60">With Driver</div>
              </div>
              <div className="bg-red-500/10 border border-red-400/20 rounded-lg p-3">
                <div className="text-2xl font-bold text-red-400">{result.withoutDriver}</div>
                <div className="text-sm text-white/60">Missing Driver</div>
              </div>
              <div className="bg-purple-500/10 border border-purple-400/20 rounded-lg p-3">
                <div className="text-2xl font-bold text-purple-400">{result.earningsCount}</div>
                <div className="text-sm text-white/60">Driver Earnings</div>
              </div>
            </div>

            {/* Driver Selection */}
            {result.withoutDriver > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-400/20 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-white mb-3">
                  Fix Missing Driver Assignments
                </h3>
                <p className="text-sm text-white/70 mb-3">
                  Select a driver to assign to all {result.withoutDriver} orders without a driver:
                </p>

                {/* Driver Shift Selection */}
                <div className="space-y-2 mb-3">
                  {result.recentDriverShifts.length > 0 ? (
                    result.recentDriverShifts.map((shift) => (
                      <button
                        key={shift.id}
                        onClick={() => setSelectedDriverId(shift.staff_id)}
                        className={`w-full text-left p-3 rounded-lg border transition-all ${
                          selectedDriverId === shift.staff_id
                            ? 'bg-green-500/20 border-green-400/40'
                            : 'bg-white/5 border-white/10 hover:bg-white/10'
                        }`}
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="font-medium text-white">
                              Driver: {shift.staff_id.substring(0, 8)}...
                            </div>
                            <div className="text-sm text-white/60">
                              Shift: {shift.id.substring(0, 8)}... | Status: {shift.status}
                            </div>
                          </div>
                          {selectedDriverId === shift.staff_id && (
                            <div className="text-green-400">✓ Selected</div>
                          )}
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-white/60 text-center py-4">
                      No driver shifts found. Please create a driver shift first.
                    </div>
                  )}
                </div>

                <button
                  onClick={handleFix}
                  disabled={isFixing || !selectedDriverId}
                  className="w-full px-4 py-3 bg-yellow-500/20 border border-yellow-400/30 rounded-lg hover:bg-yellow-500/30 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {isFixing ? 'Fixing...' : `Assign Driver to ${result.withoutDriver} Orders`}
                </button>
              </div>
            )}

            {/* Orders Without Driver */}
            {result.ordersWithoutDriver.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold text-white mb-2">
                  Orders Without Driver ({result.ordersWithoutDriver.length})
                </h3>
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {result.ordersWithoutDriver.map((order) => (
                    <div
                      key={order.id}
                      className="bg-white/5 border border-white/10 rounded-lg p-3"
                    >
                      <div className="flex justify-between items-center">
                        <div>
                          <div className="font-medium text-white">#{order.orderNumber}</div>
                          <div className="text-sm text-white/60">
                            Status: {order.status} | Created:{' '}
                            {new Date(order.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="text-red-400 text-sm">No Driver</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </POSGlassModal>
  );
};

import React, { useState, useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../lib';

interface SyncNotificationManagerProps {
  onSettingsUpdate?: (settings: any) => void;
  onStaffPermissionUpdate?: (update: any) => void;
  onHardwareConfigUpdate?: (update: any) => void;
}

interface SettingsUpdate {
  id: string;
  category: string;
  description: string;
  data: any;
  timestamp: string;
}

interface RestartNotification {
  reason: string;
  hardware_type: string;
  config?: any;
}

export const SyncNotificationManager: React.FC<SyncNotificationManagerProps> = ({
  onSettingsUpdate,
  onStaffPermissionUpdate,
  onHardwareConfigUpdate
}) => {
  const bridge = getBridge();
  const [pendingUpdates, setPendingUpdates] = useState<SettingsUpdate[]>([]);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [restartRequired, setRestartRequired] = useState<RestartNotification | null>(null);
  const [autoApply, setAutoApply] = useState(true);

  // Category labels for display
  const categoryLabels: Record<string, string> = {
    terminal: 'Terminal Settings',
    payment: 'Payment Settings',
    tax: 'Tax Settings',
    discount: 'Discount Settings',
    receipt: 'Receipt Settings',
    printer: 'Printer Settings',
    inventory: 'Inventory Settings',
    staff: 'Staff Permissions',
    restaurant: 'Restaurant Settings'
  };

  useEffect(() => {
    const handleSettingsUpdate = (update: SettingsUpdate) => {
      setPendingUpdates(prev => [...prev, update]);
      setShowNotificationPanel(true);

      // Auto-apply if enabled
      if (autoApply) {
        handleApplyUpdate(update);
      }

      // Show notification
      console.log('Settings update received:', update);
    };

    const handleStaffPermissionUpdate = (update: any) => {
      onStaffPermissionUpdate?.(update);
      console.log('Staff permission updated:', update);
    };

    const handleHardwareConfigUpdate = (update: any) => {
      onHardwareConfigUpdate?.(update);
      console.log('Hardware config updated:', update);
    };

    const handleRestartRequired = (notification: RestartNotification) => {
      setRestartRequired(notification);
      console.log('Restart required:', notification);
    };

    const handleSyncError = (error: any) => {
      console.error('Sync failed:', error);
    };

    const handleSyncComplete = (data: any) => {
      console.log('Settings synchronized successfully:', data);
    };

    const handleSettingsEvent = (data: any) => {
      const category = typeof data?.category === 'string' ? data.category : 'terminal';
      const update: SettingsUpdate = {
        id: `settings-${category}-${Date.now()}`,
        category,
        description: `${categoryLabels[category] || 'Settings'} updated`,
        data,
        timestamp: new Date().toISOString(),
      };
      handleSettingsUpdate(update);
    };

    onEvent('settings:update', handleSettingsEvent);
    onEvent('staff:permission-update', handleStaffPermissionUpdate);
    onEvent('hardware-config:update', handleHardwareConfigUpdate);
    onEvent('app:restart-required', handleRestartRequired);
    onEvent('sync:error', handleSyncError);
    onEvent('sync:complete', handleSyncComplete);

    return () => {
      offEvent('settings:update', handleSettingsEvent);
      offEvent('staff:permission-update', handleStaffPermissionUpdate);
      offEvent('hardware-config:update', handleHardwareConfigUpdate);
      offEvent('app:restart-required', handleRestartRequired);
      offEvent('sync:error', handleSyncError);
      offEvent('sync:complete', handleSyncComplete);
    };
  }, [onSettingsUpdate, onStaffPermissionUpdate, onHardwareConfigUpdate, autoApply]);

  const handleApplyUpdate = async (update: SettingsUpdate) => {
    try {
      await onSettingsUpdate?.(update);
      setPendingUpdates(prev => prev.filter(u => u.id !== update.id));
      console.log(`${update.category} settings updated successfully`);
    } catch (error) {
      console.error(`Failed to apply ${update.category} settings:`, error);
    }
  };

  const handleRestartNow = () => {
    void bridge.app.restart();
    setRestartRequired(null);
  };

  const handleRestartLater = () => {
    setRestartRequired(null);
    console.log('Restart reminder will appear again in 30 minutes');
    
    // Set reminder for 30 minutes
    setTimeout(() => {
      if (restartRequired) {
        console.log('Restart still required for hardware changes to take effect');
      }
    }, 30 * 60 * 1000);
  };

  // Group updates by category
  const groupedUpdates = pendingUpdates.reduce((acc, update) => {
    if (!acc[update.category]) {
      acc[update.category] = [];
    }
    acc[update.category].push(update);
    return acc;
  }, {} as Record<string, SettingsUpdate[]>);

  return (
    <>
      {/* Notification Panel */}
      {showNotificationPanel && pendingUpdates.length > 0 && (
        <div className="fixed top-4 right-4 bg-white shadow-lg rounded-lg p-4 border-l-4 border-blue-500 z-50 max-w-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-medium text-gray-900">Settings Updates ({pendingUpdates.length})</h3>
            <button
              onClick={() => setShowNotificationPanel(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Auto-apply toggle */}
          <div className="flex items-center justify-between mb-3 p-2 bg-blue-50 rounded">
            <span className="text-sm text-gray-700">Auto-apply updates</span>
            <button
              onClick={() => setAutoApply(!autoApply)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoApply ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoApply ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-hide">
            {Object.entries(groupedUpdates).map(([category, updates]) => (
              <div key={category} className="border border-gray-200 rounded">
                <div className="flex items-center justify-between p-2 bg-gray-50">
                  <div>
                    <div className="text-sm font-medium">{categoryLabels[category]}</div>
                    <div className="text-xs text-gray-600">{updates.length} update(s)</div>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      v{updates[0].data?.version || '?'}
                    </span>
                    {!autoApply && (
                      <button
                        onClick={() => updates.forEach(handleApplyUpdate)}
                        className="bg-blue-600 text-white px-2 py-1 rounded text-xs hover:bg-blue-700"
                      >
                        Apply
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {!autoApply && (
            <div className="mt-3 pt-2 border-t">
              <button
                onClick={() => {
                  pendingUpdates.forEach(handleApplyUpdate);
                }}
                className="w-full bg-blue-600 text-white py-2 rounded text-sm font-medium hover:bg-blue-700"
              >
                Apply All Updates
              </button>
            </div>
          )}

          <button
            onClick={() => setPendingUpdates([])}
            className="mt-2 w-full text-gray-600 text-xs py-1 hover:text-gray-800"
          >
            Clear All
          </button>
        </div>
      )}

      {/* Restart Required Modal */}
      {restartRequired && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center mb-4">
              <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center mr-4">
                <AlertTriangle className="w-6 h-6 text-orange-600" />
              </div>
              <div>
                <h3 className="text-lg font-medium text-gray-900">Restart Required</h3>
                <p className="text-sm text-gray-600">Hardware configuration changes require a restart</p>
              </div>
            </div>
            
            <div className="mb-6">
              <p className="text-gray-700">{restartRequired.reason}</p>
              {restartRequired.hardware_type && (
                <p className="text-sm text-gray-500 mt-2">
                  Hardware: {restartRequired.hardware_type}
                </p>
              )}
            </div>
            
            <div className="flex gap-3">
              <button 
                onClick={handleRestartLater}
                className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded font-medium hover:bg-gray-300"
              >
                Restart Later
              </button>
              <button 
                onClick={handleRestartNow}
                className="flex-1 bg-red-600 text-white py-2 px-4 rounded font-medium hover:bg-red-700"
              >
                Restart Now
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

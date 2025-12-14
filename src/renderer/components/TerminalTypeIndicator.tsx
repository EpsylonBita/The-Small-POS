import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatures } from '../hooks/useFeatures';
import { OrderSyncRouteIndicator } from './OrderSyncRouteIndicator';

interface TerminalTypeIndicatorProps {
  className?: string;
  showDetails?: boolean;
}

/**
 * TerminalTypeIndicator Component
 *
 * Displays the terminal type (Main POS or Mobile POS) as a badge in the header.
 * Shows additional details in a tooltip/panel including parent terminal info
 * and enabled features.
 */
export const TerminalTypeIndicator: React.FC<TerminalTypeIndicatorProps> = ({
  className = '',
  showDetails = false,
}) => {
  const { t } = useTranslation();
  const {
    terminalType,
    parentTerminalId,
    features,
    isMobileWaiter,
    isMainTerminal,
    loading,
  } = useFeatures();
  const [showDetailPanel, setShowDetailPanel] = useState(false);

  // Count enabled features
  const enabledFeaturesCount = Object.values(features).filter(Boolean).length;
  const totalFeatures = Object.keys(features).length;

  // Don't show indicator while loading
  if (loading) {
    return null;
  }

  const getTypeLabel = () => {
    if (isMobileWaiter) {
      return t('terminal.type.mobile_waiter', 'Mobile POS');
    }
    return t('terminal.type.main', 'Main Terminal');
  };

  const getTypeIcon = () => {
    if (isMobileWaiter) {
      // Mobile/tablet icon
      return (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      );
    }
    // Desktop/monitor icon
    return (
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
        />
      </svg>
    );
  };

  const getBadgeColors = () => {
    if (isMobileWaiter) {
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    }
    return 'bg-green-500/20 text-green-400 border-green-500/30';
  };

  const getFeatureLabel = (key: string): string => {
    const labels: Record<string, string> = {
      cashDrawer: t('features.cashDrawer', 'Cash Drawer'),
      zReportExecution: t('features.zReportExecution', 'Z-Report'),
      cashPayments: t('features.cashPayments', 'Cash Payments'),
      cardPayments: t('features.cardPayments', 'Card Payments'),
      orderCreation: t('features.orderCreation', 'Order Creation'),
      orderModification: t('features.orderModification', 'Order Modification'),
      discounts: t('features.discounts', 'Discounts'),
      refunds: t('features.refunds', 'Refunds'),
      expenses: t('features.expenses', 'Expenses'),
      staffPayments: t('features.staffPayments', 'Staff Payments'),
      reports: t('features.reports', 'Reports'),
      settings: t('features.settings', 'Settings'),
    };
    return labels[key] || key;
  };

  return (
    <div className={`relative ${className}`}>
      {/* Badge Button */}
      <button
        className={`group relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all duration-200 hover:bg-white/10 ${getBadgeColors()}`}
        onClick={() => setShowDetailPanel(!showDetailPanel)}
        title={getTypeLabel()}
      >
        {getTypeIcon()}
        <span className="text-xs font-semibold">{getTypeLabel()}</span>

        {/* Indicator dot for mobile waiter */}
        {isMobileWaiter && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        )}
      </button>

      {/* Detail Panel */}
      {showDetailPanel && (
        <div className="absolute top-full right-0 mt-2 bg-gradient-to-br from-gray-900/95 to-gray-800/95 backdrop-blur-xl shadow-2xl rounded-2xl border border-white/10 p-5 min-w-80 z-[100]">
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div
                  className={`p-2 rounded-lg ${isMobileWaiter ? 'bg-blue-500/20' : 'bg-green-500/20'
                    }`}
                >
                  {getTypeIcon()}
                </div>
                <div>
                  <h3 className="font-semibold text-white text-lg">
                    {getTypeLabel()}
                  </h3>
                  <p className="text-xs text-gray-400">
                    {t('terminal.labels.terminalConfig', 'Terminal Configuration')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Terminal Type Info */}
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">
                  {t('terminal.labels.terminalType', 'Terminal Type')}
                </span>
                <span
                  className={`text-sm font-semibold ${isMobileWaiter ? 'text-blue-400' : 'text-green-400'
                    }`}
                >
                  {getTypeLabel()}
                </span>
              </div>

              {/* Parent Terminal (for mobile waiter) */}
              {isMobileWaiter && parentTerminalId && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">
                    {t('terminal.labels.parentTerminal', 'Parent Terminal')}
                  </span>
                  <span className="text-sm font-medium text-white font-mono">
                    {parentTerminalId.substring(0, 8)}...
                  </span>
                </div>
              )}
            </div>

            {/* Feature Summary */}
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">
                  {t('terminal.labels.enabledFeatures', 'Enabled Features')}
                </span>
                <span className="text-sm font-semibold text-white">
                  {enabledFeaturesCount}/{totalFeatures}
                </span>
              </div>

              {/* Feature Grid */}
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(features).map(([key, enabled]) => (
                  <div
                    key={key}
                    className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs ${enabled
                        ? 'bg-green-500/10 text-green-400'
                        : 'bg-red-500/10 text-red-400'
                      }`}
                  >
                    {enabled ? (
                      <svg
                        className="w-3 h-3"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="w-3 h-3"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                    <span className="truncate">{getFeatureLabel(key)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Order Routing Info */}
            <OrderSyncRouteIndicator />

            {/* Mobile Waiter Info Message */}
            {isMobileWaiter && (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3">
                <div className="flex items-start gap-2">
                  <svg
                    className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div>
                    <div className="text-sm font-semibold text-blue-400 mb-1">
                      {t('terminal.labels.mobileWaiterMode', 'Mobile Waiter Mode')}
                    </div>
                    <div className="text-xs text-blue-300">
                      {t(
                        'terminal.messages.mobileWaiterInfo',
                        'Some features are managed by the main terminal. Contact your manager for configuration changes.'
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TerminalTypeIndicator;

import React, { useMemo, useCallback } from "react";
import { useTheme } from '../contexts/theme-context';
import { useI18n } from '../contexts/i18n-context';

interface BulkActionsBarProps {
  selectedCount: number;
  selectionType?: 'pickup' | 'delivery' | null;
  canConvertPickupToDelivery?: boolean;
  deliverySelectionCanBeCompleted?: boolean;
  activeTab: 'orders' | 'delivered' | 'canceled' | 'tables';
  onBulkAction: (action: string) => void;
  onClearSelection: () => void;
  isLoading?: boolean;
}

interface ActionConfig {
  id: string;
  label: string;
  icon: string;
  variant: 'primary' | 'secondary' | 'warning' | 'danger' | 'success' | 'info' | 'map' | 'neutral';
  disabled?: boolean;
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = React.memo(({
  selectedCount,
  selectionType = null,
  canConvertPickupToDelivery = false,
  deliverySelectionCanBeCompleted = false,
  activeTab,
  onBulkAction,
  onClearSelection
}) => {
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();

  // Define actions based on active tab.
  //
  // Wave 6 L: labels previously hardcoded English strings. All labels
  // now route through the `bulkActions.*` i18n namespace so both
  // en.json and el.json (and any future locale) can translate them.
  const getActionsForTab = useCallback((): ActionConfig[] => {
    switch (activeTab) {
      case 'orders':
        return [
          { id: 'assign', label: t('bulkActions.driver'), icon: '', variant: 'primary' },
          { id: 'edit', label: t('bulkActions.editOrders'), icon: '✎', variant: 'info' },
          { id: 'delivered', label: t('bulkActions.delivered'), icon: '', variant: 'warning' },
          { id: 'cancel', label: t('bulkActions.cancelOrders'), icon: '✕', variant: 'danger' },
        ];
      case 'delivered':
        return [
          { id: 'return', label: t('bulkActions.return'), icon: '↶', variant: 'secondary' },
          { id: 'assign', label: t('bulkActions.reassign'), icon: '🚗', variant: 'primary' },
          { id: 'cancel', label: t('bulkActions.cancelOrders'), icon: '✕', variant: 'danger' },
        ];
      case 'canceled':
        return [
          { id: 'return', label: t('bulkActions.return'), icon: '↶', variant: 'primary' },
          { id: 'map', label: t('bulkActions.map'), icon: '🗺️', variant: 'map' },
        ];
      default:
        return [];
    }
  }, [activeTab, t]);

  const actions = useMemo(() => getActionsForTab(), [getActionsForTab]);
  const primaryActions = useMemo(() => actions.filter(action => action.variant === 'primary'), [actions]);
  const deliveredAction = useMemo(() => actions.find(action => action.id === 'delivered'), [actions]);
  const editAction = useMemo(() => actions.find(action => action.id === 'edit'), [actions]);
  const cancelAction = useMemo(() => actions.find(action => action.id === 'cancel'), [actions]);

  const getButtonStyles = useCallback((
    variant: ActionConfig['variant'],
    isCompact = false
  ) => {
    const baseStyles = `
      ${isCompact ? 'px-2 sm:px-3 py-1.5 text-xs sm:text-sm' : 'px-3 sm:px-4 py-2 sm:py-2.5'}
      rounded-lg font-medium transition-all duration-200
      transform hover:scale-105 active:scale-95 border backdrop-blur-sm
      flex items-center gap-1.5 sm:gap-2 whitespace-nowrap
      min-h-[40px] sm:min-h-[44px] touch-feedback
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
      focus-visible:ring-offset-transparent
    `;

    switch (variant) {
      case 'primary':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-blue-600 text-white border-blue-700 shadow-lg shadow-blue-600/25 hover:bg-blue-700 focus-visible:ring-blue-500'
            : 'bg-blue-500/90 text-white border-blue-300/30 shadow-lg shadow-blue-950/30 hover:bg-blue-400 focus-visible:ring-blue-300'
        }`;
      case 'success':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-emerald-600 text-white border-emerald-700 shadow-lg shadow-emerald-600/25 hover:bg-emerald-700 focus-visible:ring-emerald-500'
            : 'bg-emerald-500/90 text-white border-emerald-300/30 shadow-lg shadow-emerald-950/30 hover:bg-emerald-400 focus-visible:ring-emerald-300'
        }`;
      case 'info':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-indigo-600 text-white border-indigo-700 shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 focus-visible:ring-indigo-500'
            : 'bg-indigo-500/90 text-white border-indigo-300/30 shadow-lg shadow-indigo-950/30 hover:bg-indigo-400 focus-visible:ring-indigo-300'
        }`;
      case 'map':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-teal-600 text-white border-teal-700 shadow-lg shadow-teal-600/25 hover:bg-teal-700 focus-visible:ring-teal-500'
            : 'bg-teal-500/90 text-white border-teal-300/30 shadow-lg shadow-teal-950/30 hover:bg-teal-400 focus-visible:ring-teal-300'
        }`;
      case 'secondary':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-slate-100 text-slate-800 border-slate-300 shadow-sm shadow-slate-300/30 hover:bg-slate-200 focus-visible:ring-slate-400'
            : 'bg-slate-700/80 text-slate-100 border-slate-500/60 shadow-lg shadow-black/20 hover:bg-slate-600 focus-visible:ring-slate-300'
        }`;
      case 'warning':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-amber-500 text-white border-amber-600 shadow-lg shadow-amber-500/25 hover:bg-amber-600 focus-visible:ring-amber-400'
            : 'bg-amber-500/90 text-white border-amber-300/30 shadow-lg shadow-amber-950/30 hover:bg-amber-400 focus-visible:ring-amber-300'
        }`;
      case 'danger':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-red-500 text-white border-red-600 shadow-lg shadow-red-500/25 hover:bg-red-600 focus-visible:ring-red-400'
            : 'bg-red-500/90 text-white border-red-300/30 shadow-lg shadow-red-950/30 hover:bg-red-400 focus-visible:ring-red-300'
        }`;
      case 'neutral':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-white/80 text-slate-700 border-slate-300 shadow-sm shadow-slate-300/20 hover:bg-slate-100 focus-visible:ring-slate-400'
            : 'bg-slate-800/80 text-slate-100 border-slate-500/50 shadow-lg shadow-black/20 hover:bg-slate-700 focus-visible:ring-slate-300'
        }`;
      default:
        return baseStyles;
    }
  }, [resolvedTheme]);


  if (selectedCount === 0) return null;

  return (
    <div className={`
      backdrop-blur-md rounded-2xl p-2 sm:p-4 border transition-all duration-300 relative z-10
      ${resolvedTheme === 'light'
        ? 'bg-white/70 border-gray-200/40 shadow-xl shadow-gray-500/10'
        : 'bg-gray-900/40 border-white/10 shadow-xl shadow-black/20'
      }
    `}>
      {/* Main container with improved layout */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">

        {/* Left section - Selection summary with enhanced visual treatment */}
        <div className="flex items-center gap-4">
                     <div className={`
             flex items-center justify-center w-10 h-10 rounded-full border-2
             ${resolvedTheme === 'light'
               ? 'bg-blue-50/80 border-blue-500/60 text-blue-700'
               : 'bg-blue-500/10 border-blue-400/30 text-blue-200'
             }
           `}>
             {/* Selection count only */}
             <span className="font-bold text-sm">
               {selectedCount}
             </span>
           </div>

          {/* Visual separator */}
          <div className={`
            w-px h-8
            ${resolvedTheme === 'light' ? 'bg-gray-300/60' : 'bg-white/20'}
          `} />
        </div>

        {/* Right section - Actions based on selection type */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {/* Conditional actions by selectionType */}
          {selectionType === 'delivery' && (
            <>
              <button className={getButtonStyles('primary')} onClick={(e) => { e.preventDefault(); onBulkAction('assign'); }}>{t('bulkActions.driver')}</button>
              {/* The "Set as Pickup" (Παραλαβή) shortcut used to live here.
                  Removed 2026-04-22: the EditOptionsModal now exposes the
                  same delivery → pickup conversion inline alongside the
                  other order-type changes, so keeping a top-level bulk
                  shortcut just duplicates the path and clutters the
                  toolbar. The underlying handler + confirmation modal
                  remain in OrderDashboard in case a future entry point
                  re-introduces a programmatic conversion trigger. */}
              {deliverySelectionCanBeCompleted && (
                <button className={getButtonStyles('warning')} onClick={(e) => { e.preventDefault(); onBulkAction('delivered'); }}>{t('bulkActions.delivered')}</button>
              )}
              <button className={getButtonStyles('info')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}>{t('bulkActions.edit')}</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}>{t('bulkActions.cancel')}</button>
              <button className={getButtonStyles('map')} onClick={(e) => { e.preventDefault(); onBulkAction('map'); }}>{t('bulkActions.map')}</button>
            </>
          )}

          {selectionType === 'pickup' && (
            <>
              {canConvertPickupToDelivery && (
                <button className={getButtonStyles('primary')} onClick={(e) => { e.preventDefault(); onBulkAction('delivery'); }}>{t('bulkActions.delivery')}</button>
              )}
              <button className={`${getButtonStyles('warning')}`} onClick={(e) => { e.preventDefault(); onBulkAction('delivered'); }}>{t('bulkActions.delivered')}</button>
              <button className={getButtonStyles('info')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}>{t('bulkActions.edit')}</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}>{t('bulkActions.cancel')}</button>
            </>
          )}

          {/* View shows only when single selection */}
          {selectedCount === 1 && (
            <button className={getButtonStyles('info', true)} onClick={(e) => { e.preventDefault(); onBulkAction('view'); }}>{t('bulkActions.view')}</button>
          )}

          {/* Divider */}
          <div className={`
            w-px h-8 mx-2
            ${resolvedTheme === 'light' ? 'bg-gray-300/60' : 'bg-white/20'}
          `} />

          {/* Clear selection button with enhanced styling */}
          <button
            onClick={(e) => {
              e.preventDefault();
              onClearSelection();
            }}
            className={getButtonStyles('neutral')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>{t('bulkActions.clear')}</span>
          </button>
        </div>
      </div>

      {/* Optional: Progress indicator for bulk operations */}
      <div className={`
        mt-3 h-1 rounded-full overflow-hidden opacity-0 transition-opacity duration-300
        ${resolvedTheme === 'light' ? 'bg-gray-200' : 'bg-white/10'}
      `}>
        <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: '0%' }} />
      </div>
    </div>
  );
});

export default BulkActionsBar;

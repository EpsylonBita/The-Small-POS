import React, { useMemo, useCallback } from "react";
import { useTheme } from '../contexts/theme-context';
import { useI18n } from '../contexts/i18n-context';
import { User, CheckCircle, Pencil, X, Map as MapIcon, Eye } from 'lucide-react';
import type { TabId } from './OrderTabsBar';

interface BulkActionsBarProps {
  selectedCount: number;
  selectionType?: 'pickup' | 'delivery' | null;
  deliverySelectionCanBeCompleted?: boolean;
  // Shared with OrderTabsBar so hub tabs (tables/rooms/services) typecheck. Non-order
  // tabs have no bulk selection, so getActionsForTab falls through to [] for them.
  activeTab: TabId;
  onBulkAction: (action: string) => void;
  onClearSelection: () => void;
  isLoading?: boolean;
}

interface ActionConfig {
  id: string;
  label: string;
  variant: 'primary' | 'secondary' | 'warning' | 'danger' | 'success' | 'info' | 'map' | 'neutral';
  disabled?: boolean;
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = React.memo(({
  selectedCount,
  selectionType = null,
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
          { id: 'assign', label: t('bulkActions.driver'), variant: 'primary' },
          { id: 'edit', label: t('bulkActions.editOrders'), variant: 'warning' },
          { id: 'delivered', label: t('bulkActions.delivered'), variant: 'success' },
          { id: 'cancel', label: t('bulkActions.cancelOrders'), variant: 'danger' },
        ];
      case 'delivered':
        return [
          { id: 'return', label: t('bulkActions.return'), variant: 'secondary' },
          { id: 'assign', label: t('bulkActions.reassign'), variant: 'primary' },
          { id: 'cancel', label: t('bulkActions.cancelOrders'), variant: 'danger' },
        ];
      case 'canceled':
        return [
          { id: 'return', label: t('bulkActions.return'), variant: 'primary' },
          { id: 'map', label: t('bulkActions.map'), variant: 'map' },
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
      rounded-xl font-medium transition-all duration-200
      transform active:scale-95 border backdrop-blur-sm
      flex items-center justify-center gap-1.5 sm:gap-2 whitespace-nowrap
      min-h-[40px] sm:min-h-[44px] touch-feedback
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
      focus-visible:ring-offset-transparent
    `;

    // Neutral glass for non-semantic utility actions (Assign/Return/Map/View/Clear). On-theme
    // black/white/grey — never off-theme blue/slate. Green/red/amber stay reserved below for
    // success / destructive / edit-utility, so colour now encodes meaning, not chrome.
    const neutralGlass =
      resolvedTheme === 'light'
        ? 'bg-white/80 text-zinc-700 border-zinc-300 shadow-sm shadow-zinc-300/20 active:bg-zinc-100 focus-visible:ring-zinc-400'
        : 'bg-zinc-800/80 text-zinc-100 border-zinc-600/50 shadow-lg shadow-black/20 active:bg-zinc-700 focus-visible:ring-zinc-400';

    switch (variant) {
      case 'success':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-emerald-600 text-white border-emerald-700 shadow-lg shadow-emerald-600/25 active:bg-emerald-700 focus-visible:ring-emerald-500'
            : 'bg-emerald-500/90 text-white border-emerald-300/30 shadow-lg shadow-emerald-950/30 active:bg-emerald-400 focus-visible:ring-emerald-300'
        }`;
      case 'warning':
        // Amber = utility/edit action (Edit). Not info-blue / slate.
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-amber-500 text-white border-amber-600 shadow-lg shadow-amber-500/25 active:bg-amber-600 focus-visible:ring-amber-400'
            : 'bg-amber-500/90 text-white border-amber-300/30 shadow-lg shadow-amber-950/30 active:bg-amber-400 focus-visible:ring-amber-300'
        }`;
      case 'danger':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-red-500 text-white border-red-600 shadow-lg shadow-red-500/25 active:bg-red-600 focus-visible:ring-red-400'
            : 'bg-red-500/90 text-white border-red-300/30 shadow-lg shadow-red-950/30 active:bg-red-400 focus-visible:ring-red-300'
        }`;
      case 'primary':
      case 'secondary':
      case 'info':
      case 'map':
      case 'neutral':
        return `${baseStyles} ${neutralGlass}`;
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
               ? 'bg-zinc-100/80 border-amber-400/50 text-zinc-800'
               : 'bg-zinc-800/60 border-amber-400/40 text-zinc-100'
             }
           `}>
             {/* Selection count only — neutral chip with a subtle amber ring (on-theme). */}
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
              <button className={getButtonStyles('primary')} onClick={(e) => { e.preventDefault(); onBulkAction('assign'); }}><User className="w-4 h-4" />{t('bulkActions.driver')}</button>
              {/* The "Set as Pickup" (Παραλαβή) shortcut used to live here.
                  Removed 2026-04-22: the EditOptionsModal now exposes the
                  same delivery → pickup conversion inline alongside the
                  other order-type changes, so keeping a top-level bulk
                  shortcut just duplicates the path and clutters the
                  toolbar. The underlying handler + confirmation modal
                  remain in OrderDashboard in case a future entry point
                  re-introduces a programmatic conversion trigger. */}
              {deliverySelectionCanBeCompleted && (
                <button className={getButtonStyles('success')} onClick={(e) => { e.preventDefault(); onBulkAction('delivered'); }}><CheckCircle className="w-4 h-4" />{t('bulkActions.delivered')}</button>
              )}
              <button className={getButtonStyles('warning')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}><Pencil className="w-4 h-4" />{t('bulkActions.edit')}</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}><X className="w-4 h-4" />{t('bulkActions.cancel')}</button>
              <button className={getButtonStyles('map')} onClick={(e) => { e.preventDefault(); onBulkAction('map'); }}><MapIcon className="w-4 h-4" />{t('bulkActions.map')}</button>
            </>
          )}

          {selectionType === 'pickup' && (
            <>
              <button className={`${getButtonStyles('success')}`} onClick={(e) => { e.preventDefault(); onBulkAction('delivered'); }}><CheckCircle className="w-4 h-4" />{t('bulkActions.delivered')}</button>
              <button className={getButtonStyles('warning')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}><Pencil className="w-4 h-4" />{t('bulkActions.edit')}</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}><X className="w-4 h-4" />{t('bulkActions.cancel')}</button>
            </>
          )}

          {/* View shows only when single selection */}
          {selectedCount === 1 && (
            <button className={getButtonStyles('neutral', true)} onClick={(e) => { e.preventDefault(); onBulkAction('view'); }}><Eye className="w-4 h-4" />{t('bulkActions.view')}</button>
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
            <X className="w-4 h-4" />
            <span>{t('bulkActions.clear')}</span>
          </button>
        </div>
      </div>

      {/* Optional: Progress indicator for bulk operations */}
      <div className={`
        mt-3 h-1 rounded-full overflow-hidden opacity-0 transition-opacity duration-300
        ${resolvedTheme === 'light' ? 'bg-gray-200' : 'bg-white/10'}
      `}>
        <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: '0%' }} />
      </div>
    </div>
  );
});

export default BulkActionsBar;

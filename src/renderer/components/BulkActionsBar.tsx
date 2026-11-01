import React, { useMemo, useCallback } from "react";
import { AnimatePresence, motion } from 'framer-motion';
import { useI18n } from '../contexts/i18n-context';
import { User, CheckCircle, Pencil, X, Map as MapIcon, Eye, RotateCcw, PackageCheck } from 'lucide-react';
import type { TabId } from './OrderTabsBar';

interface BulkActionsBarProps {
  selectedCount: number;
  selectionType?: 'pickup' | 'delivery' | null;
  deliverySelectionCanBeCompleted?: boolean;
  // «Έτοιμη» (THE-435): every selected order is a platform order that can
  // still advance to 'ready' — the button relays prepared/ready to the
  // platform, summoning the platform's own rider.
  platformReadySelectionEligible?: boolean;
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
  variant: 'primary' | 'secondary' | 'warning' | 'danger' | 'success' | 'reset' | 'info' | 'map' | 'neutral';
  disabled?: boolean;
}

// Founder 31/10: the bar opens like iOS. A critically damped spring (bounce 0, no overshoot): the height
// glides open so the list below moves smoothly, and the bar slides and fades in. MotionConfig in App.tsx
// makes it instant under the Windows reduce-motion setting. The actions act at once; nothing waits for it.
const IOS_SPRING = { type: 'spring', duration: 0.38, bounce: 0 } as const;

const BulkActionsBar: React.FC<BulkActionsBarProps> = React.memo(({
  selectedCount,
  selectionType = null,
  deliverySelectionCanBeCompleted = false,
  platformReadySelectionEligible = false,
  activeTab,
  onBulkAction,
  onClearSelection
}) => {
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
          { id: 'reset', label: t('bulkActions.reset'), variant: 'reset' },
          { id: 'cancel', label: t('bulkActions.cancelOrders'), variant: 'danger' },
        ];
      case 'canceled':
        return [
          { id: 'restore', label: t('bulkActions.restore'), variant: 'success' },
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

  // Wave ΣΤ2 (founder 31/10/2026): solid kit buttons. One yellow primary per selection (Reset,
  // Restore or Delivered; Ready when Delivered is not offered), neutral secondaries (Edit, Driver,
  // Map, View, Clear), red-text Cancel. The meaning stays in the label and icon, never a fill.
  const getButtonStyles = useCallback((
    variant: ActionConfig['variant'],
    _isCompact = false
  ) => {
    const baseStyles =
      'pos-solid-btn pos-solid-btn--sm min-h-[40px] sm:min-h-touch flex items-center justify-center whitespace-nowrap ' +
      'transition-transform duration-150 active:scale-95 touch-feedback ' +
      'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--pos-s-fg) focus-visible:ring-offset-2';

    switch (variant) {
      case 'success':
      case 'reset':
        return `${baseStyles} pos-solid-btn--primary`;
      case 'danger':
        return `${baseStyles} pos-solid-btn--danger`;
      case 'warning':
      case 'primary':
      case 'secondary':
      case 'info':
      case 'map':
      case 'neutral':
        return baseStyles;
      default:
        return baseStyles;
    }
  }, []);


  return (
    <AnimatePresence initial={false}>
    {selectedCount > 0 && (
    <motion.div
      key="bulk-actions"
      data-testid="bulk-actions-bar"
      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
      // A closing bar takes no taps: the selection is already gone.
      exit={{ height: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }}
      transition={IOS_SPRING}
    >
    <motion.div
      initial={{ y: -12, scale: 0.97 }}
      animate={{ y: 0, scale: 1 }}
      exit={{ y: -12, scale: 0.97 }}
      transition={IOS_SPRING}
      className="relative z-10 rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-2 shadow-xs sm:p-4"
    >
      {/* Main container with improved layout */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">

        {/* Left section - Selection summary with enhanced visual treatment */}
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-(--pos-s-yellow) bg-(--pos-s-surface-2) text-(--pos-s-fg)">
             {/* Selection count only: a neutral chip with a solid yellow ring. */}
             <span className="font-bold text-sm">
               {selectedCount}
             </span>
           </div>

          {/* Visual separator */}
          <div className="h-8 w-px bg-(--pos-s-border)" />
        </div>

        {/* Right section - Actions based on selection type */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {activeTab === 'delivered' && (
            <>
              <button className={`${getButtonStyles('reset')} bulk-action-reset uppercase`} onClick={(e) => { e.preventDefault(); onBulkAction('reset'); }}><RotateCcw className="w-4 h-4" />{t('bulkActions.reset')}</button>
              <button className={getButtonStyles('warning')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}><Pencil className="w-4 h-4" />{t('bulkActions.edit')}</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}><X className="w-4 h-4" />{t('bulkActions.cancel')}</button>
            </>
          )}

          {/* Conditional actions by selectionType */}
          {activeTab === 'canceled' && (
            <button className={getButtonStyles('success')} onClick={(e) => { e.preventDefault(); onBulkAction('restore'); }}><RotateCcw className="w-4 h-4" />{t('bulkActions.restore')}</button>
          )}

          {activeTab === 'orders' && selectionType === 'delivery' && (
            <>
              <button className={getButtonStyles('primary')} onClick={(e) => { e.preventDefault(); onBulkAction('assign'); }}><User className="w-4 h-4" />{t('bulkActions.driver')}</button>
              {/* Platform orders only: relays prepared/ready to the platform so
                  THEIR rider is dispatched. «Οδηγός» stays for phone orders and
                  for platform agreements served by store drivers (THE-435). */}
              {platformReadySelectionEligible && (
                <button className={getButtonStyles(deliverySelectionCanBeCompleted ? 'neutral' : 'success')} onClick={(e) => { e.preventDefault(); onBulkAction('platform_ready'); }}><PackageCheck className="w-4 h-4" />{t('bulkActions.ready')}</button>
              )}
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
              {/* Multi-stop route planner: meaningful from TWO deliveries up
                  (the founder's spec, 2026-08-18). A single delivery already
                  has its own store→customer route on the order card's pin,
                  so showing this button for one selection produced two
                  buttons for the same job that opened different maps. */}
              {selectedCount >= 2 && (
                <button className={getButtonStyles('map')} onClick={(e) => { e.preventDefault(); onBulkAction('map'); }}><MapIcon className="w-4 h-4" />{t('bulkActions.map')}</button>
              )}
            </>
          )}

          {activeTab === 'orders' && selectionType === 'pickup' && (
            <>
              {/* Platform takeaway orders need the same prepared/ready relay —
                  efood notifies the customer their pickup is ready. */}
              {platformReadySelectionEligible && (
                <button className={getButtonStyles('neutral')} onClick={(e) => { e.preventDefault(); onBulkAction('platform_ready'); }}><PackageCheck className="w-4 h-4" />{t('bulkActions.ready')}</button>
              )}
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
          <div className="mx-2 h-8 w-px bg-(--pos-s-border)" />

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
    </motion.div>
    </motion.div>
    )}
    </AnimatePresence>
  );
});

export default BulkActionsBar;

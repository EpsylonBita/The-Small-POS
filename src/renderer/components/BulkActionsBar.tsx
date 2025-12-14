import React, { useMemo, useCallback } from "react";
import { useTheme } from '../contexts/theme-context';

interface BulkActionsBarProps {
  selectedCount: number;
  selectionType?: 'pickup' | 'delivery' | null;
  activeTab: 'orders' | 'delivered' | 'canceled' | 'tables';
  onBulkAction: (action: string) => void;
  onClearSelection: () => void;
  isLoading?: boolean;
}

interface ActionConfig {
  id: string;
  label: string;
  icon: string;
  variant: 'primary' | 'secondary' | 'warning' | 'danger';
  disabled?: boolean;
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = React.memo(({
  selectedCount,
  selectionType = null,
  activeTab,
  onBulkAction,
  onClearSelection
}) => {
  const { resolvedTheme } = useTheme();

  // Define actions based on active tab
  const getActionsForTab = useCallback((): ActionConfig[] => {
    switch (activeTab) {
      case 'orders':
        return [
          { id: 'assign', label: 'Driver', icon: '', variant: 'primary' },

          { id: 'edit', label: 'Edit Orders', icon: '✎', variant: 'secondary' },
          { id: 'delivered', label: 'Delivered', icon: '', variant: 'warning' },
          { id: 'cancel', label: 'Cancel Orders', icon: '✕', variant: 'danger' },
        ];
      case 'delivered':
        return [
          { id: 'return', label: 'Return to Orders', icon: '↶', variant: 'secondary' },
          { id: 'assign', label: 'Reassign Driver', icon: '🚗', variant: 'primary' },
          { id: 'cancel', label: 'Cancel Orders', icon: '✕', variant: 'danger' },
        ];
      case 'canceled':
        return [
          { id: 'return', label: 'Return to Orders', icon: '↶', variant: 'primary' },
          { id: 'map', label: 'Map', icon: '🗺️', variant: 'secondary' },
        ];
      default:
        return [];
    }
  }, [activeTab]);

  const actions = useMemo(() => getActionsForTab(), [getActionsForTab]);
  const primaryActions = useMemo(() => actions.filter(action => action.variant === 'primary'), [actions]);
  const deliveredAction = useMemo(() => actions.find(action => action.id === 'delivered'), [actions]);
  const editAction = useMemo(() => actions.find(action => action.id === 'edit'), [actions]);
  const cancelAction = useMemo(() => actions.find(action => action.id === 'cancel'), [actions]);

  const getButtonStyles = useCallback((variant: string, isCompact = false) => {
    const baseStyles = `
      ${isCompact ? 'px-2 sm:px-3 py-1.5 text-xs sm:text-sm' : 'px-3 sm:px-4 py-2 sm:py-2.5'}
      rounded-lg font-medium transition-all duration-200
      transform hover:scale-105 active:scale-95 border backdrop-blur-sm
      flex items-center gap-1.5 sm:gap-2 whitespace-nowrap
      min-h-[40px] sm:min-h-[44px] touch-feedback
    `;

    switch (variant) {
      case 'primary':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-blue-500/80 hover:bg-blue-600/80 text-white border-blue-500/30 shadow-lg shadow-blue-500/25'
            : 'bg-blue-500/30 hover:bg-blue-500/40 text-blue-200 border-blue-400/30'
        }`;
      case 'secondary':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-gray-100/80 hover:bg-gray-200/80 text-gray-700 border-gray-300/30'
            : 'bg-white/10 hover:bg-white/15 text-white/70 border-white/20'
        }`;
      case 'warning':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-amber-500/80 hover:bg-amber-600/80 text-white border-amber-500/30 shadow-lg shadow-amber-500/25'
            : 'bg-amber-500/30 hover:bg-amber-500/40 text-amber-200 border-amber-400/30'
        }`;
      case 'danger':
        return `${baseStyles} ${
          resolvedTheme === 'light'
            ? 'bg-red-500/80 hover:bg-red-600/80 text-white border-red-500/30 shadow-lg shadow-red-500/25'
            : 'bg-red-500/30 hover:bg-red-500/40 text-red-200 border-red-400/30'
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
              <button className={getButtonStyles('primary')} onClick={(e) => { e.preventDefault(); onBulkAction('assign'); }}>Driver</button>
              <button className={getButtonStyles('secondary')} onClick={(e) => { e.preventDefault(); onBulkAction('pickup'); }}>Pickup</button>
              <button className={getButtonStyles('secondary')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}>Edit</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}>Cancel</button>
              <button className={`${getButtonStyles('secondary')} ${resolvedTheme === 'light' ? 'bg-black/80 hover:bg-black/90 text-white' : 'bg-white/80 hover:bg-white/90 text-black'}`} onClick={(e) => { e.preventDefault(); onBulkAction('map'); }}>Map</button>
            </>
          )}

          {selectionType === 'pickup' && (
            <>
              <button className={`${getButtonStyles('warning')}`} onClick={(e) => { e.preventDefault(); onBulkAction('delivered'); }}>Delivered</button>
              <button className={getButtonStyles('secondary')} onClick={(e) => { e.preventDefault(); onBulkAction('edit'); }}>Edit</button>
              <button className={getButtonStyles('danger')} onClick={(e) => { e.preventDefault(); onBulkAction('cancel'); }}>Cancel</button>
            </>
          )}

          {/* View shows only when single selection */}
          {selectedCount === 1 && (
            <button className={getButtonStyles('secondary', true)} onClick={(e) => { e.preventDefault(); onBulkAction('view'); }}>View</button>
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
            className={`
              px-4 py-2 rounded-lg font-medium transition-all duration-200
              flex items-center gap-2 border
              ${resolvedTheme === 'light'
                ? 'bg-gray-100/80 hover:bg-gray-200/80 text-gray-600 border-gray-300/30'
                : 'bg-white/10 hover:bg-white/15 text-white/70 border-white/20'
              }
            `}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>Clear</span>
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
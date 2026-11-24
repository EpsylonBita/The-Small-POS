import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { useCashierOperationsLocked } from '../contexts/cashier-gate-context';

export const UTILITY_RAIL_EXPENSES_SLOT_ID = 'pos-utility-rail-expenses';
export const UTILITY_RAIL_CALLS_SLOT_ID = 'pos-utility-rail-calls';

// Founder 31/10 («ένα άλλο μικρό sidebar όπως αυτό με 3 εικονίδια: έξοδα, κατάσταση υγείας και αλλαγή
// θέματος· έτσι η υγεία και τα έξοδα έχουν συγκεκριμένες θέσεις και δεν αιωρούνται»): a second small rail
// on the right, dressed like the navigation rail, with three fixed places -- expenses, health (in the middle), theme.
// Health stays reachable during cashier recovery (data-cashier-recovery), as it was.
export const UtilityRail = ({ onHealthState }: { onHealthState?: React.ComponentProps<typeof SyncStatusIndicator>['onHealthState'] }) => {
  const { t } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  return (
    <div
      data-utility-rail
      data-cashier-recovery="true"
      // Founder 31/10: in the middle of the right edge, not at the top.
      className="pointer-events-none fixed right-0 top-1/2 z-50 -translate-y-1/2"
    >
      <div
        className={`pointer-events-auto pos-shell-glow-nav flex flex-col items-center gap-4 rounded-l-3xl border-l border-(--pos-s-border) p-4 backdrop-blur-xl ${
          isDark ? 'bg-black' : 'bg-white/90'
        }`}
      >
        {/* Founder 23/11: a till that records its calls gets a phone button for the «Πρόσφατες κλήσεις»
            list, above the three fixed places. The slot stays empty on every other till. */}
        <div id={UTILITY_RAIL_CALLS_SLOT_ID} className="contents" />
        {/* Founder 31/10: expenses on top, the heart in the middle, the theme below. The expenses
            button comes from the main layout, which owns the expenses window. */}
        <div id={UTILITY_RAIL_EXPENSES_SLOT_ID} className="contents" />
        <SyncStatusIndicator layout="rail" onHealthState={onHealthState} />
        <button
          type="button"
          data-utility-rail-theme
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className={`flex h-12 w-12 items-center justify-center rounded-xl transition-transform focus:outline-hidden active:scale-95 ${isDark ? 'text-zinc-400' : 'text-black'}`}
          aria-label={isDark ? t('theme.switchToLight') : t('theme.switchToDark')}
        >
          {isDark ? <Sun className="h-5 w-5" aria-hidden="true" /> : <Moon className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
};

/** Places a button in one of the rail's slots. The rail is a recovery root so Health stays
 * reachable on a locked till; a slot's button opens an operation, so it leaves the rail while
 * the cashier gate is locked. */
const UtilityRailSlot = ({ slotId, children }: { slotId: string; children: React.ReactNode }) => {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const cashierLocked = useCashierOperationsLocked();
  useEffect(() => {
    setTarget(document.getElementById(slotId));
  }, [slotId]);
  return target && !cashierLocked ? createPortal(children, target) : null;
};

/** Places its button in the rail's expenses spot, above health and theme. */
export const UtilityRailExpensesSlot = ({ children }: { children: React.ReactNode }) => (
  <UtilityRailSlot slotId={UTILITY_RAIL_EXPENSES_SLOT_ID}>{children}</UtilityRailSlot>
);

/** Places the «Πρόσφατες κλήσεις» button at the top of the rail. */
export const UtilityRailCallsSlot = ({ children }: { children: React.ReactNode }) => (
  <UtilityRailSlot slotId={UTILITY_RAIL_CALLS_SLOT_ID}>{children}</UtilityRailSlot>
);

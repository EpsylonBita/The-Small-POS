import React, { lazy, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { CashierGateContext, CashierRecovery, CashierWaiterContext, RecoveryActionsContext, useCashierOperationsLocked } from '../contexts/cashier-gate-context';
import { useCashierDayGate } from '../hooks/useCashierDayGate';
import { useFeatures } from '../hooks/useFeatures';
import { useEndOfDayStatus } from '../hooks/useEndOfDayStatus';
import { PHONE_SHIFT_STAFF_OPEN_EVENT } from '../hooks/usePhoneShiftNotices';
import { ShiftManager, type ShiftManagerRef } from './ShiftManager';
import { DeferredModal } from './ui/DeferredModal';
const loadZReportModal = () => import('./modals/ZReportModal');
const ZReportModal = lazy(loadZReportModal);

/**
 * The locked cashier day's recovery actions, or null outside the gate. While the
 * day is locked, the layout's own Z modal is fenced and hidden; `completeZ` opens
 * the gate's recovery Z modal instead (founder rule R6, 13/10/2026).
 */
export { useCashierRecoveryActions } from '../contexts/cashier-gate-context';

/**
 * The only surfaces a locked cashier day leaves interactive: recovery dialogs
 * (shift, Z, health/support, sync recovery), shell navigation and the window frame.
 * A portal that must stay usable while locked marks its root `data-cashier-recovery`.
 */
export const CASHIER_GATE_SAFE_SELECTOR =
  '[data-cashier-recovery="true"], [data-cashier-navigation="true"], [data-app-window-frame]';

/** Keep a page/draft mounted while only its operational content is unavailable. */
export function CashierOperationalBoundary({ children }: { children: React.ReactNode }) {
  const locked = useCashierOperationsLocked();
  const actions = useContext(RecoveryActionsContext);
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const safeFocus = document.activeElement instanceof Element && document.activeElement.closest(CASHIER_GATE_SAFE_SELECTOR);
    if (locked && !safeFocus) {
      prompt.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [locked, actions?.resolving]);
  return <div className="relative h-full min-h-0">
    <div ref={content} className={`h-full min-h-0 ${locked ? 'invisible' : ''}`} inert={locked} aria-hidden={locked || undefined} data-cashier-operational="true">{children}</div>
    {locked && actions && <div ref={prompt} data-cashier-recovery="true" className="absolute inset-0 z-40 flex items-center justify-center p-4">
      <div role={actions.resolving ? "status" : "alert"} aria-live="polite" className="pos-card w-full max-w-md shadow-xl">
        {actions.resolving ? <div className="flex items-center justify-center gap-3 p-6 sm:p-8">
          <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p>{t('cashierGate.checking')}</p>
        </div> : <div className="p-6 sm:p-8">
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t(actions.resolving ? 'cashierGate.checking' : 'cashierGate.title')}</h1>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-(--pos-s-muted)">{t(actions.waiter ? 'cashierGate.waiterBody' : 'cashierGate.body')}</p>
          </div>
          <div className="mt-7 space-y-3">
            <button onClick={actions.checkIn} className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary w-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--pos-s-fg) focus-visible:ring-offset-2">{t('navigation.checkIn')}<ArrowRight size={18} aria-hidden="true" /></button>
            {actions.pendingZ && !actions.waiter && <button onClick={actions.completeZ} className="pos-solid-btn pos-solid-btn--md w-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--pos-s-fg)">{t('shift.actions.completeZReport')}</button>}
          </div>
        </div>}
      </div>
    </div>}
  </div>;
}

export function GlobalCashierGate({ children }: { children: React.ReactNode }) {
  const features = useFeatures();
  const day = useCashierDayGate({ isMobileWaiter: features.isMobileWaiter,
    parentTerminalId: features.parentTerminalId || features.ownerTerminalId, ready: !features.loading });
  const locked = day.isResolving || day.isBlocked;
  const { endOfDayStatus, isPendingLocalSubmit } = useEndOfDayStatus(day.branchId);
  const shiftManager = useRef<ShiftManagerRef>(null);
  const [showZ, setShowZ] = useState(false);
  // The phone-shift notice's «Staff shifts» (founder rule 13/10/2026: phones
  // hand over to the Main) opens this staff modal: always mounted while logged
  // in and a recovery surface, so it also opens while the cashier day is locked.
  useEffect(() => {
    const open = () => shiftManager.current?.openCheckin();
    window.addEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, open);
    return () => window.removeEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, open);
  }, []);
  useEffect(() => {
    if (!locked) return;
    // Portals escape an operational boundary's inert subtree. Only shell
    // navigation, window controls and explicit lifecycle/support paths remain interactive.
    const fence = (event: Event) => {
      const target = event.target;
      const keyboard = event instanceof KeyboardEvent ? event : null;
      if (keyboard?.key === 'Tab') {
        const recoveryDialog = Array.from(document.querySelectorAll<HTMLElement>('[data-cashier-recovery="true"] [role="dialog"]'))
          .filter(dialog => !dialog.closest('[inert], [aria-hidden="true"]')).pop();
        const controls = recoveryDialog ? Array.from(recoveryDialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')) : [];
        const current = controls.indexOf(target as HTMLElement);
        if (controls.length && (current < 0 || (keyboard.shiftKey ? current === 0 : current === controls.length - 1))) {
          keyboard.preventDefault();
          keyboard.stopImmediatePropagation();
          controls[keyboard.shiftKey ? controls.length - 1 : 0].focus();
          return;
        }
      }
      const shortcut = keyboard && (/^F\d+$/.test(keyboard.key) || keyboard.altKey || keyboard.metaKey || keyboard.ctrlKey);
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const clipboard = keyboard && editing && !keyboard.altKey && /^[acvxyz]$/i.test(keyboard.key);
      const safeTarget = target instanceof Element && target.closest(CASHIER_GATE_SAFE_SELECTOR);
      if (safeTarget && (!shortcut || clipboard)) return;
      // Native Tab order skips inert operational content and can reach the sidebar.
      if (keyboard?.key === 'Tab' && target === document.body) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['click', 'pointerdown', 'mousedown', 'touchstart', 'keydown', 'submit', 'focusin'];
    events.forEach(event => window.addEventListener(event, fence, true));
    return () => events.forEach(event => window.removeEventListener(event, fence, true));
  }, [locked]);
  return <CashierWaiterContext.Provider value={features.isMobileWaiter}><CashierGateContext.Provider value={locked}>
    <RecoveryActionsContext.Provider value={{ resolving: day.isResolving, waiter: features.isMobileWaiter,
      pendingZ: isPendingLocalSubmit, checkIn: () => shiftManager.current?.openCheckin(), completeZ: () => setShowZ(true) }}>
      {children}
    </RecoveryActionsContext.Provider>
    <CashierRecovery>
      <ShiftManager ref={shiftManager} suppressAutoCheckin />
      <DeferredModal isOpen={showZ} onClose={() => setShowZ(false)} preload={loadZReportModal}>
        <ZReportModal isOpen={showZ} onClose={() => setShowZ(false)} branchId={day.branchId || ''}
          date={endOfDayStatus.pendingReportDate || endOfDayStatus.activeReportDate || undefined} lockDate={isPendingLocalSubmit} />
      </DeferredModal>
    </CashierRecovery>
  </CashierGateContext.Provider></CashierWaiterContext.Provider>;
}

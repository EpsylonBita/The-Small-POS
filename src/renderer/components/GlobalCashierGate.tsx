import React, { lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CashierGateContext, CashierRecovery } from '../contexts/cashier-gate-context';
import { useCashierDayGate } from '../hooks/useCashierDayGate';
import { useFeatures } from '../hooks/useFeatures';
import { useEndOfDayStatus } from '../hooks/useEndOfDayStatus';
import { ShiftManager, type ShiftManagerRef } from './ShiftManager';
import { DeferredModal } from './ui/DeferredModal';
const ZReportModal = lazy(() => import('./modals/ZReportModal'));

export function GlobalCashierGate({ children, onLogout, onOpenSettings }: {
  children: React.ReactNode; onLogout: () => void; onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const features = useFeatures();
  const day = useCashierDayGate({ isMobileWaiter: features.isMobileWaiter,
    parentTerminalId: features.parentTerminalId || features.ownerTerminalId, ready: !features.loading });
  const locked = day.isResolving || day.isBlocked;
  const { endOfDayStatus, isPendingLocalSubmit } = useEndOfDayStatus(day.branchId);
  const shiftManager = useRef<ShiftManagerRef>(null);
  const gateElement = useRef<HTMLDivElement>(null);
  const [showZ, setShowZ] = useState(false);
  useEffect(() => {
    if (!locked) return;
    // Portals escape the DOM's inert subtree. Capture their input before React
    // handlers or window-bubble shortcuts, while explicitly permitting lifecycle dialogs.
    const fence = (event: Event) => {
      const target = event.target;
      const keyboard = event instanceof KeyboardEvent ? event : null;
      if (keyboard?.key === 'Tab') {
        const recoveryDialog = Array.from(document.querySelectorAll<HTMLElement>('[data-cashier-recovery="true"] [role="dialog"]'))
          .filter(dialog => !dialog.closest('[inert], [aria-hidden="true"]')).pop();
        const focusScope = recoveryDialog || gateElement.current;
        const controls = focusScope ? Array.from(focusScope.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')) : [];
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
      if (target instanceof Element && target.closest('[data-cashier-recovery="true"]') && (!shortcut || clipboard)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['click', 'pointerdown', 'mousedown', 'touchstart', 'keydown', 'submit', 'focusin'];
    events.forEach(event => window.addEventListener(event, fence, true));
    if (!(document.activeElement instanceof Element && document.activeElement.closest('[data-cashier-recovery="true"]'))) {
      gateElement.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
    return () => events.forEach(event => window.removeEventListener(event, fence, true));
  }, [locked]);
  return <CashierGateContext.Provider value={locked}>
    <div className="h-full min-h-0" inert={locked} aria-hidden={locked || undefined} data-cashier-operational="true">{children}</div>
    {locked && createPortal(<div ref={gateElement} data-liquid-glass-modal-viewport data-cashier-recovery="true" role="alert" aria-live="polite"
      className="fixed inset-0 flex items-center justify-center bg-gray-950 text-white p-6" style={{ zIndex: 2147483000 }}>
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-amber-500/40 bg-gray-900 p-6">
        <h1 className="text-xl font-semibold">{t(day.isResolving ? 'cashierGate.checking' : 'cashierGate.title')}</h1>
        <p>{t(features.isMobileWaiter ? 'cashierGate.waiterBody' : 'cashierGate.body')}</p>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => shiftManager.current?.openCheckin()} className="rounded-lg bg-amber-500 px-4 py-2 text-black">{t('navigation.checkIn')}</button>
          <button onClick={() => void day.recheck()} className="rounded-lg bg-gray-700 px-4 py-2">{t('cashierGate.recheck')}</button>
          {!features.isMobileWaiter && <button onClick={() => setShowZ(true)} className="rounded-lg bg-gray-700 px-4 py-2">{t('shift.actions.completeZReport')}</button>}
          <button onClick={onOpenSettings} className="rounded-lg bg-gray-700 px-4 py-2">{t('navigation.settings')}</button>
          <button onClick={onLogout} className="rounded-lg bg-gray-700 px-4 py-2">{t('navigation.logout')}</button>
        </div>
      </div>
    </div>, document.body)}
    <CashierRecovery>
      <ShiftManager ref={shiftManager} suppressAutoCheckin />
      <DeferredModal isOpen={showZ} onClose={() => setShowZ(false)}>
        <ZReportModal isOpen={showZ} onClose={() => setShowZ(false)} branchId={day.branchId || ''}
          date={endOfDayStatus.pendingReportDate || endOfDayStatus.activeReportDate || undefined} lockDate={isPendingLocalSubmit} />
      </DeferredModal>
    </CashierRecovery>
  </CashierGateContext.Provider>;
}

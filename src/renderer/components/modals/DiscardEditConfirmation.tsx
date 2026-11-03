import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

/** The declaration is explicit; opening or cancelling never discards money. */
export function DiscardEditConfirmation({ isOpen, onDiscard, onClose }: {
  isOpen: boolean; onDiscard: () => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [moneyDeclared, setMoneyDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const declared = useRef(false);
  useEffect(() => { if (isOpen) { declared.current = false; setMoneyDeclared(false); } }, [isOpen]);
  const discard = async () => {
    if (submitting.current || declared.current) return;
    submitting.current = true;
    setBusy(true);
    try { await onDiscard(); } finally { submitting.current = false; setBusy(false); }
  };
  return <LiquidGlassModal isOpen={isOpen} onClose={() => { if (!submitting.current) onClose(); }}
    title={t('modals.menu.editDiscard')}>
    <div className="space-y-4 p-4" data-testid="discard-edit-confirmation">
      {moneyDeclared ? <>
        <p>{t('modals.menu.editDiscardMoneyGuidance')}</p>
        <button type="button" onClick={onClose}>{t('common.actions.close')}</button>
      </> : <>
        <p>{t('modals.menu.editDiscardQuestion')}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => void discard()} data-testid="discard-edit-no"
            className="min-h-11 rounded-lg border px-4 py-2 font-semibold">{t('modals.menu.editDiscardNo')}</button>
          <button type="button" disabled={busy} onClick={() => { if (!submitting.current) { declared.current = true; setMoneyDeclared(true); } }} data-testid="discard-edit-yes"
            className="min-h-11 rounded-lg border px-4 py-2">{t('modals.menu.editDiscardYes')}</button>
        </div>
      </>}
    </div>
  </LiquidGlassModal>;
}

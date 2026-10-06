import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import twintLogo from '../../../../../shared/payments/assets/twint-logo.png';
import { acquireCustomerTwintQr } from '../../services/CustomerDisplayQrOverlay';
import { currentTwintScope, type TwintManualConfiguration, type TwintConfirmationAction } from '../../services/TwintManualQrService';
import { formatCurrency } from '../../utils/format';
import { getBridge } from '../../../lib';
import { liveExternalPresentation } from '../../services/ExternalDisplayOwnership';

export function TwintManualQrTender({ configuration, amount, externalEnabled, onConfirm, onCancel }: {
  configuration: TwintManualConfiguration; amount: number; externalEnabled: boolean;
  onConfirm: (action: TwintConfirmationAction, idempotencyKey: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [error, setError] = useState(false);
  const original = useRef({ scope: configuration.scope, amount, key: crypto.randomUUID() });
  const active = useRef(true);
  const sending = useRef(false);
  const originalAction = useRef<TwintConfirmationAction | null>(null);
  const release = useRef<() => void>(() => {});
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (amount !== original.current.amount || configuration.scope !== original.current.scope) {
      active.current = false; release.current(); cancelRef.current(); return;
    }
    let disposed = false;
    active.current = true;
    void acquireCustomerTwintQr(configuration.scope, { qrImageData: configuration.qrImageData, amount, currency: 'CHF' }, externalEnabled).then(result => {
      if (disposed) { result.release(); return; }
      release.current = result.release;
      setExternal(result.external);
    });
    const checkScope = () => {
      if (currentTwintScope() !== original.current.scope) { active.current = false; release.current(); cancelRef.current(); }
    };
    const timer = setInterval(checkScope, 500);
    return () => { disposed = true; active.current = false; clearInterval(timer); release.current(); };
  }, [configuration.scope, configuration.qrImageData, amount, externalEnabled]);
  useEffect(() => {
    if (!external) return;
    let disposed = false; let reading = false;
    const timer = setInterval(() => {
      if (reading) return; reading = true;
      void getBridge().externalDisplay.getCapabilities().then(value => {
        if (!disposed && !liveExternalPresentation(value, 'customer_display')) setExternal(false);
      }).catch(() => { if (!disposed) setExternal(false); }).finally(() => { reading = false; });
    }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [external]);
  const confirm = async (action: TwintConfirmationAction) => {
    if (!active.current || sending.current || currentTwintScope() !== original.current.scope || amount !== original.current.amount) return;
    sending.current = true; setBusy(true); setError(false);
    try {
      // Fix review 06/10/2026: the configuration was read fresh, online, when
      // this QR was admitted (before the customer paid). Re-reading it here
      // could only refuse a receipt the customer already paid, and keep nothing.
      originalAction.current ??= action;
      const saved = await onConfirm(originalAction.current, original.current.key);
      if (saved) { active.current = false; release.current(); }
      else setError(true);
    } catch { if (active.current) setError(true); }
    finally { sending.current = false; if (active.current) setBusy(false); }
  };
  return <div className="flex flex-col items-center gap-4" data-testid="twint-qr-tender">
    <img src={twintLogo} alt="TWINT" className="h-14 rounded-lg" />
    <strong className="text-3xl">{formatCurrency(amount, 'CHF')}</strong>
    <p>{t('twintPayment.exactAmount', 'Scan the shop QR and enter this exact amount in TWINT.')}</p>
    <p className="font-semibold">{t('twintPayment.manualConfirmation', 'Check that the payment was received before confirming. There is no automatic payment notification.')}</p>
    {external && <p>{t('twintPayment.customerDisplay', 'The QR is shown on the customer display.')}</p>}
    <img src={configuration.qrImageData} alt={t('twintPayment.qrAlt', 'Official shop TWINT QR')} className="max-h-64 max-w-full bg-white p-3" onError={() => setExternal(false)} />
    {error && <p role="alert">{t('twintPayment.confirmNotSaved', 'The TWINT receipt is not saved yet. Do not collect again. A manager checks it before the POS is closed.')}</p>}
    <button type="button" disabled={busy} onClick={() => void confirm('confirm')} className="liquid-glass-modal-button">{t('twintPayment.confirm', 'Confirm payment received')}</button>
    <button type="button" disabled={busy} onClick={() => void confirm('skip')} className="liquid-glass-modal-button">{t('twintPayment.skip', 'Skip — confirm receipt')}</button>
    <button type="button" disabled={busy} onClick={onCancel}>{t('common.cancel', 'Cancel')}</button>
  </div>;
}

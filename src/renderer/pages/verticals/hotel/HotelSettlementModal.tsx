import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { PaymentModal } from '../../../components/modals/PaymentModal';
import { SplitPaymentModal } from '../../../components/modals/SplitPaymentModal';
import { LiquidGlassModal } from '../../../components/ui/pos-glass-components';
import { resolveActiveCashierShift } from '../../../utils/active-cashier';
import { getBridge } from '../../../../lib';
import { cancelHotelSettlement, cancelPreparedHotelSettlement, finishHotelSettlement, hotelErrorCode, prepareHotelSettlement, type HotelSettlement } from '../../../services/HotelSettlementService';

export function HotelSettlementModal({ folioId, amountCents, onClose, onCollected }: {
  folioId: string; amountCents?: number; onClose: () => void; onCollected: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [settlement, setSettlement] = useState<HotelSettlement | null>(null);
  const [failure, setFailure] = useState('');
  const [split, setSplit] = useState(false);
  const [initialTender, setInitialTender] = useState<'cash' | 'card' | undefined>();
  const [scope, setScope] = useState<{ organizationId: string; terminalId: string } | null>(null);
  const busy = useRef(false);
  const completed = useRef(false);
  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    setFailure('');
    try {
      const bridge = getBridge();
      const organizationId = await bridge.terminalConfig.getOrganizationId();
      const terminalId = await bridge.terminalConfig.getTerminalId();
      if (!organizationId || !terminalId) throw new Error('CONNECTION_REQUIRED');
      setScope({ organizationId, terminalId });
      const branchId=await bridge.terminalConfig.getBranchId();
      const shift=await resolveActiveCashierShift({branchId,terminalId,logContext:'HotelSettlement'});
      if (!shift?.id || !shift.staff_id) throw new Error('CONNECTION_REQUIRED');
      const next = await prepareHotelSettlement(folioId, amountCents, {staffId:shift.staff_id,staffShiftId:shift.id});
      setSettlement(next);
      if (next.outstanding <= 0) { completed.current = true; finishHotelSettlement(folioId); await onCollected(); }
    } catch (error) { setFailure(hotelErrorCode(error)); }
    finally { busy.current = false; }
  };
  useEffect(() => { void load(); }, [folioId]);
  const close = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (settlement && !completed.current) await cancelHotelSettlement(settlement);
      if (!settlement && !['NOTHING_TO_COLLECT','FOLIO_NOT_COLLECTIBLE','FOLIO_NOT_FOUND','FOLIO_CURRENCY_UNAVAILABLE','FOLIO_CURRENCY_MISMATCH'].includes(failure)) await cancelPreparedHotelSettlement(folioId);
      onClose();
    } catch (error) {
      // Keep partial/ambiguous receipts available for Resume, never cancel their order.
      const code = hotelErrorCode(error);
      toast.error(t(`hotelMoney.errors.${code}`));
      if (code === 'SETTLEMENT_HAS_PAYMENTS') onClose();
    } finally { busy.current = false; }
  };
  if (!settlement || failure) return <LiquidGlassModal isOpen onClose={() => { void close(); }} title={t('hotelMoney.collect')}>
    <div className="space-y-4 p-4"><p role={failure ? 'alert' : 'status'}>{failure ? t(`hotelMoney.errors.${failure}`) : t('common.loading')}</p>
      {failure && <button onClick={() => { void load(); }}>{t('common.retry')}</button>}</div>
  </LiquidGlassModal>;
  return <>
    <PaymentModal isOpen={!split} onClose={() => { void close(); }} orderTotal={settlement.outstanding} currency={settlement.currency}
      allowTips={false} allowTwint={false} onSplitPayment={() => { setInitialTender(undefined); setSplit(true); }}
      onPaymentComplete={data => { setInitialTender(data.method === 'card' ? 'card' : 'cash'); setSplit(true); return false; }} />
    {split && <SplitPaymentModal isOpen onClose={() => { if (!completed.current) void close(); }} orderId={settlement.orderId}
      orderTotal={settlement.total} items={settlement.items.map(item => ({ ...item, name: item.menu_item_name ?? item.name,
        totalPrice: Number(item.total_price), quantity: Number(item.quantity) }))} existingPayments={settlement.payments}
      collectionScope={scope} allowDiscounts={false} initialTender={initialTender} currency={settlement.currency}
      onSplitComplete={async result => { if (result.paymentStatus === 'paid') {
        completed.current = true; finishHotelSettlement(folioId); await onCollected();
      } }} />}
  </>;
}

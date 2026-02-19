import React, { useState, useEffect, useCallback } from 'react';
import { X, RotateCcw, XCircle, Banknote, CreditCard, Clock, AlertTriangle, ChevronDown, ChevronUp, Euro } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { formatCurrency } from '../../utils/format';

interface RefundVoidModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderTotal: number;
  onRefundComplete?: () => void;
}

interface PaymentRecord {
  id: string;
  order_id: string;
  method: string;
  amount: number;
  status: string;
  created_at: string;
  transaction_ref?: string;
}

interface PaymentBalance {
  originalAmount: number;
  totalRefunds: number;
  remaining: number;
}

interface Adjustment {
  id: string;
  payment_id: string;
  adjustment_type: 'refund' | 'void';
  amount: number;
  reason: string;
  staff_id?: string;
  created_at: string;
}

const RefundVoidModal: React.FC<RefundVoidModalProps> = ({
  isOpen,
  onClose,
  orderId,
  orderTotal,
  onRefundComplete,
}) => {
  const { t } = useTranslation();
  const { staff } = useShift();

  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, PaymentBalance>>({});
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Refund form state (per-payment)
  const [activeRefundId, setActiveRefundId] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');

  // Void confirm state
  const [activeVoidId, setActiveVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  // Adjustment history visibility
  const [showHistory, setShowHistory] = useState(false);

  const loadData = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const api = (window as any).electronAPI;

      // Load payments for this order
      const orderPayments = await api.getOrderPayments(orderId);
      const paymentList: PaymentRecord[] = Array.isArray(orderPayments) ? orderPayments : [];
      setPayments(paymentList);

      // Load balance for each completed payment
      const balanceMap: Record<string, PaymentBalance> = {};
      for (const p of paymentList) {
        if (p.status === 'completed') {
          try {
            const bal = await api.getPaymentBalance(p.id);
            if (bal) {
              balanceMap[p.id] = {
                originalAmount: bal.originalAmount ?? bal.original_amount ?? p.amount,
                totalRefunds: bal.totalRefunds ?? bal.total_refunds ?? 0,
                remaining: bal.remaining ?? (p.amount - (bal.totalRefunds ?? bal.total_refunds ?? 0)),
              };
            }
          } catch {
            balanceMap[p.id] = { originalAmount: p.amount, totalRefunds: 0, remaining: p.amount };
          }
        }
      }
      setBalances(balanceMap);

      // Load adjustment history
      try {
        const adj = await api.listOrderAdjustments(orderId);
        setAdjustments(Array.isArray(adj) ? adj : []);
      } catch {
        setAdjustments([]);
      }
    } catch (err) {
      console.error('Failed to load refund data:', err);
      toast.error(t('modals.refund.loadFailed', { defaultValue: 'Failed to load payment data' }));
    } finally {
      setLoading(false);
    }
  }, [orderId, t]);

  useEffect(() => {
    if (isOpen) {
      loadData();
      // Reset form state on open
      setActiveRefundId(null);
      setActiveVoidId(null);
      setRefundAmount('');
      setRefundReason('');
      setVoidReason('');
      setShowHistory(false);
    }
  }, [isOpen, loadData]);

  const handleRefund = async (paymentId: string) => {
    const amount = parseFloat(refundAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error(t('modals.refund.invalidAmount', { defaultValue: 'Enter a valid refund amount' }));
      return;
    }
    if (!refundReason.trim()) {
      toast.error(t('modals.refund.reasonRequired', { defaultValue: 'A reason is required' }));
      return;
    }

    const balance = balances[paymentId];
    if (balance && amount > balance.remaining + 0.01) {
      toast.error(
        t('modals.refund.exceedsBalance', {
          defaultValue: 'Amount exceeds remaining balance',
        })
      );
      return;
    }

    setProcessing(true);
    try {
      const api = (window as any).electronAPI;
      const result = await api.refundPayment({
        paymentId,
        amount,
        reason: refundReason.trim(),
        staffId: staff?.staffId,
        orderId,
      });

      if (result?.success !== false && !result?.error) {
        toast.success(
          t('modals.refund.refundSuccess', { defaultValue: 'Refund recorded successfully' })
        );
        setActiveRefundId(null);
        setRefundAmount('');
        setRefundReason('');
        await loadData();
        onRefundComplete?.();
      } else {
        toast.error(result?.error || t('modals.refund.refundFailed', { defaultValue: 'Refund failed' }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('modals.refund.refundFailed', { defaultValue: 'Refund failed' }));
    } finally {
      setProcessing(false);
    }
  };

  const handleVoid = async (paymentId: string) => {
    if (!voidReason.trim()) {
      toast.error(t('modals.refund.reasonRequired', { defaultValue: 'A reason is required' }));
      return;
    }

    setProcessing(true);
    try {
      const api = (window as any).electronAPI;
      const result = await api.voidPayment(paymentId, voidReason.trim(), staff?.staffId);

      if (result?.success !== false && !result?.error) {
        toast.success(
          t('modals.refund.voidSuccess', { defaultValue: 'Payment voided successfully' })
        );
        setActiveVoidId(null);
        setVoidReason('');
        await loadData();
        onRefundComplete?.();
      } else {
        toast.error(result?.error || t('modals.refund.voidFailed', { defaultValue: 'Void failed' }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('modals.refund.voidFailed', { defaultValue: 'Void failed' }));
    } finally {
      setProcessing(false);
    }
  };

  const getMethodIcon = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'cash': return <Banknote className="w-5 h-5 text-green-400" />;
      case 'card': return <CreditCard className="w-5 h-5 text-blue-400" />;
      default: return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'completed':
        return <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">Completed</span>;
      case 'voided':
        return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">Voided</span>;
      case 'refunded':
        return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Refunded</span>;
      default:
        return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-500/30">{status}</span>;
    }
  };

  const completedPayments = payments.filter(p => p.status === 'completed');
  const nonCompletedPayments = payments.filter(p => p.status !== 'completed');

  const modalHeader = (
    <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1">
          <h2 className="text-2xl font-bold liquid-glass-modal-text">
            {t('modals.refund.title', { defaultValue: 'Void / Refund' })}
          </h2>
          <p className="text-sm liquid-glass-modal-text-muted mt-1">
            {t('modals.refund.subtitle', { defaultValue: 'Manage payment adjustments' })}
            {' '}&middot;{' '}
            {t('modals.refund.orderTotal', { defaultValue: 'Order total' })}: {formatCurrency(orderTotal)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="liquid-glass-modal-button p-2 min-h-0 min-w-0 shrink-0"
          aria-label={t('common.actions.close')}
        >
          <X className="w-6 h-6" />
        </button>
      </div>
    </div>
  );

  const modalFooter = (
    <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border bg-white/5 dark:bg-black/20">
      <button
        onClick={onClose}
        className="w-full liquid-glass-modal-button bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border-blue-500/30 gap-2"
      >
        {t('common.actions.close', { defaultValue: 'Close' })}
      </button>
    </div>
  );

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      className="max-w-3xl"
      contentClassName="p-0 overflow-hidden"
      ariaLabel={t('modals.refund.title', { defaultValue: 'Void / Refund' })}
      header={modalHeader}
      footer={modalFooter}
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
          </div>
        ) : payments.length === 0 ? (
          <div className="text-center py-12">
            <CreditCard className="w-12 h-12 mx-auto mb-3 liquid-glass-modal-text-muted opacity-50" />
            <p className="text-sm liquid-glass-modal-text-muted">
              {t('modals.refund.noPayments', { defaultValue: 'No payments found for this order' })}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Active (completed) payments */}
            {completedPayments.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                  {t('modals.refund.activePayments', { defaultValue: 'Active Payments' })}
                </h3>
                {completedPayments.map((payment) => {
                  const balance = balances[payment.id];
                  const isRefunding = activeRefundId === payment.id;
                  const isVoiding = activeVoidId === payment.id;

                  return (
                    <div
                      key={payment.id}
                      className="liquid-glass-modal-card space-y-3"
                    >
                      {/* Payment row */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {getMethodIcon(payment.method)}
                          <div>
                            <div className="font-semibold liquid-glass-modal-text capitalize">
                              {payment.method || 'Unknown'}
                            </div>
                            <div className="text-xs liquid-glass-modal-text-muted">
                              {new Date(payment.created_at).toLocaleString()}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold liquid-glass-modal-text">
                            {formatCurrency(payment.amount)}
                          </div>
                          {balance && balance.totalRefunds > 0 && (
                            <div className="text-xs text-yellow-400">
                              {t('modals.refund.refunded', { defaultValue: 'Refunded' })}: {formatCurrency(balance.totalRefunds)}
                              {' '}&middot;{' '}
                              {t('modals.refund.remaining', { defaultValue: 'Remaining' })}: {formatCurrency(balance.remaining)}
                            </div>
                          )}
                          {getStatusBadge(payment.status)}
                        </div>
                      </div>

                      {/* Action buttons */}
                      {!isRefunding && !isVoiding && (
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => {
                              setActiveVoidId(payment.id);
                              setActiveRefundId(null);
                              setVoidReason('');
                            }}
                            disabled={processing}
                            className="flex-1 liquid-glass-modal-button bg-red-600/10 hover:bg-red-600/20 text-red-400 border-red-500/20 gap-2 text-sm py-2 disabled:opacity-50"
                          >
                            <XCircle className="w-4 h-4" />
                            {t('modals.refund.voidButton', { defaultValue: 'Void' })}
                          </button>
                          <button
                            onClick={() => {
                              setActiveRefundId(payment.id);
                              setActiveVoidId(null);
                              const bal = balances[payment.id];
                              setRefundAmount(bal ? bal.remaining.toFixed(2) : payment.amount.toFixed(2));
                              setRefundReason('');
                            }}
                            disabled={processing || (balance && balance.remaining <= 0)}
                            className="flex-1 liquid-glass-modal-button bg-orange-600/10 hover:bg-orange-600/20 text-orange-400 border-orange-500/20 gap-2 text-sm py-2 disabled:opacity-50"
                          >
                            <RotateCcw className="w-4 h-4" />
                            {t('modals.refund.refundButton', { defaultValue: 'Refund' })}
                          </button>
                        </div>
                      )}

                      {/* Void form */}
                      {isVoiding && (
                        <div className="space-y-3 pt-2 border-t border-red-500/20 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="flex items-center gap-2 text-sm text-red-400">
                            <AlertTriangle className="w-4 h-4" />
                            <span className="font-medium">
                              {t('modals.refund.voidWarning', {
                                defaultValue: 'This will fully reverse the payment of',
                              })}{' '}
                              {formatCurrency(payment.amount)}
                            </span>
                          </div>
                          <textarea
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value)}
                            placeholder={t('modals.refund.reasonPlaceholder', { defaultValue: 'Enter reason for void...' })}
                            rows={2}
                            className="w-full p-3 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-red-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted resize-none"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleVoid(payment.id)}
                              disabled={processing || !voidReason.trim()}
                              className="flex-1 liquid-glass-modal-button bg-red-600/20 hover:bg-red-600/30 text-red-400 border-red-500/30 gap-2 disabled:opacity-50"
                            >
                              <XCircle className="w-4 h-4" />
                              {processing
                                ? t('common.loading', { defaultValue: 'Processing...' })
                                : t('modals.refund.confirmVoid', { defaultValue: 'Confirm Void' })}
                            </button>
                            <button
                              onClick={() => { setActiveVoidId(null); setVoidReason(''); }}
                              disabled={processing}
                              className="liquid-glass-modal-button"
                            >
                              {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Refund form */}
                      {isRefunding && (
                        <div className="space-y-3 pt-2 border-t border-orange-500/20 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div>
                            <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
                              <Euro className="w-4 h-4 inline mr-1" />
                              {t('modals.refund.refundAmount', { defaultValue: 'Refund Amount' })}
                            </label>
                            <div className="relative">
                              <input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max={balance?.remaining ?? payment.amount}
                                value={refundAmount}
                                onChange={(e) => setRefundAmount(e.target.value)}
                                placeholder="0.00"
                                className="w-full p-3 pl-10 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-orange-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted"
                              />
                              <Euro className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 liquid-glass-modal-text-muted" />
                            </div>
                            {balance && (
                              <p className="text-xs liquid-glass-modal-text-muted mt-1">
                                {t('modals.refund.maxRefund', { defaultValue: 'Max refundable' })}: {formatCurrency(balance.remaining)}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
                              {t('modals.refund.reason', { defaultValue: 'Reason' })} *
                            </label>
                            <textarea
                              value={refundReason}
                              onChange={(e) => setRefundReason(e.target.value)}
                              placeholder={t('modals.refund.reasonPlaceholder', { defaultValue: 'Enter reason for refund...' })}
                              rows={2}
                              className="w-full p-3 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-orange-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted resize-none"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRefund(payment.id)}
                              disabled={processing || !refundReason.trim() || !refundAmount || parseFloat(refundAmount) <= 0}
                              className="flex-1 liquid-glass-modal-button bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border-orange-500/30 gap-2 disabled:opacity-50"
                            >
                              <RotateCcw className="w-4 h-4" />
                              {processing
                                ? t('common.loading', { defaultValue: 'Processing...' })
                                : t('modals.refund.confirmRefund', { defaultValue: 'Confirm Refund' })}
                            </button>
                            <button
                              onClick={() => { setActiveRefundId(null); setRefundAmount(''); setRefundReason(''); }}
                              disabled={processing}
                              className="liquid-glass-modal-button"
                            >
                              {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Non-active (voided/refunded) payments */}
            {nonCompletedPayments.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                  {t('modals.refund.closedPayments', { defaultValue: 'Voided / Refunded' })}
                </h3>
                {nonCompletedPayments.map((payment) => (
                  <div
                    key={payment.id}
                    className="liquid-glass-modal-card opacity-60"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {getMethodIcon(payment.method)}
                        <div>
                          <div className="font-semibold liquid-glass-modal-text capitalize">
                            {payment.method || 'Unknown'}
                          </div>
                          <div className="text-xs liquid-glass-modal-text-muted">
                            {new Date(payment.created_at).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold liquid-glass-modal-text line-through">
                          {formatCurrency(payment.amount)}
                        </div>
                        {getStatusBadge(payment.status)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Adjustment History */}
            {adjustments.length > 0 && (
              <div className="space-y-3">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted hover:text-white transition-colors"
                >
                  {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  {t('modals.refund.adjustmentHistory', { defaultValue: 'Adjustment History' })}
                  <span className="text-xs liquid-glass-modal-badge ml-1">
                    {adjustments.length}
                  </span>
                </button>
                {showHistory && (
                  <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                    {adjustments.map((adj) => (
                      <div
                        key={adj.id}
                        className={`p-3 rounded-lg border ${
                          adj.adjustment_type === 'void'
                            ? 'bg-red-500/5 border-red-500/20'
                            : 'bg-orange-500/5 border-orange-500/20'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {adj.adjustment_type === 'void' ? (
                              <XCircle className="w-4 h-4 text-red-400" />
                            ) : (
                              <RotateCcw className="w-4 h-4 text-orange-400" />
                            )}
                            <span className={`text-sm font-medium ${
                              adj.adjustment_type === 'void' ? 'text-red-400' : 'text-orange-400'
                            }`}>
                              {adj.adjustment_type === 'void'
                                ? t('modals.refund.voidLabel', { defaultValue: 'VOID' })
                                : t('modals.refund.refundLabel', { defaultValue: 'REFUND' })}
                            </span>
                          </div>
                          <span className={`font-bold ${
                            adj.adjustment_type === 'void' ? 'text-red-400' : 'text-orange-400'
                          }`}>
                            -{formatCurrency(adj.amount)}
                          </span>
                        </div>
                        <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                          {adj.reason}
                        </div>
                        <div className="mt-1 text-xs liquid-glass-modal-text-muted opacity-60">
                          {new Date(adj.created_at).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </LiquidGlassModal>
  );
};

export default RefundVoidModal;

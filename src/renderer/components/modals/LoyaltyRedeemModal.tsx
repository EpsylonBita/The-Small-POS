import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { getStoreCurrency } from '../../utils/store-currency';
import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useCashierPortalProps } from '../../contexts/cashier-gate-context';
import { X, Gift, Award, Star, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';

interface LoyaltyRedeemModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when redemption succeeds, with the discount value in the store currency */
  onRedeem: (discountValue: number, pointsRedeemed: number) => void;
  customerId: string;
  customerName?: string;
  pointsBalance: number;
  tier?: string;
  /** Store currency value per point */
  redemptionRate: number;
  /** Minimum points required to redeem */
  minRedemptionPoints: number;
  /** Optional cap from the current cart value so points cannot exceed the payable subtotal. */
  maxRedeemablePoints?: number;
}

export function LoyaltyRedeemModal({
  isOpen,
  onClose,
  onRedeem,
  customerName,
  pointsBalance,
  tier,
  redemptionRate,
  minRedemptionPoints,
  maxRedeemablePoints,
}: LoyaltyRedeemModalProps) {
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const cashierPortalProps = useCashierPortalProps();
  const { t } = useTranslation();

  const [pointsToRedeem, setPointsToRedeem] = useState(minRedemptionPoints);
  const [amountInput, setAmountInput] = useState('');

  const effectiveMaxPoints = Math.max(
    0,
    Math.min(pointsBalance, maxRedeemablePoints ?? pointsBalance),
  );
  const maxRedeemableAmount = useMemo(
    () => Number((effectiveMaxPoints * redemptionRate).toFixed(2)),
    [effectiveMaxPoints, redemptionRate],
  );
  const minRedeemableAmount = useMemo(
    () => Number((minRedemptionPoints * redemptionRate).toFixed(2)),
    [minRedemptionPoints, redemptionRate],
  );

  const formatAmountInput = (amount: number) => {
    const safeAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    return safeAmount.toFixed(2);
  };

  const parseAmountInput = (value: string) => {
    const normalized = value.replace(/[^\d.,]/g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const clampPoints = (points: number) => {
    const safePoints = Number.isFinite(points) ? Math.trunc(points) : 0;
    return Math.max(0, Math.min(safePoints, effectiveMaxPoints));
  };

  const setRedeemPoints = (points: number) => {
    const clampedPoints = clampPoints(points);
    setPointsToRedeem(clampedPoints);
    setAmountInput(formatAmountInput(clampedPoints * redemptionRate));
  };

  React.useEffect(() => {
    if (!isOpen) return;
    setRedeemPoints(effectiveMaxPoints);
  }, [effectiveMaxPoints, isOpen, minRedemptionPoints, redemptionRate]);

  const discountPreview = useMemo(
    () => Number((pointsToRedeem * redemptionRate).toFixed(2)),
    [pointsToRedeem, redemptionRate],
  );

  const canRedeem =
    effectiveMaxPoints >= minRedemptionPoints &&
    pointsToRedeem >= minRedemptionPoints &&
    pointsToRedeem <= effectiveMaxPoints;

  const handleRedeem = () => {
    if (!canRedeem) return;
    onRedeem(discountPreview, pointsToRedeem);
    onClose();
  };

  const adjustPoints = (delta: number) => {
    const next = pointsToRedeem + delta;
    const nextPoints = next < minRedemptionPoints
      ? minRedemptionPoints
      : Math.min(next, effectiveMaxPoints);
    setRedeemPoints(nextPoints);
  };

  const handlePointsChange = (value: string) => {
    const parsedPoints = Number.parseInt(value, 10);
    setRedeemPoints(Number.isNaN(parsedPoints) ? 0 : parsedPoints);
  };

  const handleAmountChange = (value: string) => {
    setAmountInput(value);
    const requestedAmount = Math.min(parseAmountInput(value), maxRedeemableAmount);
    const nextPoints = redemptionRate > 0
      ? Math.floor((requestedAmount + 0.000001) / redemptionRate)
      : 0;
    setPointsToRedeem(clampPoints(nextPoints));
  };

  const normalizeAmountInput = () => {
    setAmountInput(formatAmountInput(discountPreview));
  };

  const getTierColor = (t: string | undefined) => {
    switch (t?.toLowerCase()) {
      case 'platinum': return 'text-yellow-700 dark:text-yellow-200';
      case 'gold': return 'text-yellow-700 dark:text-yellow-200';
      case 'silver': return 'liquid-glass-modal-text-muted';
      default: return 'text-amber-700 dark:text-amber-200';
    }
  };

  if (!isOpen) return null;

  const glassPanelClass = 'pos-glass-form-card';
  const glassSubtlePanelClass = 'pos-glass-form-card px-3! py-2! text-xs liquid-glass-modal-text-muted';
  const glassIconButtonClass = 'pos-glass-field flex h-11 w-11 shrink-0 items-center justify-center p-2 disabled:pointer-events-none disabled:opacity-30';
  const glassQuickButtonClass = (active: boolean) =>
    `min-h-touch flex-1 rounded-2xl border py-1.5 text-xs font-semibold transition-[transform,background-color,border-color] duration-150 ${
      active
        ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]'
        : 'pos-glass-field'
    }`;

  const modal = (
    <div {...cashierPortalProps} className="fixed inset-0 z-2147483000 flex items-center justify-center p-4">
      <div className="liquid-glass-modal-backdrop fixed! inset-0!" aria-hidden="true" />
      <div className="liquid-glass-modal-shell relative w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="liquid-glass-modal-header pos-glass-header--plain px-5! py-4!">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center liquid-glass-modal-text-muted">
              <Gift className="w-5 h-5" />
            </div>
            <h2 className="liquid-glass-modal-title text-lg!">
              {t('loyalty.redeemTitle', 'Redeem Loyalty Points')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="liquid-glass-modal-close"
            aria-label={t('common.actions.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {/* Customer Info */}
          <div className={glassPanelClass}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium liquid-glass-modal-text">{customerName || t('loyalty.unknownCustomer', 'Unknown')}</span>
            {tier && (
              <span
                className={`flex items-center gap-1 rounded-2xl border liquid-glass-modal-border px-2 py-0.5 text-xs font-medium ${getTierColor(tier)}`}
              >
                <Star className="w-3 h-3 fill-current" />
                {tier}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="block text-xs liquid-glass-modal-text-muted">
                {t('loyalty.availableBalance', 'Available balance')}
              </span>
              <span className="font-bold liquid-glass-modal-text">
                {pointsBalance.toLocaleString()} {t('loyalty.pointsShort', 'pts')}
              </span>
            </div>
            <div>
              <span className="block text-xs liquid-glass-modal-text-muted">
                {t('loyalty.maxRedeemable', 'Max redeemable')}
              </span>
              <span className="font-bold liquid-glass-modal-text">
                {formatCurrency(maxRedeemableAmount)}
              </span>
            </div>
          </div>
          <div className={`mt-3 ${glassSubtlePanelClass}`}>
            {t('loyalty.manualRedeemHint', 'Enter the amount or points to apply to this cart.')}
          </div>
        </div>

        {/* Points Selector */}
        <div className="pos-glass-form-card">
          <label className="text-xs font-semibold mb-2 block liquid-glass-modal-text-muted">
            {t('loyalty.pointsToRedeem', 'Points to redeem')}
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => adjustPoints(-50)}
              disabled={pointsToRedeem <= minRedemptionPoints}
              className={glassIconButtonClass}
            >
              <Minus className="w-5 h-5" />
            </button>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pointsToRedeem}
              onChange={(e) => handlePointsChange(e.target.value)}
              className="liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 flex-1 text-center text-2xl font-bold"
            />
            <button
              type="button"
              onClick={() => adjustPoints(50)}
              disabled={pointsToRedeem >= effectiveMaxPoints}
              className={glassIconButtonClass}
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {/* Quick select buttons */}
          <div className="flex gap-2 mt-2">
            {[minRedemptionPoints, Math.floor(effectiveMaxPoints * 0.5), effectiveMaxPoints]
              .filter((v, i, a) => v >= minRedemptionPoints && v <= effectiveMaxPoints && a.indexOf(v) === i)
              .map((pts) => (
                <button
                  type="button"
                  key={pts}
                  onClick={() => setRedeemPoints(pts)}
                  className={glassQuickButtonClass(pointsToRedeem === pts)}
                >
                  {pts === effectiveMaxPoints ? t('common.all', 'All') : pts.toLocaleString()}
                </button>
              ))}
          </div>
        </div>

        {/* Cash Amount Selector */}
        <div className="pos-glass-form-card">
          <label className="text-xs font-semibold mb-2 block liquid-glass-modal-text-muted">
            {t('loyalty.amountToRedeem', 'Discount amount')}
          </label>
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-3 z-10 font-semibold liquid-glass-modal-text-muted">{getStoreCurrency() ?? '—'}</span>
            <CentsMoneyInput
              aria-label={t('loyalty.amountToRedeem', 'Discount amount')}
              value={amountInput}
              onValueChange={handleAmountChange}
              onBlur={normalizeAmountInput}
              className="liquid-glass-modal-input pos-glass-field min-h-touch w-full pl-14! text-2xl font-bold"
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs liquid-glass-modal-text-muted">
            <span>
              {t('loyalty.minimumRedeemable', {
                points: minRedemptionPoints,
                amount: formatCurrency(minRedeemableAmount),
                defaultValue: 'Minimum {{points}} pts / {{amount}}',
              })}
            </span>
            <span>
              {pointsToRedeem.toLocaleString()} {t('loyalty.pointsShort', 'pts')}
            </span>
          </div>
        </div>

        {/* Discount Preview */}
        <div className="pos-glass-form-card">
          <div className="flex items-center justify-between">
            <span className="text-sm liquid-glass-modal-text-muted">
              {t('loyalty.discountPreview', { amount: formatCurrency(discountPreview) })}
            </span>
            <span className="text-xl font-bold liquid-glass-modal-text">{formatCurrency(discountPreview)}</span>
          </div>
        </div>

        {/* Validation message */}
        <AnimatePresence initial={false}>{pointsToRedeem < minRedemptionPoints && (
          <motion.p {...revealMotion} className="text-xs text-red-700 dark:text-red-400 mb-4">
            {t('loyalty.insufficientPoints', { min: minRedemptionPoints })}
          </motion.p>
        )}</AnimatePresence>

        {/* Actions */}
        <div className="flex gap-3 px-6 pb-5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="liquid-glass-modal-button flex-1"
          >
            {t('loyalty.redeemCancel', 'Skip')}
          </button>
          <button
            type="button"
            onClick={handleRedeem}
            disabled={!canRedeem}
            className="liquid-glass-modal-button pos-modal-primary flex-1 shadow-lg transition-transform duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Award className="w-4 h-4" />
            {t('loyalty.redeemConfirm', {
              discount: formatCurrency(discountPreview),
            })}
          </button>
        </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
}

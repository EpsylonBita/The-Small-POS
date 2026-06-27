import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Gift, Award, Star, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';

interface LoyaltyRedeemModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when redemption succeeds, with the discount value in EUR */
  onRedeem: (discountValue: number, pointsRedeemed: number) => void;
  customerId: string;
  customerName?: string;
  pointsBalance: number;
  tier?: string;
  /** EUR value per point (e.g. 0.01 = 1 point = €0.01) */
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
      case 'platinum': return 'bg-yellow-400/20 text-yellow-700 dark:text-yellow-200';
      case 'gold': return 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-200';
      case 'silver': return 'bg-gray-400/20 text-gray-600 dark:text-gray-200';
      default: return 'bg-amber-700/20 text-amber-700 dark:text-amber-200';
    }
  };

  if (!isOpen) return null;

  const glassPanelClass = 'rounded-2xl border liquid-glass-modal-border bg-white/10 p-4 backdrop-blur-xl dark:bg-black/20';
  const glassSubtlePanelClass = 'rounded-2xl border liquid-glass-modal-border bg-white/10 px-3 py-2 text-xs liquid-glass-modal-text-muted backdrop-blur-xl dark:bg-black/20';
  const glassIconButtonClass = 'liquid-glass-modal-button !min-h-0 !p-2 transition-transform duration-150 active:scale-95 disabled:pointer-events-none disabled:opacity-30';
  const glassQuickButtonClass = (active: boolean) =>
    `flex-1 rounded-2xl border py-1.5 text-xs font-semibold transition-[transform,background-color,border-color] duration-150 active:scale-[0.98] ${
      active
        ? 'border-yellow-400/70 bg-yellow-400/25 text-yellow-900 shadow-sm dark:bg-yellow-400/20 dark:text-yellow-100'
        : 'liquid-glass-modal-border liquid-glass-modal-text-muted bg-white/10 dark:bg-black/20'
    }`;

  const modal = (
    <div className="fixed inset-0 z-[2147483000] flex items-center justify-center p-4">
      <div className="liquid-glass-modal-backdrop !fixed !inset-0" aria-hidden="true" />
      <div className="liquid-glass-modal-shell relative w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="liquid-glass-modal-header !px-5 !py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-yellow-300/50 bg-yellow-400 text-black shadow-lg shadow-yellow-500/20">
              <Gift className="w-5 h-5" />
            </div>
            <h2 className="liquid-glass-modal-title !text-lg">
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

        <div className="space-y-4 p-5">
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
              <span className="font-bold text-yellow-700 dark:text-yellow-300">
                {pointsBalance.toLocaleString()} {t('loyalty.pointsShort', 'pts')}
              </span>
            </div>
            <div>
              <span className="block text-xs liquid-glass-modal-text-muted">
                {t('loyalty.maxRedeemable', 'Max redeemable')}
              </span>
              <span className="font-bold text-green-500">
                {formatCurrency(maxRedeemableAmount)}
              </span>
            </div>
          </div>
          <div className={`mt-3 ${glassSubtlePanelClass}`}>
            {t('loyalty.manualRedeemHint', 'Enter the amount or points to apply to this cart.')}
          </div>
        </div>

        {/* Points Selector */}
        <div>
          <label className="text-sm mb-2 block liquid-glass-modal-text-muted">
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
              className="liquid-glass-modal-input flex-1 text-center text-2xl font-bold"
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
        <div>
          <label className="text-sm mb-2 block liquid-glass-modal-text-muted">
            {t('loyalty.amountToRedeem', 'Discount amount')}
          </label>
          <div className="liquid-glass-modal-input flex items-center px-3 py-2">
            <span className="mr-2 font-semibold opacity-70">€</span>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => handleAmountChange(e.target.value)}
              onBlur={normalizeAmountInput}
              className="w-full bg-transparent text-2xl font-bold outline-none liquid-glass-modal-text"
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
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/15 p-4 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm text-emerald-300">
              {t('loyalty.discountPreview', { amount: formatCurrency(discountPreview) })}
            </span>
            <span className="text-xl font-bold text-emerald-400">{formatCurrency(discountPreview)}</span>
          </div>
        </div>

        {/* Validation message */}
        {pointsToRedeem < minRedemptionPoints && (
          <p className="text-xs text-red-400 mb-4">
            {t('loyalty.insufficientPoints', { min: minRedemptionPoints })}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3">
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
            className="liquid-glass-modal-button flex-1 border-green-500/50 bg-green-600 text-white shadow-lg shadow-green-600/20 transition-transform duration-150 active:scale-[0.98] active:bg-green-700 disabled:pointer-events-none disabled:opacity-50 flex items-center justify-center gap-2"
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

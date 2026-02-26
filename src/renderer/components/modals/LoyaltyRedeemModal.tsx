import React, { useState, useMemo } from 'react';
import { X, Gift, Award, Star, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { getBridge } from '../../../lib';
import { useTheme } from '../../contexts/theme-context';

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
}

export function LoyaltyRedeemModal({
  isOpen,
  onClose,
  onRedeem,
  customerId,
  customerName,
  pointsBalance,
  tier,
  redemptionRate,
  minRedemptionPoints,
}: LoyaltyRedeemModalProps) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [pointsToRedeem, setPointsToRedeem] = useState(minRedemptionPoints);
  const [redeeming, setRedeeming] = useState(false);

  const discountPreview = useMemo(
    () => pointsToRedeem * redemptionRate,
    [pointsToRedeem, redemptionRate],
  );

  const canRedeem = pointsToRedeem >= minRedemptionPoints && pointsToRedeem <= pointsBalance;

  const handleRedeem = async () => {
    if (!canRedeem || redeeming) return;
    setRedeeming(true);
    try {
      const result: any = await bridge.loyalty.redeemPoints({
        customerId,
        points: pointsToRedeem,
      });
      if (result?.success) {
        const discount = (result.discountValue ?? pointsToRedeem * redemptionRate) as number;
        toast.success(
          t('loyalty.redeemSuccess', {
            points: pointsToRedeem,
            discount: `€${discount.toFixed(2)}`,
          }),
        );
        onRedeem(discount, pointsToRedeem);
        onClose();
      } else {
        toast.error(result?.error || 'Redemption failed');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Redemption failed');
    } finally {
      setRedeeming(false);
    }
  };

  const adjustPoints = (delta: number) => {
    setPointsToRedeem((prev) => {
      const next = prev + delta;
      if (next < minRedemptionPoints) return minRedemptionPoints;
      if (next > pointsBalance) return pointsBalance;
      return next;
    });
  };

  const getTierColor = (t: string | undefined) => {
    switch (t?.toLowerCase()) {
      case 'platinum': return 'text-purple-500 bg-purple-500/20';
      case 'gold': return 'text-yellow-500 bg-yellow-500/20';
      case 'silver': return 'text-gray-400 bg-gray-400/20';
      default: return 'text-amber-700 bg-amber-700/20';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className={`w-full max-w-md rounded-2xl p-6 shadow-xl ${
          isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-purple-500/20">
              <Gift className="w-5 h-5 text-purple-500" />
            </div>
            <h2 className="text-lg font-bold">
              {t('loyalty.redeemTitle', 'Redeem Loyalty Points')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Customer Info */}
        <div
          className={`p-4 rounded-xl mb-4 ${
            isDark ? 'bg-gray-700/50' : 'bg-gray-50'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium">{customerName || t('loyalty.unknownCustomer', 'Unknown')}</span>
            {tier && (
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded flex items-center gap-1 ${getTierColor(tier)}`}
              >
                <Star className="w-3 h-3 fill-current" />
                {tier}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
              {t('loyalty.balance', 'Balance')}
            </span>
            <span className="font-bold text-purple-500">{pointsBalance.toLocaleString()} pts</span>
          </div>
        </div>

        {/* Points Selector */}
        <div className="mb-4">
          <label className={`text-sm mb-2 block ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('loyalty.pointsToRedeem', 'Points to redeem')}
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => adjustPoints(-50)}
              disabled={pointsToRedeem <= minRedemptionPoints}
              className={`p-2 rounded-lg ${
                isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
              } disabled:opacity-30`}
            >
              <Minus className="w-5 h-5" />
            </button>
            <input
              type="number"
              value={pointsToRedeem}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 0) {
                  setPointsToRedeem(Math.min(val, pointsBalance));
                }
              }}
              className={`flex-1 text-center text-2xl font-bold py-2 rounded-lg ${
                isDark ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-900'
              } outline-none`}
            />
            <button
              onClick={() => adjustPoints(50)}
              disabled={pointsToRedeem >= pointsBalance}
              className={`p-2 rounded-lg ${
                isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
              } disabled:opacity-30`}
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {/* Quick select buttons */}
          <div className="flex gap-2 mt-2">
            {[minRedemptionPoints, Math.floor(pointsBalance * 0.5), pointsBalance]
              .filter((v, i, a) => v >= minRedemptionPoints && v <= pointsBalance && a.indexOf(v) === i)
              .map((pts) => (
                <button
                  key={pts}
                  onClick={() => setPointsToRedeem(pts)}
                  className={`flex-1 py-1 text-xs rounded-lg font-medium ${
                    pointsToRedeem === pts
                      ? 'bg-purple-500 text-white'
                      : isDark
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {pts === pointsBalance ? 'All' : pts.toLocaleString()}
                </button>
              ))}
          </div>
        </div>

        {/* Discount Preview */}
        <div
          className={`p-4 rounded-xl mb-6 border ${
            isDark ? 'bg-green-900/20 border-green-500/30' : 'bg-green-50 border-green-200'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className={`text-sm ${isDark ? 'text-green-400' : 'text-green-700'}`}>
              {t('loyalty.discountPreview', { amount: `€${discountPreview.toFixed(2)}` })}
            </span>
            <span className="text-xl font-bold text-green-500">€{discountPreview.toFixed(2)}</span>
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
            onClick={onClose}
            className={`flex-1 py-3 rounded-xl font-medium ${
              isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
            }`}
          >
            {t('loyalty.redeemCancel', 'Skip')}
          </button>
          <button
            onClick={handleRedeem}
            disabled={!canRedeem || redeeming}
            className="flex-1 py-3 rounded-xl font-medium bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Award className="w-4 h-4" />
            {redeeming
              ? '...'
              : t('loyalty.redeemConfirm', {
                  discount: `€${discountPreview.toFixed(2)}`,
                })}
          </button>
        </div>
      </div>
    </div>
  );
}

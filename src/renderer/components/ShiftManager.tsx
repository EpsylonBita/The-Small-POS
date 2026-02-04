import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { useShift } from '../contexts/shift-context';
import { StaffShiftModal } from './modals/StaffShiftModal';
import { toast } from 'react-hot-toast';
import { useI18n } from '../contexts/i18n-context';
import { useFeatures } from '../hooks/useFeatures';
import { formatCurrency } from '../utils/format';

export interface ShiftManagerRef {
  openCheckout: () => void;
  openCheckin: () => void;
}

export const ShiftManager = forwardRef<ShiftManagerRef>((props, ref) => {
  const { t } = useI18n();
  const { staff, activeShift, isShiftActive } = useShift();
  const { isFeatureEnabled, isMobileWaiter } = useFeatures();
  const hasCashDrawer = isFeatureEnabled('cashDrawer');
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftModalMode, setShiftModalMode] = useState<'checkin' | 'checkout'>('checkin');
  const [hasPromptedCheckIn, setHasPromptedCheckIn] = useState(false);

  // Auto-prompt check-in when logged in without active shift
  useEffect(() => {
    if (staff && !isShiftActive && !hasPromptedCheckIn) {
      // Small delay to ensure UI is ready
      const timer = setTimeout(() => {
        setShiftModalMode('checkin');
        setShowShiftModal(true);
        setHasPromptedCheckIn(true);
      }, 500);

      return () => clearTimeout(timer);
    }

    // Reset prompt flag when staff logs out
    if (!staff) {
      setHasPromptedCheckIn(false);
    }
  }, [staff, isShiftActive, hasPromptedCheckIn]);

  // Expose checkout method via ref
  useImperativeHandle(ref, () => ({
    openCheckout: () => {
      if (isShiftActive) {
        setShiftModalMode('checkout');
        setShowShiftModal(true);
      } else {
        toast.error(t('shiftManager.noActiveShift'));
      }
    },
    openCheckin: () => {
      setShiftModalMode('checkin');
      setShowShiftModal(true);
    }
  }));

  const handleShiftStarted = () => {
    toast.success(t('shiftManager.shiftStarted'));
    setShowShiftModal(false);
  };

  const handleShiftEnded = (variance?: number) => {
    if (variance !== undefined) {
      const amount = formatCurrency(Math.abs(variance));
      const varianceText = variance >= 0
        ? t('shiftManager.overage', { amount })
        : t('shiftManager.shortage', { amount });

      const toastStyle = variance >= 0
        ? { icon: <CheckCircle className="w-4 h-4" />, style: { background: '#10b981', color: 'white' } }
        : { icon: <AlertTriangle className="w-4 h-4" />, style: { background: '#f59e0b', color: 'white' } };

      toast.success(t('shiftManager.shiftEndedWithVariance', { variance: varianceText }), toastStyle);
    } else {
      toast.success(t('shiftManager.shiftEnded'));
    }
    setShowShiftModal(false);
  };

  const handleOpenCheckout = () => {
    if (isShiftActive) {
      setShiftModalMode('checkout');
      setShowShiftModal(true);
    }
  };

  return (
    <StaffShiftModal
      isOpen={showShiftModal}
      onClose={() => setShowShiftModal(false)}
      mode={shiftModalMode}
      hideCashDrawer={!hasCashDrawer}
      isMobileWaiter={isMobileWaiter}
    />
  );
});

ShiftManager.displayName = 'ShiftManager';


import React, { Suspense, useEffect, useState } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import { LiquidGlassModal } from './pos-glass-components';

interface DeferredModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/** Load on first use, then preserve the modal's state and closing lifecycle. */
export function DeferredModal({ isOpen, onClose, children }: DeferredModalProps) {
  const { t } = useI18n();
  const [hasOpened, setHasOpened] = useState(isOpen);

  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);

  if (!isOpen && !hasOpened) return null;

  return (
    <Suspense fallback={
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={t('common.loading')}
        blur={false}
        closeMode="request"
      >
        <p role="status">{t('common.loading')}</p>
      </LiquidGlassModal>
    }>
      {children}
    </Suspense>
  );
}

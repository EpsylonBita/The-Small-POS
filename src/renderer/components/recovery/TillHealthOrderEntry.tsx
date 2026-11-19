import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrderNotices } from '../../services/OrderSyncNoticeStore';
import { openTillHealth } from './till-health-model';

export function TillHealthOrderEntry({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { notices } = useOrderNotices([orderId], false);
  if (!notices.length) return null;
  return <button type="button" className="min-h-11 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-yellow-400"
    onClick={() => openTillHealth({ orderId })}>{t('tillHealth.title')}</button>;
}

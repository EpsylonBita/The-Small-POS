import React from 'react';
import { useTranslation } from 'react-i18next';

export const supportButtonClass = 'min-h-[48px] min-w-[48px] rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 py-2 text-(--pos-s-fg) active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
export const supportSelectedClass = `${supportButtonClass} bg-(--pos-s-sel-bg)! text-(--pos-s-sel-fg)! font-bold`;

/** An opaque, non-interactive status; it never steals checkout focus. */
export function SupportOnsiteChip() {
  const { t } = useTranslation();
  return <aside data-testid="support-onsite-chip" role="status" className="pointer-events-none rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface) px-4 py-2 text-(--pos-s-fg)">
    {t('support.banner.awaitingOnsite')}
  </aside>;
}

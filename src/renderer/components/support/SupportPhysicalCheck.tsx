import React from 'react';
import { useTranslation } from 'react-i18next';
import { isPhysicalCheckId, PHYSICAL_CHECKS, type PhysicalCheckId } from '../../../../../shared/pos/support/physical-checks';
import { supportButtonClass, supportSelectedClass } from './SupportOnsiteChip';

/** Operator text is never rendered here; only the five shipped physical checks exist. */
export function SupportPhysicalCheck({ checkId, armed, onAnswer }: {
  checkId: PhysicalCheckId; armed: boolean; onAnswer(answer: 'done' | 'not_done'): void;
}) {
  const { t } = useTranslation();
  if (!isPhysicalCheckId(checkId)) { return null; }
  return <div className="space-y-3">
    <p>{t(`support.${PHYSICAL_CHECKS[checkId].key}`)}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={supportSelectedClass} disabled={!armed} onClick={() => onAnswer('done')}>{t('support.physicalCheck.done')}</button>
      <button type="button" className={supportButtonClass} disabled={!armed} onClick={() => onAnswer('not_done')}>{t('support.physicalCheck.notDone')}</button>
    </div>
  </div>;
}

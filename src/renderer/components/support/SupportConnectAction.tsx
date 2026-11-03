import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORT_PROTOCOL_VERSION } from '../../../../../shared/pos/support/protocol';
import { useSupportSession } from '../../hooks/useSupportSession';
import { SupportCodeScreen } from './SupportCodeScreen';
import { SupportConsentScreen } from './SupportConsentScreen';

export function SupportConnectAction() {
  const { t } = useTranslation();
  const reasonId = useId();
  const session = useSupportSession();
  const availability = session?.snapshot?.availability;
  if (!session || !availability?.available || availability.min_protocol_version > SUPPORT_PROTOCOL_VERSION) { return null; }
  const permitted = session.snapshot?.can_connect === true;
  return <div className="mb-4 space-y-3" data-testid="support-connect-action">
    <button type="button" disabled={!permitted || session.busy} aria-describedby={!permitted ? reasonId : undefined}
      onClick={() => { void session.start(); }}
      className="min-h-[48px] min-w-[48px] rounded-xl bg-(--pos-s-sel-bg) px-4 font-semibold text-(--pos-s-sel-fg) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60">
      {t('support.connect.action')}
    </button>
    {!permitted && <p id={reasonId} className="text-(--pos-s-fg)">{t('support.connect.permissionDisabled')}</p>}
    {session.view === 'consent' && session.consent ? <SupportConsentScreen consent={session.consent}
      staffRole={session.snapshot?.staff?.base_role ?? null} busy={session.busy}
      onAccept={text => { void session.accept(text); }} onDecline={() => { void session.decline(); }} />
      : session.view !== 'closed' && <SupportCodeScreen view={session.view} code={session.code} remainingMs={session.remainingMs}
        busy={session.busy} onRetry={() => { void session.start(); }} onCancel={() => { void session.cancel(); }} />}
  </div>;
}

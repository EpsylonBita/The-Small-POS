import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORT_PROTOCOL_VERSION } from '../../../../../shared/pos/support/protocol';
import { supportSessionLive, useSupportSession, type SupportBannerSnapshot } from '../../hooks/useSupportSession';
import { SupportActorPicker, SupportRenewSignIn } from './SupportActorPicker';
import { SupportCodeScreen, supportCountdown } from './SupportCodeScreen';
import { SupportConsentScreen } from './SupportConsentScreen';

// The section's own raised buttons: yellow for the action, neutral for the rest.
const primaryButton = 'pos-raised pos-raised--yellow inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-black disabled:opacity-50';
const neutralButton = 'pos-raised inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-black text-(--pos-s-fg) disabled:opacity-50';
const card = 'space-y-3 rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg)';

/** The live session in «Ενέργειες υποστήριξης», with «Τέλος». The global banner stays as the warning. */
function SupportLiveSession({ snapshot, busy, onEnd }: { snapshot: SupportBannerSnapshot; busy: boolean; onEnd(): void }) {
  const { t } = useTranslation();
  return <section data-testid="support-live-session" className={card}>
    <p className="font-bold">{t(`support.banner.${snapshot.state}`)}</p>
    {snapshot.operator_name && <p className="break-words">{snapshot.operator_name}</p>}
    <p aria-label={t('support.code.timeLeft')} className="tabular-nums">{supportCountdown(snapshot.remaining_ms)}</p>
    <p className="text-sm text-(--pos-s-muted)">{t('support.code.alreadyOpen')}</p>
    <button type="button" disabled={busy} onClick={onEnd} className={primaryButton}>{t('support.banner.end')}</button>
  </section>;
}

/** «Already open or waiting»: end that connection to ask for a new code, or close and keep waiting. */
function SupportOpenNotice({ busy, onEnd, onClose }: { busy: boolean; onEnd(): void; onClose(): void }) {
  const { t } = useTranslation();
  return <section data-testid="support-open-notice" className={card}>
    <p role="status">{t('support.code.alreadyOpen')}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <button type="button" disabled={busy} onClick={onEnd} className={primaryButton}>{t('support.code.endExisting')}</button>
      <button type="button" onClick={onClose} className={neutralButton}>{t('support.restore.dismissNotice')}</button>
    </div>
  </section>;
}

/** «Σύνδεση υποστήριξης» with everything it shows: the code, notices and the live session.
 * It lives in the Health view's «Ενέργειες υποστήριξης» section (founder, 04/11/2026). */
export function SupportConnectAction() {
  const { t } = useTranslation();
  const reasonId = useId();
  const session = useSupportSession();
  const availability = session?.snapshot?.availability;
  if (!session || !availability?.available || availability.min_protocol_version > SUPPORT_PROTOCOL_VERSION) { return null; }
  const permitted = session.snapshot?.can_connect === true;
  // The banner owns the extend step's picker and staff notices.
  const bannerStep = session.actorPurpose === 'extend'
    && (session.view === 'pick' || session.view === 'staff_required' || session.view === 'sign_in_again');
  const live = session.snapshot && supportSessionLive(session.snapshot) ? session.snapshot : null;
  const endExisting = () => { void session.endExisting(); };
  return <div className="space-y-3" data-testid="support-connect-action">
    <button type="button" disabled={!permitted || session.busy} aria-describedby={!permitted ? reasonId : undefined}
      onClick={() => { void session.start(); }} className={primaryButton}>
      {t('support.connect.action')}
    </button>
    {!permitted && <p id={reasonId} className="text-(--pos-s-fg)">{t('support.connect.permissionDisabled')}</p>}
    {live && session.view !== 'open' && <SupportLiveSession snapshot={live} busy={session.busy} onEnd={endExisting} />}
    {bannerStep ? null : session.view === 'open' ? <SupportOpenNotice busy={session.busy} onEnd={endExisting} onClose={() => { session.keepWaiting(); }} />
      : session.view === 'consent' && session.consent ? <SupportConsentScreen consent={session.consent}
        actor={session.actor} busy={session.busy}
        onChangeActor={session.actors.length > 1 ? () => { session.changeActor(); } : undefined}
        onAccept={text => { void session.accept(text); }} onDecline={() => { void session.decline(); }} />
        : session.view === 'pick' ? <SupportActorPicker purpose={session.actorPurpose === 'consent' ? 'consent' : 'request'}
          actors={session.actors} busy={session.busy}
          onChoose={staffId => { void session.choose(staffId); }} onCancel={() => { void session.cancel(); }} />
          : session.view !== 'closed' && <SupportCodeScreen view={session.view} code={session.code} remainingMs={session.remainingMs}
            busy={session.busy} onRetry={() => { void session.start(); }} onCancel={() => { void session.cancel(); }} />}
    {!bannerStep && session.view === 'sign_in_again'
      && <SupportRenewSignIn people={session.renewable} busy={session.busy} onRenew={session.renew} />}
  </div>;
}

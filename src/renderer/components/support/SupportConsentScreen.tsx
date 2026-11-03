import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConsentFetchRes } from '../../../../../shared/pos/support/consent';

export function SupportConsentScreen({ consent, staffRole, busy, onAccept, onDecline }: {
  consent: ConsentFetchRes; staffRole: string | null; busy: boolean;
  onAccept(text: NonNullable<ConsentFetchRes['text']>): void;
  onDecline(): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const body = useRef<HTMLDivElement>(null);
  const [shownText, setShownText] = useState<string | null>(null);
  const identity = consent.text ? `${consent.text.text_id}:${consent.text.version}:${consent.text.body_sha256}` : null;
  const eligible = staffRole !== null && consent.accepting_base_roles.includes(staffRole);
  const reason = ({ missing: 'required', outdated: 'outdated', withdrawn: 'withdrawn',
    text_unavailable: 'textUnavailable', valid: 'accepted', exempt: 'accepted' } as const)[consent.state];
  const checkRead = useCallback(() => {
    const element = body.current;
    if (element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop <= element.clientHeight + 1) {
      setShownText(identity);
    }
  }, [identity]);
  useEffect(() => {
    const element = body.current;
    if (element) { element.scrollTop = 0; }
    setShownText(null);
    checkRead();
    if (!element || typeof ResizeObserver === 'undefined') { return; }
    const observer = new ResizeObserver(checkRead);
    observer.observe(element);
    return () => observer.disconnect();
  }, [identity, checkRead]);

  return <section aria-labelledby={titleId} className="space-y-4 rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg)">
    <h3 id={titleId} className="text-lg font-bold">{t('support.consent.title')}</h3>
    <p role="status">{t(`support.consent.${reason}`)}</p>
    {consent.text && <>
      <p>{t('support.consent.version')}: {consent.text.version}</p>
      <div ref={body} onScroll={checkRead} tabIndex={0} role="region" aria-label={t('support.consent.title')}
        data-testid="support-consent-text" lang={consent.text.locale}
        className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) p-4 focus-visible:outline-2 focus-visible:outline-offset-2">
        {consent.text.body}
      </div>
    </>}
    {!eligible && <div><p>{t('support.consent.onlyOwnerAdmin')}</p><p>{t('support.consent.storeAdminAlternative')}</p></div>}
    <div className="flex flex-wrap gap-3">
      {eligible && consent.text && consent.state !== 'text_unavailable' && <button type="button" disabled={busy || shownText !== identity}
        onClick={() => { if (consent.text && shownText === identity) { onAccept(consent.text); } }}
        className="min-h-[48px] min-w-[48px] rounded-xl bg-(--pos-s-sel-bg) px-4 font-semibold text-(--pos-s-sel-fg) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60">
        {t('support.consent.agree')}
      </button>}
      <button type="button" onClick={onDecline}
        className="min-h-[48px] min-w-[48px] rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2">
        {t('support.consent.decline')}
      </button>
    </div>
  </section>;
}

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { getBridge } from '../../../lib';
import { listenSupportEvent } from '../../services/support/SupportRemedyRunner';

const RestoreNoticeSchema = z.object({ id: z.string(), status: z.enum(['staged', 'applied', 'refused', 'expired', 'rolled_back']) });
const LeaseStateSchema = z.object({ restore_lease_held: z.boolean(), restore_notice: RestoreNoticeSchema.nullish() });
const LeaseEventSchema = z.object({ held: z.boolean() });

/** Native owns admission; this shell also disables entry and existing portals. */
export function SupportRestoreNotice({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [held, setHeld] = useState(false);
  const [outcome, setOutcome] = useState<z.infer<typeof RestoreNoticeSchema> | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true, reading = false, revision = 0;
    const stop = listenSupportEvent('support://restore-lease', value => {
      const parsed = LeaseEventSchema.safeParse(value);
      if (parsed.success) { revision++; setHeld(parsed.data.held); }
    });
    const read = async () => {
      if (reading) { return; }
      reading = true;
      const observedRevision = revision;
      try {
        const parsed = LeaseStateSchema.safeParse(await getBridge().invoke('support_restore_notice'));
        if (alive && parsed.success) {
          if (observedRevision === revision) { setHeld(parsed.data.restore_lease_held); }
          setOutcome(parsed.data.restore_notice ?? null);
        }
      } catch { /* Retain a known lease through IPC failures; never invent one. */ }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 1000);
    return () => { alive = false; stop(); window.clearInterval(timer); };
  }, []);
  useLayoutEffect(() => {
    if (!held) { return; }
    const previous = document.activeElement;
    const restored = new Map<HTMLElement, boolean>();
    const disablePortals = () => {
      for (const element of Array.from(document.body.children)) {
        // End remains reachable during atomic settlement, above the notice.
        if (!(element instanceof HTMLElement) || element === notice.current || element.hasAttribute('data-support-banner-host')) { continue; }
        if (!restored.has(element)) { restored.set(element, element.inert); }
        element.inert = true;
      }
    };
    disablePortals(); notice.current?.focus();
    const observer = new MutationObserver(disablePortals);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect(); restored.forEach((wasInert, element) => { element.inert = wasInert; });
      if (previous instanceof HTMLElement && previous.isConnected) { previous.focus(); }
    };
  }, [held]);
  return <>
    <fieldset disabled={held} inert={held} aria-disabled={held} data-testid="support-business-entry" className="contents">{children}</fieldset>
    {!held && outcome && outcome.id !== dismissed && createPortal(<div role="status" data-cashier-recovery="true"
      data-testid="support-restore-outcome" className="fixed bottom-4 left-4 right-4 z-[2147483644] flex items-center justify-between gap-4 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg)">
      <p>{t(`support.restore.notices.${outcome.status}`)}</p>
      <button type="button" className="min-h-12 min-w-12 rounded-xl border border-(--pos-s-border) px-4 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => setDismissed(outcome.id)}>{t('support.restore.dismissNotice')}</button>
    </div>, document.body)}
    {held && createPortal(<div ref={notice} role="status" aria-label={t('support.restore.preparing')} tabIndex={-1}
      data-testid="support-restore-notice" data-cashier-recovery="true"
      className="fixed inset-0 z-[2147483645] flex items-center justify-center bg-(--pos-s-surface) p-6 text-center text-(--pos-s-fg)">
      <p className="text-xl font-bold">{t('support.restore.preparing')}</p>
    </div>, document.body)}
  </>;
}

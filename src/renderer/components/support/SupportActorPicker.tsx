import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupportActor, SupportActorPurpose, SupportRenewOutcome, SupportStaffOnShift, SupportView } from '../../hooks/useSupportSession';
import { translateRoleName } from '../../utils/role-labels';

const secondary = 'min-h-[48px] min-w-[48px] rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2';

/** A person shown as given (names are never translated); an empty name falls back to the role. */
export function supportActorLabel(t: (key: string) => unknown, actor: SupportActor): string {
  return actor.name.trim() || translateRoleName(t, actor.base_role);
}

/** One tap names who is acting for support on this till. No PIN: native only lists checked-in staff. */
export function SupportActorPicker({ purpose, actors, busy, onChoose, onCancel }: {
  purpose: SupportActorPurpose; actors: readonly SupportActor[]; busy: boolean;
  onChoose(staffId: string): void; onCancel(): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return <section aria-labelledby={titleId} data-testid="support-actor-picker"
    className="space-y-4 rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg)">
    <h3 id={titleId} className="text-lg font-bold">{t(purpose === 'consent' ? 'support.staff.pickConsent' : 'support.staff.pickRequest')}</h3>
    <ul aria-labelledby={titleId} className="grid gap-2 sm:grid-cols-2">
      {actors.map(actor => {
        const named = actor.name.trim().length > 0;
        return <li key={actor.staff_id}>
          <button type="button" disabled={busy} onClick={() => onChoose(actor.staff_id)}
            className={`flex w-full flex-col items-start justify-center py-2 text-left disabled:opacity-60 ${secondary}`}>
            <span className="break-words font-semibold">{supportActorLabel(t, actor)}</span>
            {named && <span className="text-sm text-(--pos-s-muted)">{translateRoleName(t, actor.base_role)}</span>}
          </button>
        </li>;
      })}
    </ul>
    <div className="flex flex-wrap gap-3">
      <button type="button" onClick={onCancel} className={secondary}>{t('support.code.cancel')}</button>
    </div>
  </section>;
}

/** Why nobody can act right now, for the banner's extend step. */
export function SupportStaffNotice({ view, onClose }: { view: Extract<SupportView, 'staff_required' | 'sign_in_again'>; onClose(): void }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap items-center gap-3 text-(--pos-s-fg)">
    <p role="status" className="min-w-0 flex-1">{t(view === 'sign_in_again' ? 'support.staff.signInAgain' : 'support.staff.required')}</p>
    <button type="button" onClick={onClose} className={secondary}>{t('support.code.cancel')}</button>
  </div>;
}

const primary = 'min-h-[48px] min-w-[48px] rounded-xl bg-(--pos-s-sel-bg) px-4 font-semibold text-(--pos-s-sel-fg) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60';

/** Someone on shift whose sign-in for support expired confirms their own PIN. This is the server
 * check-in alone: no shift is opened or closed, and no checkout or sale is involved. */
export function SupportRenewSignIn({ people, busy, onRenew }: {
  people: readonly SupportStaffOnShift[]; busy: boolean;
  onRenew(staffId: string, pin: string): Promise<SupportRenewOutcome>;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const pinId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [outcome, setOutcome] = useState<SupportRenewOutcome | null>(null);
  if (people.length === 0) { return null; }
  const person = people.find(entry => entry.staff_id === chosen) ?? (people.length === 1 ? people[0] : null);
  const label = (entry: SupportStaffOnShift) => entry.name.trim() || String(t('support.staff.onShift'));
  const pick = (staffId: string | null) => { setChosen(staffId); setPin(''); setOutcome(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!person || pin.length < 4 || busy) { return; }
    const entered = pin;
    setPin('');
    setOutcome(await onRenew(person.staff_id, entered));
  };
  const problem = outcome === 'refused' ? 'support.staff.renewRefused' : outcome === 'offline' ? 'support.staff.renewOffline'
    : outcome === 'error' ? 'support.code.retry' : null;
  return <section aria-labelledby={titleId} data-testid="support-renew" className="space-y-3 text-(--pos-s-fg)">
    <h4 id={titleId} className="font-semibold">{t('support.staff.renewTitle')}</h4>
    {!person ? <ul aria-labelledby={titleId} className="grid gap-2 sm:grid-cols-2">
      {people.map(entry => <li key={entry.staff_id}>
        <button type="button" disabled={busy} onClick={() => pick(entry.staff_id)}
          className={`w-full break-words py-2 text-left font-semibold disabled:opacity-60 ${secondary}`}>{label(entry)}</button>
      </li>)}
    </ul> : <form onSubmit={event => { void submit(event); }} className="flex flex-wrap items-end gap-3">
      <label htmlFor={pinId} className="flex min-w-0 flex-col gap-1">
        <span>{t('support.staff.renewPin', { name: label(person) })}</span>
        <input id={pinId} type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} disabled={busy}
          onChange={event => setPin(event.target.value.replace(/\D/g, ''))}
          className="min-h-[48px] w-40 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-3 font-mono text-lg tracking-widest focus-visible:outline-2 focus-visible:outline-offset-2" />
      </label>
      <button type="submit" disabled={busy || pin.length < 4} className={primary}>{t('support.staff.renew')}</button>
      {people.length > 1 && <button type="button" disabled={busy} onClick={() => pick(null)} className={secondary}>{t('support.staff.renewSomeoneElse')}</button>}
    </form>}
    {problem && <p role="alert">{t(problem)}</p>}
    <p className="text-sm text-(--pos-s-muted)">{t('support.staff.renewKeepsShift')}</p>
  </section>;
}

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Clock3, Headphones, TriangleAlert, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { HealthAvailability, SimpleServiceStatus } from '../../../../../shared/pos/health/health-contract';
import { closeoutServiceTone, healthServiceTone } from '../../../../../shared/pos/health/health-tone';
import type { RecoveryActionDescriptor } from '../../../lib';
import { CashierRecovery } from '../../contexts/cashier-gate-context';
import { formatTime } from '../../utils/format';
import { useBackgroundAccessibilityIsolation } from '../ui/pos-glass-components';
import { issueSubject, safeOrderNumber, staffActionLabel, tillHealthTone, type TillHealthCard, type TillHealthState } from './till-health-model';
import './till-health.css';

gsap.registerPlugin(useGSAP);

export interface TillHealthOrderDetails {
  number: string | null;
  type: 'delivery' | 'pickup' | 'dine_in' | null;
  total: string | null;
}

export interface TillHealthWindowProps {
  id: string;
  state: TillHealthState;
  availability: HealthAvailability;
  cards: TillHealthCard[];
  services: SimpleServiceStatus;
  isShiftActive: boolean;
  online: boolean;
  lastChecked: string | null;
  dayStart: string | null;
  busy: boolean;
  canAskSupport: boolean;
  supportCanConnect?: boolean;
  supportUnavailable: boolean;
  supportFlowOpen: boolean;
  focusKey?: string | null;
  orderDetails?: ReadonlyMap<string, TillHealthOrderDetails>;
  onClose: () => void;
  onRefresh: () => void;
  onAskSupport: () => void;
  onCardAction: (card: TillHealthCard, action?: RecoveryActionDescriptor) => void;
  onDismissSolved: (card: TillHealthCard) => void;
  support: React.ReactNode;
  overlays?: React.ReactNode;
}

export function TillHealthButton({ children, primary = false, className = '', ...props }:
  React.ComponentProps<'button'> & { primary?: boolean }) {
  return <button type="button" className={`till-health-button pos-raised ${primary ? 'pos-raised--yellow' : ''} ${className}`} {...props}>{children}</button>;
}

function timeAt(value: string, locale?: string) {
  return formatTime(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locale);
}

function TillHealthIssueCard({ card, order, disabled, stale, online, canAskSupport, supportCanConnect, onAskSupport, onOpenSupport, onAction, onDismissSolved }:
  { card: TillHealthCard; order?: TillHealthOrderDetails; disabled: boolean; online: boolean; canAskSupport: boolean;
    stale: boolean; supportCanConnect: boolean;
    onAskSupport: () => void; onOpenSupport: () => void;
    onAction: TillHealthWindowProps['onCardAction']; onDismissSolved: TillHealthWindowProps['onDismissSolved'] }) {
  const { t, i18n } = useTranslation();
  const [otherOpen, setOtherOpen] = useState(false);
  const otherId = useId();
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const phase = stale ? null : card.attempt?.state ?? card.sendPhase ?? (card.pending ? 'pending' : null);
  const verifiedAt = card.attempt?.verifiedAt ?? card.verifiedAt;
  useGSAP((_context, contextSafe) => {
    if (phase !== 'solved' || !ref.current) return;
    const element = ref.current;
    const motion = gsap.matchMedia();
    let tween: gsap.core.Tween | undefined;
    let reduced = false;
    mediaPreference(motion, value => {
      reduced = value;
      if (value && tween) { tween.kill(); onDismissSolved(card); }
    });
    const leave = () => {
      if (reduced || !window.matchMedia) { onDismissSolved(card); return; }
      tween = gsap.to(element, { opacity: 0, y: -6, duration: 0.24, ease: 'power2.out', onComplete: () => onDismissSolved(card) });
    };
    const timer = window.setTimeout(contextSafe?.(leave) ?? leave, 2400);
    return () => { window.clearTimeout(timer); motion.revert(); };
  }, { scope: ref, dependencies: [phase, verifiedAt], revertOnUpdate: true });

  const issue = card.issue;
  const subject = issue ? issueSubject(issue) : card.localAction === 'printer' ? 'printer' : 'till';
  const orderNumber = safeOrderNumber(issue?.orderNumber) ?? order?.number;
  const ledger = [orderNumber ? t('tillHealth.subject.orderNumber', { number: orderNumber }) : t(`tillHealth.subject.${subject}`),
    order?.type ? t(`tillHealth.orderType.${order.type}`) : null, order?.total].filter(Boolean).join(' · ');
  const primary = card.action || card.localAction;
  const needsSupport = phase === 'failed' || !primary || phase === 'permission' || phase === 'parked';
  const onlineAction = !online && (card.action?.requiresOnline || card.localAction === 'send');
  const progress = phase === 'working' || phase === 'pending' || phase === 'solved';
  const correctionPhase = card.family === 'customerCorrection'
    ? phase === 'working' ? 'correctionWorking' : phase === 'pending' ? 'correctionPending'
      : phase === 'solved' ? card.attempt?.actionId === 'keepServerOrderCustomerDetails' ? 'correctionKept' : 'correctionSaved' : null
    : null;
  const permitSecondDecision = Boolean(card.action && card.secondary && !progress && !needsSupport);
  const actionKey = card.action ? staffActionLabel(card.action) : card.localAction;
  const relatedBalance = issue?.params?.remainingAmount ?? issue?.params?.outstandingAmount;
  const balance = typeof relatedBalance === 'string' && /^[0-9.,\s€$£]+$/.test(relatedBalance) ? relatedBalance : '';
  return <article ref={ref} className="till-health-card" data-testid="till-health-card" aria-labelledby={titleId}>
    <p className="till-health-kicker">{ledger}</p>
    <h3 id={titleId} data-health-tone={card.family === 'wrongMoney' || card.family === 'courierMoney' ? 'money' : undefined}>
      {t(correctionPhase ? `tillHealth.phase.${correctionPhase}` : `tillHealth.families.${card.family}.title`)}
    </h3>
    {!correctionPhase && <p>{card.copyDetail ?? t(`tillHealth.families.${card.family}.detail`)} {balance}</p>}
    {phase && <p role="status" data-health-tone={phase === 'solved' ? 'ok' : phase === 'failed' ? 'bad' : 'warn'}>
      {t(`tillHealth.phase.${phase}`, { time: verifiedAt ? timeAt(verifiedAt, i18n?.resolvedLanguage || i18n?.language) : '' })}
    </p>}
    {(phase === 'working' || phase === 'pending') && <ol className="till-health-steps" aria-label={t('tillHealth.progress')}>
      <li aria-current={phase === 'working' ? 'step' : undefined}>{t('tillHealth.step.save')}</li>
      <li aria-current={phase === 'pending' ? 'step' : undefined}>{t('tillHealth.step.confirm')}</li>
      <li>{t('tillHealth.step.done')}</li>
    </ol>}
    {stale && <p>{t('tillHealth.phase.checkingOld')}</p>}
    {!progress && !stale && card.family !== 'dayOverdue' && <div className="till-health-card-action">
      {onlineAction && <p>{t('tillHealth.action.offline')}</p>}
      {phase === 'signIn' && issue
        ? <TillHealthButton primary onClick={() => window.dispatchEvent(new CustomEvent('pos:health-sign-in', { detail: { issueId: issue.id } }))}>{t('tillHealth.action.signIn')}</TillHealthButton>
        : needsSupport
          ? <><p>{t('tillHealth.action.noSafeAction')}</p>
            <TillHealthButton primary disabled={supportCanConnect && !canAskSupport} onClick={supportCanConnect ? onAskSupport : onOpenSupport}>
              {t(supportCanConnect ? 'tillHealth.action.askSupport' : 'tillHealth.action.supportDetails')}
            </TillHealthButton></>
          : <TillHealthButton primary disabled={disabled || Boolean(onlineAction)} onClick={() => onAction(card, card.action)}>
            {t(`tillHealth.action.${actionKey}`)}
          </TillHealthButton>}
      {permitSecondDecision && <>
        <button type="button" className="till-health-quiet" aria-expanded={otherOpen} aria-controls={otherId} onClick={() => setOtherOpen(open => !open)}>
          {t('tillHealth.action.noLongerNeeded')}
        </button>
        {otherOpen && <div id={otherId} className="till-health-other">
          <TillHealthButton disabled={disabled || !online} onClick={() => onAction(card, card.secondary)}>{t('tillHealth.action.keepDetails')}</TillHealthButton>
          <p>{t('tillHealth.action.keepExplanation')}</p>
        </div>}
      </>}
    </div>}
  </article>;
}

const serviceKeys = ['orders', 'internet', 'sync', 'printer', 'closeout', 'support'] as const;

function mediaPreference(media: gsap.MatchMedia, onChange: (reduced: boolean) => void) {
  if (!window.matchMedia) return;
  media.add({
    reduce: '(prefers-reduced-motion: reduce)',
    allow: '(prefers-reduced-motion: no-preference)',
  }, context => onChange(Boolean(context.conditions?.reduce)));
}

export function TillHealthWindow(props: TillHealthWindowProps) {
  const { t, i18n } = useTranslation();
  const [supportOpen, setSupportOpen] = useState(props.supportFlowOpen);
  const shellRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLDivElement>(null);
  const supportRef = useRef<HTMLDivElement>(null);
  const previousState = useRef(props.state);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const titleId = useId();
  const headlineId = useId();
  const supportId = useId();
  const initialRead = props.availability === 'loading' && !props.lastChecked;
  const unavailable = props.availability === 'unavailable';
  const stale = props.state === 'stale' && !initialRead;
  const locale = i18n?.resolvedLanguage || i18n?.language;
  const supportCanConnect = props.supportCanConnect ?? props.canAskSupport;
  const checked = props.lastChecked ? timeAt(props.lastChecked, locale) : '';
  const openSupport = () => setSupportOpen(true);
  const askSupport = () => { openSupport(); props.onAskSupport(); };

  useEffect(() => { if (props.supportFlowOpen) setSupportOpen(true); }, [props.supportFlowOpen]);
  useEffect(() => { if (props.focusKey) setSupportOpen(false); }, [props.focusKey]);
  useBackgroundAccessibilityIsolation(true);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => shellRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = shellRef.current;
      if (!dialog || [...document.querySelectorAll('[role="dialog"]')].at(-1) !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]') && element.offsetParent !== null);
      const first = focusable[0] ?? dialog;
      const last = focusable.at(-1) ?? dialog;
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === dialog || document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      window.setTimeout(() => {
        const topDialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        if (previousFocus?.isConnected && (!topDialog || topDialog.contains(previousFocus))) previousFocus.focus();
      }, 0);
    };
  }, []);

  useGSAP(() => {
    const changed = previousState.current !== props.state;
    previousState.current = props.state;
    if (!changed || !headlineRef.current || !window.matchMedia) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(headlineRef.current, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform,opacity' });
    });
    return () => media.revert();
  }, { scope: shellRef, dependencies: [props.state], revertOnUpdate: true });
  useGSAP(() => {
    if (!supportOpen || !supportRef.current || !window.matchMedia) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(supportRef.current, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.26, ease: 'power2.out', clearProps: 'transform,opacity' });
    });
    return () => media.revert();
  }, { scope: shellRef, dependencies: [supportOpen], revertOnUpdate: true });

  const lead = initialRead ? 'loading' : unavailable ? 'unavailable' : props.state === 'ok' && !props.isShiftActive ? 'noShift' : props.state;
  const Icon = props.state === 'ok' || props.state === 'solved' ? Check
    : initialRead || props.state === 'working' || props.state === 'pending' ? Clock3 : TriangleAlert;

  return createPortal(<CashierRecovery>
    <div className="liquid-glass-modal-viewport till-health-viewport" data-liquid-glass-modal-viewport data-cashier-recovery="true">
      <div className="liquid-glass-modal-backdrop" aria-hidden="true" onClick={props.onClose} />
      <div ref={shellRef} id={props.id} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={headlineId}
        tabIndex={-1} className="liquid-glass-modal-shell till-health-window" data-health-state={props.state}>
        <header className="till-health-header">
          <h2 id={titleId}>{t('tillHealth.title')}</h2>
          <button type="button" className="liquid-glass-modal-close" aria-label={t('common.actions.close')} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
          <p>{checked ? t('tillHealth.lastChecked', { time: checked }) : t('tillHealth.notChecked')}</p>
        </header>
        <div className="till-health-body">
          <section className="till-health-headline">
            <div ref={headlineRef} aria-live="polite">
              <h3 data-health-tone={tillHealthTone(props.state)}><Icon aria-hidden="true" />{t(`tillHealth.states.${props.state}.title`)}</h3>
              <p id={headlineId}>{t(`tillHealth.states.${lead}.detail`, { time: checked })}</p>
            </div>
            <TillHealthButton primary={stale} disabled={props.busy} onClick={props.onRefresh}>{t('tillHealth.action.recheck')}</TillHealthButton>
          </section>
          {props.cards.map(card => <TillHealthIssueCard key={card.id} card={card}
            order={card.issue?.orderId ? props.orderDetails?.get(card.issue.orderId) : undefined}
            disabled={props.busy} stale={props.availability !== 'ready'} online={props.online}
            canAskSupport={props.canAskSupport} supportCanConnect={supportCanConnect} onAskSupport={askSupport} onOpenSupport={openSupport}
            onAction={props.onCardAction} onDismissSolved={props.onDismissSolved} />)}
          <section className="till-health-now">
            <h3>{t(stale && checked ? 'tillHealth.checkedServices' : 'tillHealth.services.title', { time: checked })}</h3>
            <ul>
              {serviceKeys.map(key => {
                const value = initialRead || unavailable ? 'unknown' : key === 'support' && props.supportUnavailable
                  ? 'unavailable' : props.services[key];
                const tone = stale || initialRead ? 'neutral' : key === 'closeout' ? closeoutServiceTone(props.services.closeout)
                  : value === 'unavailable' ? 'bad' : healthServiceTone(value);
                const day = key === 'closeout' && value === 'open' && props.dayStart;
                return <li key={key} data-testid={`health-service-${key}`}>
                  <div className="till-health-row">
                    <span>{t(`tillHealth.services.${key}`)}</span>
                    <strong data-health-tone={tone}>{t(day ? 'tillHealth.status.openSince' : `tillHealth.status.${value}`, { time: day ? timeAt(day, locale) : '' })}</strong>
                  </div>
                  {key === 'closeout' && value === 'open' && <p>{t('tillHealth.closeoutHint')}</p>}
                </li>;
              })}
            </ul>
          </section>
          <section className="till-health-help" data-testid={props.supportUnavailable ? 'health-remote-support' : undefined}>
            <div>
              <h3>{t('tillHealth.help.title')}</h3>
              <p>{t(props.supportUnavailable ? 'tillHealth.help.unavailable' : !props.online ? 'tillHealth.help.offline'
                : props.canAskSupport ? 'tillHealth.help.available' : 'tillHealth.help.permission')}</p>
            </div>
            {supportCanConnect
              ? <TillHealthButton disabled={!props.canAskSupport} onClick={askSupport}><Headphones aria-hidden="true" />{t('tillHealth.action.askSupport')}</TillHealthButton>
              : <TillHealthButton onClick={openSupport}>{t('tillHealth.action.supportDetails')}</TillHealthButton>}
          </section>
          <section className="till-health-support" data-testid="health-support-actions">
            <button type="button" className="till-health-support-toggle" aria-expanded={supportOpen} aria-controls={supportId} onClick={() => setSupportOpen(open => !open)}>
              <span><strong>{t('tillHealth.support.title')}</strong><small>{t('tillHealth.support.hint')}</small></span>
              <ChevronDown aria-hidden="true" />
            </button>
            <div id={supportId} ref={supportRef} hidden={!supportOpen} className="till-health-support-content">
              {supportOpen && props.support}
            </div>
          </section>
        </div>
      </div>
    </div>
    {props.overlays}
  </CashierRecovery>, document.body);
}

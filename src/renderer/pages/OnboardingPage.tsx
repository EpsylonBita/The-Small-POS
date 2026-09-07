import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Toaster, toast } from 'react-hot-toast';
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronDown, Globe2, KeyRound, Monitor, ShieldCheck } from 'lucide-react';
import { useI18n } from '../contexts/i18n-context';
import { getBridge } from '../../lib';
import RecoveryPanel from '../components/recovery/RecoveryPanel';
import { decodeConnectionString, looksLikeRawApiKey, normalizeAdminDashboardUrl } from '../utils/connection-code';
import { getErrorMessage } from '../utils/privileged-actions';
import { requireSettingsSuccess } from '../utils/settings-operation';

type SupportedLanguage = 'en' | 'el' | 'de' | 'fr' | 'it';
type ConnectionPhase = 'idle' | 'validating' | 'syncing' | 'complete';

const languages: { code: SupportedLanguage; name: string }[] = [
    { code: 'en', name: 'English' },
    { code: 'el', name: 'Ελληνικά' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'it', name: 'Italiano' },
];

const OnboardingPage: React.FC = () => {
    const bridge = getBridge();
    const { t, setLanguage, language } = useI18n();
    const reduceMotion = useReducedMotion();
    const [step, setStep] = useState(1);
    const [connectionString, setConnectionString] = useState('');
    const [error, setError] = useState<{ message: string; syncing: boolean } | null>(null);
    const [phase, setPhase] = useState<ConnectionPhase>('idle');
    const [savingLanguage, setSavingLanguage] = useState(false);
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const submitting = useRef(false);
    const stepHeading = useRef<HTMLHeadingElement>(null);
    const errorPanel = useRef<HTMLDivElement>(null);
    const isSubmitting = savingLanguage || phase !== 'idle';
    const decoded = useMemo(() => decodeConnectionString(connectionString), [connectionString]);
    const transition = { duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' as const };
    const entry = reduceMotion ? false : { opacity: 0, y: 6 };
    const inputError = !connectionString.trim() ? null : decoded ? null : looksLikeRawApiKey(connectionString)
        ? t('onboarding.rawApiKeyDetected', { defaultValue: 'This looks like an API key. Copy the full connection code from Admin Dashboard → Branches → POS.' })
        : t('onboarding.invalidConnectionString', { defaultValue: 'This connection code is incomplete or invalid. Copy the full code again from the Admin Dashboard.' });

    useEffect(() => {
        if (step === 2) stepHeading.current?.focus();
    }, [step]);

    useEffect(() => {
        if (error) errorPanel.current?.focus();
    }, [error]);

    useEffect(() => {
        if (phase !== 'complete') return;
        // A renderer reload is sufficient before any authenticated admin session exists.
        const timeout = window.setTimeout(() => window.location.reload(), 1500);
        return () => window.clearTimeout(timeout);
    }, [phase]);

    const handleLanguageSelect = async (lang: SupportedLanguage) => {
        if (submitting.current) return;
        submitting.current = true;
        setSavingLanguage(true);
        setError(null);
        try {
            await setLanguage(lang);
            setStep(2);
        } catch {
            const message = t('errors.saveFailed', { defaultValue: 'Failed to save changes.' });
            setError({ message, syncing: false });
            toast.error(message);
        } finally {
            submitting.current = false;
            setSavingLanguage(false);
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setError(null);
        let syncing = false;
        let completed = false;
        try {
            if (!decoded) {
                throw new Error(inputError || t('onboarding.validationError', { defaultValue: 'Please enter the connection code.' }));
            }
            setPhase('validating');
            const normalizedAdminUrl = normalizeAdminDashboardUrl(decoded.adminUrl);
            const result = requireSettingsSuccess(await bridge.settings.updateTerminalCredentials({
                terminalId: decoded.terminalId,
                apiKey: decoded.apiKey,
                adminUrl: normalizedAdminUrl,
                adminDashboardUrl: normalizedAdminUrl,
                supabaseUrl: decoded.supabaseUrl,
                supabaseAnonKey: decoded.supabaseAnonKey,
            }));
            if (result?.success !== true) {
                throw new Error(t('onboarding.configureFailed', { defaultValue: 'Unable to connect this terminal.' }));
            }

            syncing = true;
            setPhase('syncing');
            const syncResult = requireSettingsSuccess(await bridge.terminalConfig.syncFromAdmin());
            if (syncResult?.success !== true) {
                throw new Error(t('onboarding.syncFailed', { defaultValue: 'The connection was saved, but settings could not be synced.' }));
            }

            localStorage.setItem('admin_dashboard_url', normalizedAdminUrl);
            localStorage.setItem('pos-terminal-configured', '1');
            completed = true;
            setPhase('complete');
            toast.success(t('onboarding.success', { defaultValue: 'Terminal configured successfully!' }));
        } catch (err: unknown) {
            const message = getErrorMessage(err, t('onboarding.unexpectedError', { defaultValue: 'An unexpected error occurred' }));
            setError({ message, syncing });
            toast.error(message);
        } finally {
            // Keep the form locked during the brief success/reload transition.
            if (!completed) {
                submitting.current = false;
                setPhase('idle');
            }
        }
    };

    const errorContent = error && (
        <div ref={errorPanel} id="onboarding-error" role="alert" tabIndex={-1}
            className="flex gap-3 rounded-2xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200 outline-none focus-visible:ring-2 focus-visible:ring-red-300">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
                <p className="break-words font-medium">{error.message}</p>
                {step === 2 && <p className="mt-1 text-red-200/80">{error.syncing
                    ? t('onboarding.syncRetryHint', { defaultValue: 'Check your internet connection and try again to finish syncing.' })
                    : t('onboarding.retryHint', { defaultValue: 'Check your internet connection and confirm the code is current, then try again.' })}</p>}
            </div>
        </div>
    );

    return (
        <div className="dark modern-scrollbar flex h-full min-h-0 flex-col items-center overflow-y-auto bg-zinc-950 p-4 text-zinc-100 sm:p-6">
            {/* Auto margins keep the top reachable when a short POS window must scroll. */}
            <div className="my-auto w-full max-w-4xl py-2">
                <div className="mb-5 flex items-center gap-3 px-1">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-yellow-400/30 bg-yellow-400/10 text-yellow-300">
                        <Monitor className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                        <p className="text-sm font-semibold tracking-[0.22em] text-zinc-100">THE SMALL</p>
                        <p className="mt-0.5 text-xs text-zinc-400">{t('onboarding.secureSetup', { defaultValue: 'Terminal setup' })}</p>
                    </div>
                </div>

                <main className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-xl">
                    <header className="border-b border-zinc-800 px-5 py-5 sm:px-8 sm:py-6">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">{t('onboarding.title', { defaultValue: 'Set up your POS' })}</h1>
                                <p className="mt-2 text-sm text-zinc-400">{t('onboarding.subtitle', { defaultValue: 'A few simple steps, then you’re ready to work.' })}</p>
                            </div>
                            <span className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300">
                                {t('onboarding.step', { defaultValue: 'Step {{current}} of {{total}}', current: step, total: 2 })}
                            </span>
                        </div>
                        <ol className="mt-5 grid grid-cols-2 gap-4" aria-label={t('onboarding.secureSetup', { defaultValue: 'Terminal setup' })}>
                            {[t('onboarding.languageStep', { defaultValue: 'Language' }), t('onboarding.connectionStep', { defaultValue: 'Connect terminal' })].map((label, index) => (
                                <li key={index} aria-current={step === index + 1 ? 'step' : undefined} className="min-w-0">
                                    <div className={`flex items-center gap-2 text-sm ${step >= index + 1 ? 'text-yellow-200' : 'text-zinc-500'}`}>
                                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step >= index + 1 ? 'bg-yellow-400 text-zinc-950' : 'bg-zinc-800 text-zinc-400'}`}>
                                            {step > index + 1 || phase === 'complete' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
                                        </span>
                                        <span>{label}</span>
                                    </div>
                                    <div className="mt-3 h-0.5 overflow-hidden rounded-full bg-zinc-800">
                                        <motion.div initial={false} animate={{ scaleX: step >= index + 1 ? 1 : 0 }} transition={transition} className="h-full origin-left bg-yellow-400" />
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </header>

                    <motion.div key={phase === 'complete' ? 'complete' : step} initial={entry} animate={{ opacity: 1, y: 0 }} transition={transition} className="p-5 sm:p-8">
                        {step === 1 && (
                            <section aria-labelledby="onboarding-language-heading" className="space-y-5" aria-busy={savingLanguage}>
                                <div className="flex items-start gap-3">
                                    <Globe2 className="mt-1 h-5 w-5 shrink-0 text-yellow-300" aria-hidden="true" />
                                    <div>
                                        <h2 id="onboarding-language-heading" className="text-xl font-semibold">{t('onboarding.selectLanguage', { defaultValue: 'Select Language' })}</h2>
                                        <p className="mt-1 text-sm leading-relaxed text-zinc-400">{t('onboarding.languageHelp', { defaultValue: 'Choose the language for this terminal. You can change it later in Settings.' })}</p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {languages.map((option, index) => (
                                        <motion.button key={option.code} type="button" lang={option.code} aria-label={option.name} aria-pressed={language === option.code}
                                            onClick={() => void handleLanguageSelect(option.code)} disabled={isSubmitting}
                                            whileTap={reduceMotion ? undefined : { scale: 0.985 }} transition={transition}
                                            className={`flex min-h-16 items-center gap-3 rounded-2xl border px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:cursor-wait disabled:opacity-60 ${index === languages.length - 1 ? 'sm:col-span-2' : ''} ${language === option.code ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200' : 'border-zinc-700 bg-zinc-950/40 text-zinc-200 active:bg-zinc-800'}`}>
                                            <span className="flex h-8 w-9 shrink-0 items-center justify-center rounded-lg border border-current/15 text-xs font-semibold uppercase tracking-wide" aria-hidden="true">{option.code === 'el' ? 'GR' : option.code}</span>
                                            <span className="flex-1 text-base font-medium">{option.name}</span>
                                            {language === option.code ? <Check className="h-5 w-5" aria-hidden="true" /> : <ArrowRight className="h-4 w-4 text-zinc-500" aria-hidden="true" />}
                                        </motion.button>
                                    ))}
                                </div>
                                {errorContent}
                                <p className="text-center text-xs text-zinc-500">{t('onboarding.languageContinue', { defaultValue: 'Choose a language to continue' })}</p>
                            </section>
                        )}

                        {step === 2 && phase !== 'complete' && (
                            <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-busy={isSubmitting}>
                                <div>
                                    <h2 ref={stepHeading} tabIndex={-1} className="text-xl font-semibold outline-none">{t('onboarding.connectionTitle', { defaultValue: 'Connect your terminal' })}</h2>
                                    <p className="mt-1 text-sm text-zinc-400">{t('onboarding.connectionIntro', { defaultValue: 'Link this POS to your business using its connection code.' })}</p>
                                </div>
                                <div className="grid items-start gap-5 md:grid-cols-[1.15fr_1fr]">
                                    <div>
                                        <label htmlFor="onboarding-connection-code" className="mb-2 block text-sm font-medium text-zinc-200">{t('onboarding.connectionString', { defaultValue: 'Connection code' })}</label>
                                        <textarea id="onboarding-connection-code" value={connectionString} rows={3} disabled={isSubmitting}
                                            onChange={(event) => { setConnectionString(event.target.value); setError(null); }}
                                            aria-invalid={Boolean(inputError || (error && !decoded))}
                                            aria-describedby={`onboarding-code-help onboarding-key-hint${inputError && !error ? ' onboarding-code-invalid' : ''}${error ? ' onboarding-error' : ''}`}
                                            autoComplete="off" autoCapitalize="none" spellCheck={false}
                                            className="min-h-28 w-full resize-y rounded-2xl border border-zinc-600 bg-zinc-950 px-4 py-3 font-mono text-sm text-zinc-200 outline-none placeholder:font-sans placeholder:text-zinc-500 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30 disabled:opacity-60"
                                            placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste your full connection code here' })} />
                                        <p id="onboarding-code-help" className="mt-2 text-xs leading-relaxed text-zinc-400">{t('onboarding.connectionStringHelp', { defaultValue: 'In the Admin Dashboard, open Branches → POS and copy this terminal’s full connection code.' })}</p>
                                        <p id="onboarding-key-hint" className="mt-2 text-xs leading-relaxed text-zinc-400">{t('onboarding.rawKeyHint', { defaultValue: 'Use the full connection code, not the API key shown separately.' })}</p>
                                    </div>
                                    <aside aria-label={t('onboarding.previewTitle', { defaultValue: 'Review your connection' })} className="rounded-2xl border border-zinc-700/80 bg-zinc-950/40 p-4">
                                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Monitor className="h-4 w-4 text-yellow-300" aria-hidden="true" />{t('onboarding.previewTitle', { defaultValue: 'Review your connection' })}</div>
                                        {decoded ? (
                                            <motion.div key="decoded" initial={entry} animate={{ opacity: 1, y: 0 }} transition={transition}>
                                                <p className="mt-2 text-xs leading-relaxed text-zinc-400">{t('onboarding.previewHelp', { defaultValue: 'Check the terminal and server before connecting.' })}</p>
                                                <dl className="mt-4 space-y-3">
                                                    <div><dt className="text-xs text-zinc-500">{t('onboarding.terminalLabel', { defaultValue: 'Terminal' })}</dt><dd className="mt-1 break-all font-mono text-sm text-zinc-100">{decoded.terminalId}</dd></div>
                                                    <div><dt className="text-xs text-zinc-500">{t('onboarding.serverLabel', { defaultValue: 'Admin server' })}</dt><dd className="mt-1 break-all text-sm text-zinc-100">{normalizeAdminDashboardUrl(decoded.adminUrl)}</dd></div>
                                                </dl>
                                            </motion.div>
                                        ) : <p className="mt-3 text-sm leading-relaxed text-zinc-500">{t('onboarding.previewPending', { defaultValue: 'Your terminal and server will appear here when you paste a valid code.' })}</p>}
                                        <p aria-live="polite" className="mt-3 text-xs font-medium text-yellow-200">{decoded ? t('onboarding.codeReady', { defaultValue: 'Code ready' }) : ''}</p>
                                    </aside>
                                </div>
                                {inputError && !error && <p id="onboarding-code-invalid" role="status" className="flex items-start gap-2 text-sm text-amber-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{inputError}</p>}
                                {errorContent}
                                {(phase === 'validating' || phase === 'syncing') && (
                                    <div className="rounded-2xl border border-yellow-400/20 bg-yellow-400/5 px-4 py-3" role="status" aria-live="polite">
                                        <p className="text-sm font-medium text-yellow-200">{phase === 'validating' ? t('onboarding.validating', { defaultValue: 'Checking connection…' }) : t('onboarding.syncing', { defaultValue: 'Syncing terminal settings…' })}</p>
                                        <div className="mt-3 flex gap-2" aria-hidden="true">{[1, 2].map((index) => <div key={index} className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-700"><motion.div initial={false} animate={{ scaleX: phase === 'syncing' || index === 1 ? 1 : 0 }} transition={transition} className="h-full origin-left bg-yellow-400" /></div>)}</div>
                                    </div>
                                )}
                                <div className="flex flex-col-reverse gap-3 border-t border-zinc-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
                                    <motion.button type="button" onClick={() => { setError(null); setStep(1); }} disabled={isSubmitting}
                                        whileTap={reduceMotion ? undefined : { scale: 0.98 }} transition={transition}
                                        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm font-medium text-zinc-300 outline-none active:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:opacity-50">
                                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('common.back', { defaultValue: 'Back' })}
                                    </motion.button>
                                    <motion.button type="submit" disabled={isSubmitting} whileTap={reduceMotion ? undefined : { scale: 0.98 }} transition={transition}
                                        className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-yellow-400 text-black font-semibold px-6 py-3 text-sm outline-none active:bg-yellow-300 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:cursor-wait disabled:opacity-60">
                                        {t('onboarding.connect', { defaultValue: 'Connect & Sync' })}<ArrowRight className="h-4 w-4" aria-hidden="true" />
                                    </motion.button>
                                </div>
                                <p className="flex items-start justify-center gap-2 text-xs leading-relaxed text-zinc-500"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('onboarding.privacyHint', { defaultValue: 'Your connection code contains private credentials. Keep it safe.' })}</p>
                            </form>
                        )}

                        {phase === 'complete' && (
                            <section role="status" aria-live="polite" className="flex flex-col items-center py-8 text-center">
                                <motion.div initial={reduceMotion ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={transition} className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-yellow-400/30 bg-yellow-400/15 text-yellow-300"><ShieldCheck className="h-8 w-8" aria-hidden="true" /></motion.div>
                                <h2 className="text-2xl font-semibold">{t('onboarding.ready', { defaultValue: 'Your terminal is ready' })}</h2>
                                <p className="mt-2 text-sm text-zinc-400">{t('onboarding.opening', { defaultValue: 'Opening your POS…' })}</p>
                            </section>
                        )}
                    </motion.div>
                </main>

                <section className="mt-4 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/50">
                    <button type="button" aria-expanded={recoveryOpen} aria-controls="onboarding-recovery" disabled={isSubmitting}
                        onClick={() => setRecoveryOpen((open) => !open)}
                        className="flex min-h-16 w-full items-center justify-between gap-4 rounded-2xl px-5 py-3 text-left outline-none active:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-yellow-400 disabled:opacity-50 sm:px-6">
                        <span><span className="block text-sm font-medium text-zinc-300">{t('onboarding.recoveryTitle', { defaultValue: 'Restore an existing terminal' })}</span><span className="mt-0.5 block text-xs text-zinc-500">{t('onboarding.recoveryHelp', { defaultValue: 'Use local backups and recovery tools.' })}</span></span>
                        <motion.span animate={{ rotate: recoveryOpen ? 180 : 0 }} transition={transition}><ChevronDown className="h-4 w-4 text-zinc-400" aria-hidden="true" /></motion.span>
                    </button>
                    <div id="onboarding-recovery" hidden={!recoveryOpen}>
                        {recoveryOpen && <fieldset disabled={isSubmitting} className="min-w-0 border-t border-zinc-800 p-4 sm:p-6"><RecoveryPanel compact /></fieldset>}
                    </div>
                </section>
            </div>
            <Toaster position="top-center" containerStyle={{ zIndex: 2147483647 }} />
        </div>
    );
};

export default OnboardingPage;

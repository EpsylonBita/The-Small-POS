import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Toaster, toast } from 'react-hot-toast';
import { Check } from 'lucide-react';
import { useI18n } from '../contexts/i18n-context';
import { getBridge } from '../../lib';
import RecoveryPanel from '../components/recovery/RecoveryPanel';
import {
    decodeConnectionString,
    looksLikeRawApiKey,
    normalizeAdminDashboardUrl,
} from '../utils/connection-code';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

type SupportedLanguage = 'en' | 'el' | 'de' | 'fr' | 'it';

const OnboardingPage: React.FC = () => {
    const bridge = getBridge();
    const { t, setLanguage, language } = useI18n();
    const [step, setStep] = useState(1);
    const [connectionString, setConnectionString] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleLanguageSelect = (lang: SupportedLanguage) => {
        setLanguage(lang);
        setStep(2);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setError(null);

        try {
            const input = connectionString.trim();
            if (!input) {
                throw new Error(t('onboarding.validationError', { defaultValue: 'Please enter the connection string' }));
            }

            // Decode the connection string to extract all credentials
            const decoded = decodeConnectionString(input);
            if (!decoded) {
                if (looksLikeRawApiKey(input)) {
                    throw new Error(
                        t('onboarding.rawApiKeyDetected', {
                            defaultValue: 'This looks like a raw API key. Use the full connection code from Admin Dashboard (Regenerate credentials).',
                        })
                    );
                }
                throw new Error(t('onboarding.invalidConnectionString', { defaultValue: 'Invalid connection string. Please copy it again from the admin dashboard.' }));
            }

            // Call the backend to update credentials and sync
            const normalizedAdminUrl = normalizeAdminDashboardUrl(decoded.adminUrl);
            const result = await bridge.settings.updateTerminalCredentials({
                terminalId: decoded.terminalId,
                apiKey: decoded.apiKey,
                adminUrl: normalizedAdminUrl,
                adminDashboardUrl: normalizedAdminUrl,
                supabaseUrl: decoded.supabaseUrl,
                supabaseAnonKey: decoded.supabaseAnonKey,
            });

            if (result && result.success) {
                await bridge.terminalConfig.syncFromAdmin();
                localStorage.setItem('admin_dashboard_url', normalizedAdminUrl);
                localStorage.setItem('pos-terminal-configured', '1');
                toast.success(t('onboarding.success', { defaultValue: 'Terminal configured successfully!' }));
                // A renderer reload is sufficient here because onboarding runs before any
                // authenticated admin session exists, while native restart is now guarded.
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } else {
                throw new Error(result?.error || t('onboarding.configureFailed', { defaultValue: 'Failed to configure terminal' }));
            }
        } catch (err: any) {
            console.error('Onboarding failed:', err);
            setError(err.message || t('onboarding.unexpectedError', { defaultValue: 'An unexpected error occurred' }));
            toast.error(err.message || t('onboarding.configureFailed', { defaultValue: 'Failed to configure terminal' }));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <motion.div
            initial="hidden"
            animate="show"
            variants={pageMotionContainer}
            className="modern-scrollbar flex h-full min-h-0 flex-col items-center overflow-y-auto bg-zinc-900 p-4 text-white"
        >
            {/*
              Centered content that can outgrow short POS windows (setup card + RecoveryPanel).
              `my-auto` centers it when it fits but collapses to 0 on overflow, so the scroll
              container above keeps every element — including the header and first language
              options — reachable. `justify-center` on the scroll root would clip the top instead.
            */}
            <motion.div variants={pageMotionContainer} className="my-auto flex w-full max-w-md flex-col items-center">
            <motion.div variants={pageMotionItem} className="w-full max-w-md bg-zinc-800 rounded-3xl shadow-2xl p-8 border border-zinc-700">

                {/* Header */}
                <motion.div variants={pageMotionItem} className="text-center mb-8">
                    <h1 className="text-3xl font-bold mb-2 text-yellow-300">{t('onboarding.title', { defaultValue: 'POS Terminal Setup' })}</h1>
                    <p className="text-zinc-400">{t('onboarding.step', { defaultValue: 'Step {{current}} of {{total}}', current: step, total: 2 })}</p>
                </motion.div>

                {/* Step 1: Language Selection */}
                {step === 1 && (
                    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="space-y-4">
                        <motion.h2 variants={pageMotionItem} className="text-xl font-semibold text-center mb-6">{t('onboarding.selectLanguage', { defaultValue: 'Select Language' })}</motion.h2>
                        <motion.div variants={pageMotionContainer} className="grid grid-cols-1 gap-4">
                            <motion.button
                                variants={pageMotionItem}
                                onClick={() => handleLanguageSelect('en')}
                                className={`p-4 rounded-2xl border-2 transition-transform duration-150 active:scale-[0.98] flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${language === 'en'
                                    ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200'
                                    : 'border-zinc-600 bg-zinc-900/40 text-zinc-200 active:bg-zinc-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.english', { defaultValue: 'English' })}</span>
                                {language === 'en' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </motion.button>
                            <motion.button
                                variants={pageMotionItem}
                                onClick={() => handleLanguageSelect('el')}
                                className={`p-4 rounded-2xl border-2 transition-transform duration-150 active:scale-[0.98] flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${language === 'el'
                                    ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200'
                                    : 'border-zinc-600 bg-zinc-900/40 text-zinc-200 active:bg-zinc-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.greek', { defaultValue: 'Greek' })}</span>
                                {language === 'el' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </motion.button>
                            <motion.button
                                variants={pageMotionItem}
                                onClick={() => handleLanguageSelect('de')}
                                className={`p-4 rounded-2xl border-2 transition-transform duration-150 active:scale-[0.98] flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${language === 'de'
                                    ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200'
                                    : 'border-zinc-600 bg-zinc-900/40 text-zinc-200 active:bg-zinc-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.german', { defaultValue: 'Deutsch' })}</span>
                                {language === 'de' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </motion.button>
                            <motion.button
                                variants={pageMotionItem}
                                onClick={() => handleLanguageSelect('fr')}
                                className={`p-4 rounded-2xl border-2 transition-transform duration-150 active:scale-[0.98] flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${language === 'fr'
                                    ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200'
                                    : 'border-zinc-600 bg-zinc-900/40 text-zinc-200 active:bg-zinc-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.french', { defaultValue: 'Fran\u00e7ais' })}</span>
                                {language === 'fr' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </motion.button>
                            <motion.button
                                variants={pageMotionItem}
                                onClick={() => handleLanguageSelect('it')}
                                className={`p-4 rounded-2xl border-2 transition-transform duration-150 active:scale-[0.98] flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${language === 'it'
                                    ? 'border-yellow-400 bg-yellow-400/15 text-yellow-200'
                                    : 'border-zinc-600 bg-zinc-900/40 text-zinc-200 active:bg-zinc-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.italian', { defaultValue: 'Italiano' })}</span>
                                {language === 'it' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </motion.button>
                        </motion.div>
                    </motion.div>
                )}

                {/* Step 2: Connection String */}
                {step === 2 && (
                    <motion.form initial="hidden" animate="show" variants={pageMotionContainer} onSubmit={handleSubmit} className="space-y-6">
                        <motion.div variants={pageMotionItem}>
                            <label className="block text-sm font-medium text-zinc-300 mb-2">
                                {t('onboarding.connectionString', { defaultValue: 'Connection String' })}
                            </label>
                            <p className="text-xs text-zinc-400 mb-3">
                                {t('onboarding.connectionStringHelp', { defaultValue: 'Paste the connection code from the Admin Dashboard (Branches -> POS -> Regenerate credentials).' })}
                            </p>
                            <textarea
                                value={connectionString}
                                onChange={(e) => setConnectionString(e.target.value)}
                                className="w-full bg-zinc-900 border border-zinc-600 rounded-2xl px-4 py-3 text-white focus:ring-2 focus:ring-yellow-400 focus:border-transparent outline-none transition-all font-mono text-sm"
                                placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste connection string here...' })}
                                rows={3}
                                required
                            />
                        </motion.div>

                        {error && (
                            <motion.div variants={pageMotionItem} className="p-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-sm">
                                {error}
                            </motion.div>
                        )}

                        <motion.div variants={pageMotionItem} className="flex gap-3 pt-4">
                            <motion.button
                                variants={pageMotionItem}
                                type="button"
                                onClick={() => setStep(1)}
                                className="flex-1 px-4 py-3 rounded-2xl border border-zinc-600 text-zinc-300 bg-zinc-900/40 transition-transform duration-150 active:scale-[0.98] active:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
                                disabled={isSubmitting}
                            >
                                {t('common.back', { defaultValue: 'Back' })}
                            </motion.button>
                            <motion.button
                                variants={pageMotionItem}
                                type="submit"
                                disabled={isSubmitting}
                                className="flex-1 bg-yellow-400 text-black font-semibold py-3 px-4 rounded-2xl transition-transform duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300"
                            >
                                {isSubmitting ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    t('onboarding.connect', { defaultValue: 'Connect & Sync' })
                                )}
                            </motion.button>
                        </motion.div>
                    </motion.form>
                )}
            </motion.div>

            <motion.div variants={pageMotionItem} className="w-full max-w-md mt-4 bg-zinc-800 rounded-3xl shadow-2xl p-6 border border-zinc-700">
                <RecoveryPanel compact />
            </motion.div>
            </motion.div>

            <Toaster
                position="top-center"
                containerStyle={{ zIndex: 2147483647 }}
            />
        </motion.div>
    );
};

export default OnboardingPage;

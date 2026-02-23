import React, { useState } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import { Check } from 'lucide-react';
import { useI18n } from '../contexts/i18n-context';
import { getBridge } from '../../lib';

type SupportedLanguage = 'en' | 'el';

/**
 * Decode the connection string from admin dashboard
 * Format: base64url(JSON({ key, url, tid, surl?, skey? }))
 */
function decodeConnectionString(connectionString: string): {
    apiKey: string;
    adminUrl: string;
    terminalId: string;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
} | null {
    try {
        // Handle base64url encoding (replace - with + and _ with /)
        const base64 = connectionString.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
        const decoded = atob(padded);
        const parsed = JSON.parse(decoded);

        if (parsed.key && parsed.url && parsed.tid) {
            const supabaseUrl = typeof parsed.surl === 'string'
                ? parsed.surl
                : (typeof parsed.supabaseUrl === 'string' ? parsed.supabaseUrl : undefined);
            const supabaseAnonKey = typeof parsed.skey === 'string'
                ? parsed.skey
                : (typeof parsed.supabaseAnonKey === 'string' ? parsed.supabaseAnonKey : undefined);

            return {
                apiKey: parsed.key,
                adminUrl: parsed.url,
                terminalId: parsed.tid,
                supabaseUrl,
                supabaseAnonKey,
            };
        }
        return null;
    } catch (e) {
        console.error('Failed to decode connection string:', e);
        return null;
    }
}

function looksLikeRawApiKey(value: string): boolean {
    const input = value.trim();
    if (!input || input.length < 24 || input.length > 80) {
        return false;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(input)) {
        return false;
    }
    return !input.startsWith('eyJ');
}

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
            const normalizedAdminUrl = decoded.adminUrl.replace(/\/+$/, '').replace(/\/api$/i, '');
            localStorage.setItem('admin_dashboard_url', normalizedAdminUrl);
            const result = await bridge.settings.updateTerminalCredentials({
                terminalId: decoded.terminalId,
                apiKey: decoded.apiKey,
                adminUrl: normalizedAdminUrl,
                adminDashboardUrl: normalizedAdminUrl,
                supabaseUrl: decoded.supabaseUrl,
                supabaseAnonKey: decoded.supabaseAnonKey,
            });

            if (result && result.success) {
                toast.success(t('onboarding.success', { defaultValue: 'Terminal configured successfully!' }));
                // Restart the entire Electron app to reinitialize with new settings
                setTimeout(async () => {
                    try {
                        await bridge.app.restart();
                    } catch (e) {
                        console.error('Failed to restart app, falling back to reload:', e);
                        window.location.reload();
                    }
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
        <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 text-white">
            <div className="w-full max-w-md bg-slate-800 rounded-2xl shadow-2xl p-8 border border-slate-700">

                {/* Header */}
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold mb-2 text-blue-400">{t('onboarding.title', { defaultValue: 'POS Terminal Setup' })}</h1>
                    <p className="text-slate-400">{t('onboarding.step', { defaultValue: 'Step {{current}} of {{total}}', current: step, total: 2 })}</p>
                </div>

                {/* Step 1: Language Selection */}
                {step === 1 && (
                    <div className="space-y-4">
                        <h2 className="text-xl font-semibold text-center mb-6">{t('onboarding.selectLanguage', { defaultValue: 'Select Language' })}</h2>
                        <div className="grid grid-cols-1 gap-4">
                            <button
                                onClick={() => handleLanguageSelect('en')}
                                className={`p-4 rounded-xl border-2 transition-all flex items-center justify-between ${language === 'en'
                                    ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                                    : 'border-slate-600 hover:border-slate-500 hover:bg-slate-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.english', { defaultValue: 'English' })}</span>
                                {language === 'en' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </button>
                            <button
                                onClick={() => handleLanguageSelect('el')}
                                className={`p-4 rounded-xl border-2 transition-all flex items-center justify-between ${language === 'el'
                                    ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                                    : 'border-slate-600 hover:border-slate-500 hover:bg-slate-700'
                                    }`}
                            >
                                <span className="text-lg font-medium">{t('onboarding.language.greek', { defaultValue: 'Greek' })}</span>
                                {language === 'el' && <Check className="w-4 h-4" aria-hidden="true" />}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 2: Connection String */}
                {step === 2 && (
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-2">
                                {t('onboarding.connectionString', { defaultValue: 'Connection String' })}
                            </label>
                            <p className="text-xs text-slate-400 mb-3">
                                {t('onboarding.connectionStringHelp', { defaultValue: 'Paste the connection code from the Admin Dashboard (Branches -> POS -> Regenerate credentials).' })}
                            </p>
                            <textarea
                                value={connectionString}
                                onChange={(e) => setConnectionString(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all font-mono text-sm"
                                placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste connection string here...' })}
                                rows={3}
                                required
                            />
                        </div>

                        {error && (
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-3 pt-4">
                            <button
                                type="button"
                                onClick={() => setStep(1)}
                                className="flex-1 px-4 py-3 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors"
                                disabled={isSubmitting}
                            >
                                {t('common.back', { defaultValue: 'Back' })}
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                            >
                                {isSubmitting ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    t('onboarding.connect', { defaultValue: 'Connect & Sync' })
                                )}
                            </button>
                        </div>
                    </form>
                )}
            </div>

            <Toaster position="top-center" />
        </div>
    );
};

export default OnboardingPage;

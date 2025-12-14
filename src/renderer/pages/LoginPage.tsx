import React, { useState, useEffect } from "react";
import { useI18n } from "../contexts/i18n-context";
import AnimatedBackground from "../components/AnimatedBackground";
import ThemeToggle from "../components/ThemeToggle";
import logoBlack from "../assets/logo-black.png";
import logoWhite from "../assets/logo-white.png";

interface LoginPageProps {
    onLogin: (pin: string) => Promise<boolean>;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
    const { t } = useI18n();
    const [pin, setPin] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState("");
    const [noPinSet, setNoPinSet] = useState(false);
    const [organizationLogo, setOrganizationLogo] = useState<string | null>(null);
    const [organizationName, setOrganizationName] = useState<string | null>(null);
    const [logoError, setLogoError] = useState(false);

    // Load organization branding on mount
    useEffect(() => {
        const loadBranding = async () => {
            try {
                console.log('[LoginPage] Loading organization branding...');
                // Try to get from local settings first (cached)
                const snapshot = await (window as any).electronAPI?.ipcRenderer?.invoke('settings:get-local');
                const cachedLogo = snapshot?.['organization.logo_url'] ?? snapshot?.organization?.logo_url;
                const cachedName = snapshot?.['organization.name'] ?? snapshot?.organization?.name;

                if (cachedLogo) {
                    console.log('[LoginPage] Using cached organization logo:', cachedLogo);
                    setOrganizationLogo(cachedLogo);
                    setOrganizationName(cachedName || null);
                }

                // Also try to get fresh branding from terminal config
                const terminalSettings = await (window as any).electronAPI?.ipcRenderer?.invoke('terminal-config:get-settings');
                const freshLogo = terminalSettings?.organization_branding?.logo_url;
                const freshName = terminalSettings?.organization_branding?.name;

                if (freshLogo) {
                    console.log('[LoginPage] Using fresh organization logo:', freshLogo);
                    setOrganizationLogo(freshLogo);
                    setOrganizationName(freshName || cachedName || null);
                }
            } catch (err) {
                console.warn('[LoginPage] Failed to load organization branding:', err);
            }
        };

        loadBranding();
    }, []);

    // Check if PIN is set on mount and when window gains focus
    useEffect(() => {
        const checkPin = async () => {
            try {
                console.log('[LoginPage] Checking if PIN is configured...');
                const snapshot = await (window as any).electronAPI?.ipcRenderer?.invoke('settings:get-local');
                const simplePin = snapshot?.['staff.simple_pin'] ?? snapshot?.staff?.simple_pin;
                const noPinConfigured = !simplePin || simplePin === '' || simplePin === null;
                console.log('[LoginPage] PIN check result - noPinConfigured:', noPinConfigured);
                setNoPinSet(noPinConfigured);
            } catch (err) {
                console.error('[LoginPage] Failed to check PIN:', err);
                // If we can't check, assume no PIN is set to allow login
                setNoPinSet(true);
            }
        };

        // Check immediately on mount
        checkPin();

        // Also check when window gains focus (user might have returned from logout)
        const handleFocus = () => {
            checkPin();
        };
        window.addEventListener('focus', handleFocus);

        return () => {
            window.removeEventListener('focus', handleFocus);
        };
    }, []);

    const handleNumberClick = (number: string) => {
        if (pin.length < 6) {
            setPin(prev => prev + number);
            setError("");
        }
    };

    const handleClear = () => {
        setPin("");
        setError("");
    };

    const handleBackspace = () => {
        setPin(prev => prev.slice(0, -1));
        setError("");
    };

    const handleLoginClick = async () => {
        if (!pin) {
            setError(t('login.errors.enterPin'));
            return;
        }

        setIsLoading(true);
        setError("");

        try {
            // Add a small delay for better UX
            await new Promise(resolve => setTimeout(resolve, 500));

            const success = await onLogin(pin);
            if (!success) {
                setError(t('login.errors.invalidPin'));
            }
        } catch (err) {
            setError(t('login.errors.loginFailed'));
        } finally {
            setIsLoading(false);
        }
    };

    // Add keyboard support
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isLoading) return;

            // Number keys
            if (e.key >= '0' && e.key <= '9') {
                e.preventDefault();
                handleNumberClick(e.key);
            }
            // Backspace
            else if (e.key === 'Backspace') {
                e.preventDefault();
                handleBackspace();
            }
            // Delete or Escape to clear
            else if (e.key === 'Delete' || e.key === 'Escape') {
                e.preventDefault();
                handleClear();
            }
            // Enter to submit
            else if (e.key === 'Enter' && pin) {
                e.preventDefault();
                handleLoginClick();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [pin, isLoading]);

    const numbers = [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
        [t('login.clear'), '0', '⌫']
    ];

    return (
        <div className="min-h-screen min-h-[100dvh] relative flex items-center justify-center overflow-hidden p-4 sm:p-6">
            <AnimatedBackground />

            <div className="fixed top-3 right-3 sm:top-6 sm:right-6 z-50">
                <ThemeToggle />
            </div>

            <div className="relative z-20 pos-login-card p-4 sm:p-6 md:p-8 pt-16 sm:pt-20 w-full max-w-[95vw] sm:max-w-md mx-auto text-white">
                <div className="pos-login-glow" />

                <div className="absolute inset-x-0 -top-10 sm:-top-14 z-20 flex justify-center">
                    <div className="w-20 h-20 sm:w-28 sm:h-28 rounded-full overflow-hidden shadow-2xl flex items-center justify-center border-2 border-white/30">
                        {organizationLogo && !logoError ? (
                            <img
                                src={organizationLogo}
                                alt={organizationName || 'Organization Logo'}
                                className="w-full h-full object-cover"
                                onError={() => {
                                    console.warn('[LoginPage] Organization logo failed to load:', organizationLogo);
                                    setLogoError(true);
                                }}
                            />
                        ) : (
                            <>
                                <img
                                    src={logoBlack}
                                    alt="The Small"
                                    className="w-full h-full object-contain p-2 bg-white dark:hidden"
                                />
                                <img
                                    src={logoWhite}
                                    alt="The Small"
                                    className="w-full h-full object-contain p-2 bg-gray-900 hidden dark:block"
                                />
                            </>
                        )}
                    </div>
                </div>

                <div className="text-center mb-4 sm:mb-8 relative z-10">
                    <h1 className="text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2">{t('login.title')}</h1>
                    <p className="text-white/80 text-sm sm:text-base">{t('login.subtitle')}</p>
                </div>

                <div className="mb-4 sm:mb-6 relative z-10">
                    <div className="bg-white/10 border border-white/20 rounded-xl p-3 sm:p-4 text-center">
                        <div className="text-xl sm:text-2xl text-white font-mono tracking-widest">
                            {pin.replace(/./g, '●') || '──────'}
                        </div>
                    </div>
                    {error && (
                        <p className="text-red-300 text-xs sm:text-sm mt-2 text-center">{error}</p>
                    )}
                </div>

                <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-6 relative z-10">
                    {numbers.flat().map((item, index) => (
                        <button
                            key={index}
                            onClick={() => {
                                if (item === t('login.clear')) {
                                    handleClear();
                                } else if (item === '⌫') {
                                    handleBackspace();
                                } else {
                                    handleNumberClick(item);
                                }
                            }}
                            disabled={isLoading}
                            className={`
                                h-12 sm:h-14 md:h-16 rounded-xl border transition-all duration-200 font-semibold text-base sm:text-lg
                                touch-manipulation select-none
                                ${item === t('login.clear')
                                    ? 'bg-red-500/20 hover:bg-red-500/30 active:bg-red-500/40 text-red-200 border-red-400/30'
                                    : item === '⌫'
                                        ? 'bg-yellow-500/20 hover:bg-yellow-500/30 active:bg-yellow-500/40 text-yellow-200 border-yellow-400/30'
                                        : 'bg-white/10 hover:bg-white/20 active:bg-white/30 text-white border-white/20'
                                }
                                disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transform
                            `}
                        >
                            {item}
                        </button>
                    ))}
                </div>

                <button
                    onClick={handleLoginClick}
                    disabled={!pin || isLoading}
                    className="w-full bg-blue-600/80 hover:bg-blue-600 active:bg-blue-700 disabled:bg-white/10 text-white px-4 sm:px-6 py-3 sm:py-4 rounded-xl border border-blue-400/40 transition-all duration-300 disabled:cursor-not-allowed font-semibold text-base sm:text-lg touch-manipulation select-none"
                >
                    {isLoading ? t('login.loggingIn') : t('login.loginButton')}
                </button>

                {noPinSet && (
                    <button
                        onClick={async () => {
                            setIsLoading(true);
                            setError("");
                            try {
                                console.log('[LoginPage] ========== ENTER WITHOUT PIN CLICKED ==========');
                                console.log('[LoginPage] Calling onLogin with empty string...');
                                const success = await onLogin(''); // Empty PIN when no PIN is set
                                console.log('[LoginPage] onLogin returned:', success);
                                if (!success) {
                                    console.log('[LoginPage] Login without PIN failed - success was falsy');
                                    setError(t('login.errors.loginFailed', 'Login failed. Please try again.'));
                                } else {
                                    console.log('[LoginPage] Login without PIN succeeded!');
                                }
                            } catch (err) {
                                console.error('[LoginPage] Login without PIN threw error:', err);
                                setError(t('login.errors.loginFailed', 'Login failed. Please try again.'));
                            } finally {
                                setIsLoading(false);
                            }
                        }}
                        disabled={isLoading}
                        className="w-full mt-2 sm:mt-3 bg-green-600/80 hover:bg-green-600 active:bg-green-700 disabled:bg-white/10 text-white px-4 sm:px-6 py-3 sm:py-4 rounded-xl border border-green-400/40 transition-all duration-300 disabled:cursor-not-allowed font-semibold text-base sm:text-lg touch-manipulation select-none"
                    >
                        {isLoading ? t('login.loggingIn', 'Logging in...') : t('login.enterWithoutPin', 'Enter Without PIN')}
                    </button>
                )}

                <div className="mt-4 sm:mt-6 text-center relative z-10">
                    {noPinSet && (
                        <p className="text-yellow-300 text-xs sm:text-sm mb-2">⚠️ {t('login.noPinWarning', 'No PIN set. You can set one in Settings after logging in.')}</p>
                    )}
                    <p className="text-white/70 text-xs sm:text-sm">{t('login.footer')}</p>
                </div>
            </div>
        </div>
    );
}

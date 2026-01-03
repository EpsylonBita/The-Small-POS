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
    const [showPinSetup, setShowPinSetup] = useState(false);
    const [newPin, setNewPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [setupError, setSetupError] = useState("");
    const [appVersion, setAppVersion] = useState<string>("");

    // Load app version on mount
    useEffect(() => {
        const loadVersion = async () => {
            try {
                const version = await (window as any).electronAPI?.ipcRenderer?.invoke('app:get-version');
                if (version) {
                    setAppVersion(version);
                }
            } catch (err) {
                console.warn('[LoginPage] Failed to get app version:', err);
            }
        };
        loadVersion();
    }, []);

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
                // Check for hashed PINs (new secure format)
                const adminPinHash = snapshot?.['staff.admin_pin_hash'] ?? snapshot?.staff?.admin_pin_hash;
                const staffPinHash = snapshot?.['staff.staff_pin_hash'] ?? snapshot?.staff?.staff_pin_hash;
                // Also check legacy simple_pin for backwards compatibility
                const simplePin = snapshot?.['staff.simple_pin'] ?? snapshot?.staff?.simple_pin;
                const noPinConfigured = (!adminPinHash && !staffPinHash) && (!simplePin || simplePin === '');
                console.log('[LoginPage] PIN check result - noPinConfigured:', noPinConfigured, 'hasAdminHash:', !!adminPinHash, 'hasStaffHash:', !!staffPinHash);
                setNoPinSet(noPinConfigured);
            } catch (err) {
                console.error('[LoginPage] Failed to check PIN:', err);
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
            // Don't capture keyboard when PIN setup modal is open
            if (isLoading || showPinSetup) return;

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
    }, [pin, isLoading, showPinSetup]);

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
                    {organizationLogo && !logoError ? (
                        <img
                            src={organizationLogo}
                            alt={organizationName || 'Organization Logo'}
                            className="w-20 h-20 sm:w-28 sm:h-28 object-contain drop-shadow-2xl"
                            onError={() => {
                                console.warn('[LoginPage] Organization logo failed to load:', organizationLogo);
                                setLogoError(true);
                            }}
                        />
                    ) : (
                        <>
                            <img
                                src={logoWhite}
                                alt="The Small"
                                className="w-20 h-20 sm:w-28 sm:h-28 object-contain drop-shadow-2xl dark:hidden"
                            />
                            <img
                                src={logoBlack}
                                alt="The Small"
                                className="w-20 h-20 sm:w-28 sm:h-28 object-contain drop-shadow-2xl hidden dark:block"
                            />
                        </>
                    )}
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
                        onClick={() => setShowPinSetup(true)}
                        disabled={isLoading}
                        className="w-full mt-2 sm:mt-3 bg-green-600/80 hover:bg-green-600 active:bg-green-700 disabled:bg-white/10 text-white px-4 sm:px-6 py-3 sm:py-4 rounded-xl border border-green-400/40 transition-all duration-300 disabled:cursor-not-allowed font-semibold text-base sm:text-lg touch-manipulation select-none"
                    >
                        {t('login.createPin', 'Create PIN')}
                    </button>
                )}

                {/* PIN Setup Modal */}
                {showPinSetup && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                        <div className="bg-gray-800/95 border border-white/20 rounded-2xl p-6 max-w-sm w-full">
                            <h2 className="text-xl font-bold text-white mb-4 text-center">{t('login.setupPin', 'Setup PIN')}</h2>
                            <p className="text-white/70 text-sm mb-4 text-center">{t('login.setupPinDesc', 'Create a 6-digit PIN for admin access')}</p>

                            <div className="space-y-4">
                                <div>
                                    <label className="text-white/80 text-sm block mb-1">{t('login.newPin', 'New PIN (6+ digits)')}</label>
                                    <input
                                        type="password"
                                        value={newPin}
                                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                        placeholder="●●●●●●"
                                        className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white text-center text-xl tracking-widest"
                                    />
                                </div>
                                <div>
                                    <label className="text-white/80 text-sm block mb-1">{t('login.confirmPin', 'Confirm PIN')}</label>
                                    <input
                                        type="password"
                                        value={confirmPin}
                                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                        placeholder="●●●●●●"
                                        className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white text-center text-xl tracking-widest"
                                    />
                                </div>

                                {setupError && (
                                    <p className="text-red-400 text-sm text-center">{setupError}</p>
                                )}

                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={() => {
                                            setShowPinSetup(false);
                                            setNewPin("");
                                            setConfirmPin("");
                                            setSetupError("");
                                        }}
                                        className="flex-1 bg-white/10 hover:bg-white/20 text-white py-3 rounded-lg font-semibold"
                                    >
                                        {t('common.cancel', 'Cancel')}
                                    </button>
                                    <button
                                        onClick={async () => {
                                            setSetupError("");

                                            if (newPin.length < 6) {
                                                setSetupError(t('login.pinTooShort', 'PIN must be at least 6 digits'));
                                                return;
                                            }
                                            if (newPin !== confirmPin) {
                                                setSetupError(t('login.pinMismatch', 'PINs do not match'));
                                                return;
                                            }

                                            try {
                                                setIsLoading(true);
                                                // Call the auth service to setup PIN
                                                const result = await (window as any).electronAPI?.ipcRenderer?.invoke('auth:setup-pin', {
                                                    adminPin: newPin,
                                                    staffPin: newPin // Use same PIN for both initially
                                                });

                                                if (result?.success) {
                                                    console.log('[LoginPage] PIN setup successful');
                                                    setShowPinSetup(false);
                                                    setNewPin("");
                                                    setConfirmPin("");
                                                    setNoPinSet(false);
                                                    // Auto-login with new PIN
                                                    setPin(newPin);
                                                } else {
                                                    setSetupError(result?.error || t('login.setupFailed', 'Failed to setup PIN'));
                                                }
                                            } catch (err) {
                                                console.error('[LoginPage] PIN setup error:', err);
                                                setSetupError(t('login.setupFailed', 'Failed to setup PIN'));
                                            } finally {
                                                setIsLoading(false);
                                            }
                                        }}
                                        disabled={isLoading || newPin.length < 6}
                                        className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white py-3 rounded-lg font-semibold"
                                    >
                                        {isLoading ? '...' : t('login.savePin', 'Save PIN')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="mt-4 sm:mt-6 text-center relative z-10">
                    {noPinSet && (
                        <p className="text-yellow-300 text-xs sm:text-sm mb-2">⚠️ {t('login.noPinWarning', 'No PIN configured. Please create one to continue.')}</p>
                    )}
                    <p className="text-white/70 text-xs sm:text-sm">
                        {t('login.footer')}
                        {appVersion && <span className="ml-2 text-white/50">v{appVersion}</span>}
                    </p>
                </div>
            </div>
        </div>
    );
}

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useI18n } from "../contexts/i18n-context";
import { useTheme } from "../contexts/theme-context";
import AnimatedBackground from "../components/AnimatedBackground";
import ThemeToggle from "../components/ThemeToggle";
import logoBlack from "../assets/logo-black.png";
import logoWhite from "../assets/logo-white.png";
import { AlertTriangle, ArrowRight, Delete as DeleteIcon, Lock, X } from "lucide-react";
import { getBridge, offEvent, onEvent } from "../../lib";
import { pageMotionContainer, pageMotionItem } from "../components/ui/page-motion";
import { extractPrivilegedActionError } from '../utils/privileged-actions';
import {
    LOGIN_PIN_ENTER_KEY_PAUSE_MS,
    LOGIN_PIN_LENGTH_SETTING,
    loginPinAutoSubmitLength,
    loginPinEnterKeyAfterPause,
    loginPinEnterKeyAtOnce,
    readLoginPinLength,
    rememberLoginPinLength,
    type LoginPinSlots,
} from '../utils/loginPinLength';

interface LoginPageProps {
    onLogin: (pin: string) => Promise<boolean>;
    /**
     * Founder 31/10: App sets 'leaving' the moment the PIN is accepted (the card fades while the logo glides
     * down to the middle) and keeps this screen mounted as a layer while the till opens ('opening').
     */
    exitPhase?: 'leaving' | 'opening' | 'returning' | null;
    /** The logo has reached the middle. */
    onLeft?: () => void;
}

// Founder 31/10 («θα ήθελα πιο αργή την κίνηση!!»): an unhurried exit, under two seconds with the zoom.
export const LOGIN_CARD_FADE_S = 0.6;
export const LOGIN_LOGO_GLIDE_S = 0.9;
/** The logo rests in the middle while its ring goes out, before the till opens. */
export const LOGIN_LOGO_HOLD_MS = 300;
// Founder 31/10 («να κάνει ζουμ μέχρι την πέρλα του λογοτύπου»): the opening dives into the gold pearl until
// it fills the window; the till shows through the gold over the dive's last part.
export const LOGIN_PEARL_ZOOM_S = 1.1;
export const LOGIN_TILL_REVEAL_DELAY_S = LOGIN_PEARL_ZOOM_S * 0.7;
export const LOGIN_TILL_REVEAL_S = 0.45;
// Founder 31/10 («και στο Logout το ίδιο animation σε reverse»): signing out runs it backwards. The layer
// fades in over the till as the gold pearl, the logo comes out of its pearl to rest in the middle, then
// glides back to its place on the card as the card fades in.
// Then «σιγά σιγά»: the till fades into gold over a full second and the gold rests before anything moves.
export const LOGIN_RETURN_COVER_S = 1.0;
export const LOGIN_RETURN_HOLD_S = 0.25;
export const LOGIN_RETURN_TOTAL_S =
    LOGIN_RETURN_COVER_S + LOGIN_RETURN_HOLD_S + LOGIN_PEARL_ZOOM_S + LOGIN_LOGO_GLIDE_S;
/** Where the pearl sits in each logo image and how wide it is (measured on the 512 px PNGs). */
const PEARL = {
    dark: { origin: '50% 50%', fraction: 0.238 },
    light: { origin: '50.7% 49.9%', fraction: 0.229 },
} as const;
/** Scale steps of the dive, so it feels like a steady fall into the pearl rather than a late burst. */
const PEARL_ZOOM_TIMES = [0, 0.3, 0.52, 0.7, 0.86, 1];
const PEARL_ZOOM_STEPS = [3, 7, 16, 36];
/** The way back: hold as the pearl, come out of it (the dive's steps reversed), then glide home. */
const RETURN_ZOOM_START_S = LOGIN_RETURN_COVER_S + LOGIN_RETURN_HOLD_S;
const RETURN_TIMES = [
    0,
    RETURN_ZOOM_START_S,
    ...[0.14, 0.3, 0.48, 0.7, 1].map(t => RETURN_ZOOM_START_S + t * LOGIN_PEARL_ZOOM_S),
    LOGIN_RETURN_TOTAL_S,
].map(t => t / LOGIN_RETURN_TOTAL_S);

interface LogoFlight {
    left: number;
    top: number;
    size: number;
    dx: number;
    dy: number;
    /** The scale at which the pearl covers the whole window. */
    pearlScale: number;
}

const isLoginTimeoutError = (error: unknown): boolean =>
    error instanceof Error && /^auth\.login timed out after \d+ms$/.test(error.message);

export default function LoginPage({ onLogin, exitPhase = null, onLeft }: LoginPageProps) {
    const { t } = useI18n();
    const { resolvedTheme } = useTheme();
    const bridge = getBridge();
    const isDark = resolvedTheme === 'dark';
    const [pin, setPin] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState("");
    const [noPinSet, setNoPinSet] = useState(false);
    const [showPinSetup, setShowPinSetup] = useState(false);
    const [pinResetRequired, setPinResetRequired] = useState(false);
    const [newPin, setNewPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [setupError, setSetupError] = useState("");
    const [appVersion, setAppVersion] = useState<string>("");
    const autoSubmitRef = useRef(false);
    // Founder 31/10: no sign-in button. The screen signs in by itself once the PIN has the length the till
    // knows (utils/loginPinLength); a shorter PIN gets a small enter key inside the PIN field.
    const [pinSlots, setPinSlots] = useState<LoginPinSlots>({
        adminConfigured: false,
        staffConfigured: false,
        adminLength: null,
        staffLength: null,
    });
    const [enterKeyAfterPause, setEnterKeyAfterPause] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const [lockedUntil, setLockedUntil] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [shakeCount, setShakeCount] = useState(0);
    const autoSubmitLength = loginPinAutoSubmitLength(pinSlots);
    const isLockedOut = lockedUntil !== null && now < lockedUntil;
    const rootRef = useRef<HTMLDivElement>(null);
    const logoRef = useRef<HTMLImageElement>(null);
    const [logoFlight, setLogoFlight] = useState<LogoFlight | null>(null);
    const isLeaving = exitPhase !== null;

    // Founder 31/10: once the PIN is accepted the logo leaves its place on the card and glides down to the
    // middle of the screen, while the card fades. A copy flies (the card's fade would take the real one).
    useEffect(() => {
        if (!exitPhase) {
            setLogoFlight(null);
            return;
        }
        if (logoFlight) return;
        const logo = logoRef.current?.getBoundingClientRect();
        const root = rootRef.current?.getBoundingClientRect();
        if (!logo || !root || logo.width === 0) {
            onLeft?.();
            return;
        }
        const left = logo.left - root.left;
        const top = logo.top - root.top;
        setLogoFlight({
            left,
            top,
            size: logo.width,
            dx: root.width / 2 - (left + logo.width / 2),
            dy: root.height / 2 - (top + logo.height / 2),
            pearlScale: (Math.hypot(root.width, root.height) / (logo.width * PEARL[isDark ? 'dark' : 'light'].fraction)) * 1.15,
        });
        // Reported on a timer, never on the animation's end (the motion rule: nothing waits for an animation).
        if (exitPhase === 'returning') return;
        const arrived = window.setTimeout(() => onLeft?.(), LOGIN_LOGO_GLIDE_S * 1000 + LOGIN_LOGO_HOLD_MS);
        return () => window.clearTimeout(arrived);
    }, [exitPhase]);

    // Escape-key closes the Setup PIN modal, unless a PIN reset is mandatory.
    useEffect(() => {
        if (!showPinSetup || pinResetRequired) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowPinSetup(false);
                setNewPin("");
                setConfirmPin("");
                setSetupError("");
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [showPinSetup, pinResetRequired]);

    // Load app version on mount
    useEffect(() => {
        const loadVersion = async () => {
            try {
                const result = await bridge.app.getVersion();
                const version = typeof result === 'string' ? result : result?.version;
                if (version) {
                    setAppVersion(version);
                }
            } catch (err) {
                console.warn('[LoginPage] Failed to get app version:', err);
            }
        };
        loadVersion();
    }, []);

    // Check if PIN is set on mount and when window gains focus
    useEffect(() => {
        const checkPin = async () => {
            try {
                console.log('[LoginPage] Checking if PIN is configured...');
                const snapshot = await bridge.settings.getLocal();
                // Check for hashed PINs (new secure format)
                const adminPinHash = snapshot?.['staff.admin_pin_hash'] ?? snapshot?.staff?.admin_pin_hash;
                const staffPinHash = snapshot?.['staff.staff_pin_hash'] ?? snapshot?.staff?.staff_pin_hash;
                const legacySimplePinFromDb = snapshot?.['staff.simple_pin'] ?? snapshot?.staff?.simple_pin;

                // Wave 1 C7: persistent migration-complete marker. Once set,
                // we MUST NOT read `localStorage['staff.simple_pin']` again
                // — the legacy PIN never belongs in renderer-accessible
                // storage and every boot that re-reads it briefly lifts
                // the cleartext back into the JS heap. The flag lives in
                // terminal settings (Rust-side SQLite) so it survives
                // across reboots and browser-storage clears.
                const legacyPinMigratedRaw =
                    snapshot?.['terminal.legacy_pin_migrated'] ??
                    snapshot?.terminal?.legacy_pin_migrated;
                const legacyPinMigrated =
                    legacyPinMigratedRaw === true || legacyPinMigratedRaw === 'true';

                // Guarded: only read localStorage if the migration marker
                // says the cleartext PIN may still be there. Once the
                // marker is set this expression evaluates to '' without
                // touching storage at all.
                const legacySimplePinFromStorage = legacyPinMigrated
                    ? ''
                    : localStorage.getItem('staff.simple_pin') || '';

                let hasPinHashes = !!adminPinHash || !!staffPinHash;
                if (!hasPinHashes) {
                    // Never-migrated path: read legacy sources and attempt
                    // migration. After the attempt (whether it succeeds or
                    // fails), remove the localStorage key FIRST, THEN set
                    // the marker — this ordering ensures we never end up
                    // with {marker=true, localStorage=still-set}, which
                    // would leave the PIN stranded forever.
                    const legacyPin = (legacySimplePinFromDb || legacySimplePinFromStorage || '').toString().trim();
                    if (legacyPin.length >= 4) {
                        try {
                            await bridge.auth.setupPin({
                                staffPin: legacyPin,
                            });
                            await bridge.settings.updateLocal({
                                settingType: 'staff',
                                settings: { simple_pin: '' },
                            });
                            localStorage.removeItem('staff.simple_pin');
                            await bridge.settings.updateLocal({
                                settingType: 'terminal',
                                settings: { legacy_pin_migrated: true },
                            });
                            await rememberLoginPinLength(bridge, ['staff'], legacyPin.length);
                            hasPinHashes = true;
                            console.log('[LoginPage] Migrated legacy simple_pin to hashed staff PIN');
                        } catch (migrationError) {
                            console.warn('[LoginPage] Failed to migrate legacy simple_pin:', migrationError);
                        }
                    }
                } else if (!legacyPinMigrated) {
                    // Already-migrated-but-marker-not-set recovery path:
                    // hashes exist, so setupPin completed on a prior boot,
                    // but either the localStorage removal or the marker
                    // write failed. Idempotently finish the cleanup so
                    // subsequent boots stop reading localStorage.
                    try {
                        localStorage.removeItem('staff.simple_pin');
                        await bridge.settings.updateLocal({
                            settingType: 'terminal',
                            settings: { legacy_pin_migrated: true },
                        });
                        console.log('[LoginPage] Finished pending legacy_pin_migrated cleanup');
                    } catch (cleanupError) {
                        console.warn('[LoginPage] Failed to finalise legacy_pin_migrated:', cleanupError);
                    }
                }

                const noPinConfigured = !hasPinHashes;
                console.log('[LoginPage] PIN check result - noPinConfigured:', noPinConfigured, 'hasAdminHash:', !!adminPinHash, 'hasStaffHash:', !!staffPinHash);
                setNoPinSet(noPinConfigured);
                const readSlotLength = (key: string) =>
                    readLoginPinLength(snapshot?.[`terminal.${key}`] ?? snapshot?.terminal?.[key]);
                setPinSlots({
                    adminConfigured: !!adminPinHash,
                    // A PIN migrated just now is a staff PIN the snapshot does not show yet.
                    staffConfigured: !!staffPinHash || (hasPinHashes && !adminPinHash),
                    adminLength: readSlotLength(LOGIN_PIN_LENGTH_SETTING.admin),
                    staffLength: readSlotLength(LOGIN_PIN_LENGTH_SETTING.staff),
                });

                const rawResetFlag =
                    snapshot?.['terminal.pin_reset_required'] ??
                    snapshot?.terminal?.pin_reset_required ??
                    snapshot?.['terminal.pinResetRequired'] ??
                    snapshot?.terminal?.pinResetRequired;
                const resetRequired = rawResetFlag === true || rawResetFlag === 'true';

                if (resetRequired && hasPinHashes) {
                    // Stale flag — user already has a PIN set. Auto-clear.
                    console.log('[LoginPage] pin_reset_required is true but PIN hashes exist. Auto-clearing stale flag.');
                    setPinResetRequired(false);
                    bridge.settings.updateLocal({
                        settingType: 'terminal',
                        settings: { pin_reset_required: false },
                    }).catch((e: unknown) => console.warn('[LoginPage] Failed to clear stale pin_reset_required:', e));
                } else {
                    setPinResetRequired(resetRequired);
                    if (resetRequired) {
                        setShowPinSetup(true);
                    }
                }
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

        const handleSettingsUpdate = (payload: any) => {
            if (!payload || payload?.type === 'terminal') {
                checkPin();
            }
        };
        onEvent('settings:update', handleSettingsUpdate);

        return () => {
            window.removeEventListener('focus', handleFocus);
            offEvent('settings:update', handleSettingsUpdate);
        };
    }, []);

    const handleNumberClick = (number: string) => {
        if (pin.length < autoSubmitLength) {
            setPin(prev => prev + number);
            setError("");
            setTimedOut(false);
        }
    };

    const handleClear = () => {
        setPin("");
        setError("");
        setTimedOut(false);
    };

    const handleBackspace = () => {
        setPin(prev => prev.slice(0, -1));
        setError("");
        setTimedOut(false);
    };

    const handleLoginClick = async () => {
        if (pinResetRequired) {
            setError(t('login.pinResetRequired', 'PIN reset required. Please set a new PIN.'));
            return;
        }
        if (!pin) {
            setError(t('login.errors.enterPin'));
            return;
        }
        if (isLockedOut) return;

        setIsLoading(true);
        setError("");
        setTimedOut(false);

        try {
            const success = await onLogin(pin);
            if (!success) {
                // Founder 31/10: a wrong PIN shakes the field and empties it, as on Android, so the next
                // try starts clean; the message stays.
                setError(t('login.errors.invalidPin'));
                setPin("");
                setShakeCount(count => count + 1);
            }
        } catch (err) {
            const lockout = extractPrivilegedActionError(err);
            if (lockout?.code === 'AUTH_LOCKED_OUT' && lockout.minutes) {
                // The keypad rests until the lockout ends; the message counts the minutes down.
                setLockedUntil(Date.now() + lockout.minutes * 60_000);
                setNow(Date.now());
                setPin("");
            } else if (isLoginTimeoutError(err)) {
                // The PIN stays; «Δοκιμή ξανά» beside the message sends it again.
                setTimedOut(true);
                setError(t('login.errors.timeout', 'Login took too long. Please try again.'));
            } else {
                setError(t('login.errors.loginFailed'));
            }
        } finally {
            setIsLoading(false);
        }
    };

    // Sign in by itself once the PIN has the length the till knows.
    useEffect(() => {
        if (showPinSetup || isLoading) return;

        if (pin.length === autoSubmitLength && !autoSubmitRef.current) {
            autoSubmitRef.current = true;
            handleLoginClick();
        } else if (pin.length < autoSubmitLength) {
            autoSubmitRef.current = false;
        }
    }, [pin, isLoading, showPinSetup, autoSubmitLength]);

    // A PIN shorter than the till expects may still be complete: offer the enter key after a pause.
    useEffect(() => {
        setEnterKeyAfterPause(false);
        if (isLoading || !loginPinEnterKeyAfterPause(pin.length, pinSlots)) return;
        const timer = window.setTimeout(() => setEnterKeyAfterPause(true), LOGIN_PIN_ENTER_KEY_PAUSE_MS);
        return () => window.clearTimeout(timer);
    }, [pin, pinSlots, isLoading]);

    // Lockout countdown: tick while locked, then let the keypad work again.
    useEffect(() => {
        if (lockedUntil === null) return;
        const timer = window.setInterval(() => {
            const current = Date.now();
            setNow(current);
            if (current >= lockedUntil) {
                setLockedUntil(null);
                setError("");
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, [lockedUntil]);

    // Add keyboard support
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't capture keyboard when PIN setup modal is open
            if (isLoading || showPinSetup || isLockedOut || isLeaving) return;

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
    }, [pin, isLoading, showPinSetup, isLockedOut, isLeaving, autoSubmitLength]);

    const showEnterKey =
        !isLoading &&
        !isLeaving &&
        !isLockedOut &&
        !pinResetRequired &&
        (loginPinEnterKeyAtOnce(pin.length, pinSlots) || enterKeyAfterPause);
    const lockoutMinutes = isLockedOut && lockedUntil !== null ? Math.max(1, Math.ceil((lockedUntil - now) / 60_000)) : 0;
    const shownError = isLockedOut ? t('login.errors.lockedOut', { minutes: lockoutMinutes }) : error;
    const pinPlaceholder = '•'.repeat(6);
    const clearKey = 'clear';
    const backspaceKey = 'backspace';
    const keypadKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', clearKey, '0', backspaceKey];
    const loginLogoSource = isDark ? logoBlack : logoWhite;


    return (
        <motion.div
            ref={rootRef}
            // Back after signing out the screen starts settled, so the logo's home is where it will rest.
            initial={exitPhase === 'returning' ? 'show' : 'hidden'}
            animate="show"
            variants={pageMotionContainer}
            className="relative flex h-full min-h-0 items-center justify-center overflow-hidden p-4 sm:p-6"
        >
            <AnimatedBackground />

            <motion.div
                className="fixed top-3 right-3 sm:top-6 sm:right-6 z-50 flex items-center gap-2"
                animate={{ opacity: isLeaving ? 0 : 1, transition: { duration: 0.25 } }}
            >
                <ThemeToggle />
            </motion.div>

            {logoFlight && (
                <>
                    {/* The logo glides from its place on the card to the middle and grows, glowing gold. */}
                    <motion.img
                        data-testid="login-flying-logo"
                        src={loginLogoSource}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                        className="pointer-events-none absolute z-30 object-contain"
                        style={{
                            left: logoFlight.left,
                            top: logoFlight.top,
                            width: logoFlight.size,
                            height: logoFlight.size,
                            filter: 'drop-shadow(0 0 22px #facc15)',
                            transformOrigin: PEARL[isDark ? 'dark' : 'light'].origin,
                            willChange: 'transform',
                        }}
                        initial={
                            exitPhase === 'returning'
                                ? { x: logoFlight.dx, y: logoFlight.dy, scale: logoFlight.pearlScale }
                                : { x: 0, y: 0, scale: 1 }
                        }
                        animate={
                            exitPhase === 'opening'
                                ? {
                                    x: logoFlight.dx,
                                    y: logoFlight.dy,
                                    scale: [1.35, ...PEARL_ZOOM_STEPS, logoFlight.pearlScale],
                                    // Linear between geometric steps: a steady fall that keeps speeding up.
                                    transition: { duration: LOGIN_PEARL_ZOOM_S, times: PEARL_ZOOM_TIMES, ease: 'linear' },
                                }
                                : exitPhase === 'returning'
                                ? {
                                    x: [...Array(RETURN_TIMES.length - 1).fill(logoFlight.dx), 0],
                                    y: [...Array(RETURN_TIMES.length - 1).fill(logoFlight.dy), 0],
                                    scale: [logoFlight.pearlScale, logoFlight.pearlScale, ...[...PEARL_ZOOM_STEPS].reverse(), 1.35, 1],
                                    transition: {
                                        duration: LOGIN_RETURN_TOTAL_S,
                                        times: RETURN_TIMES,
                                        ease: [...Array(RETURN_TIMES.length - 2).fill('linear'), [0.25, 0.8, 0.3, 1]],
                                    },
                                }
                                : { x: logoFlight.dx, y: logoFlight.dy, scale: 1.35, transition: { duration: LOGIN_LOGO_GLIDE_S, ease: [0.25, 0.8, 0.3, 1] } }
                        }
                    />
                    {/* As it arrives, a gold ring goes out from it (not on the way back). */}
                    {exitPhase !== 'returning' && (
                    <motion.span
                        aria-hidden="true"
                        className={`pointer-events-none absolute z-20 rounded-full border-2 ${isDark ? 'border-[#facc15]' : 'border-[#d97706]'}`}
                        style={{
                            left: logoFlight.left + logoFlight.dx + logoFlight.size / 2 - 80,
                            top: logoFlight.top + logoFlight.dy + logoFlight.size / 2 - 80,
                            width: 160,
                            height: 160,
                        }}
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: [0.6, 2.8], opacity: [0.85, 0], transition: { delay: LOGIN_LOGO_GLIDE_S * 0.8, duration: 1.1, ease: 'easeOut' } }}
                    />
                    )}
                </>
            )}

            <motion.div
                variants={pageMotionItem}
                data-testid="login-card"
                // Founder 31/10: the card fades and settles back a little while the logo leaves it.
                animate={
                    exitPhase === 'returning'
                        ? {
                            // Back after signing out: the card fades in as the logo comes home.
                            opacity: [0, 0, 1],
                            transition: {
                                duration: LOGIN_RETURN_TOTAL_S,
                                times: [0, (LOGIN_RETURN_TOTAL_S - LOGIN_CARD_FADE_S) / LOGIN_RETURN_TOTAL_S, 1],
                                ease: 'easeInOut',
                            },
                        }
                        : isLeaving
                        ? { opacity: 0, scale: 0.96, transition: { duration: LOGIN_CARD_FADE_S, ease: 'easeInOut' } }
                        : undefined
                }
                className={`relative z-20 pos-login-card p-4 sm:p-6 md:p-8 pt-20 sm:pt-24 w-full max-w-[95vw] sm:max-w-md mx-auto ${isDark ? 'text-white' : 'text-slate-900'} ${isLeaving ? 'pointer-events-none' : ''}`}
            >
                <div className="pos-login-glow" />

                <motion.div variants={pageMotionItem} className="absolute inset-x-0 -top-10 sm:-top-14 z-20 flex justify-center">
                    <img
                        ref={logoRef}
                        data-login-logo
                        src={loginLogoSource}
                        alt="The Small"
                        className="w-20 h-20 sm:w-28 sm:h-28 object-contain drop-shadow-2xl"
                        style={{ opacity: logoFlight ? 0 : 1 }}
                    />
                </motion.div>

                <motion.div variants={pageMotionItem} className="text-center mt-2 sm:mt-4 mb-4 sm:mb-8 relative z-10">
                    <h1 className="text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2">{t('login.title')}</h1>
                    <p className={`text-sm sm:text-base ${isDark ? 'text-white/80' : 'text-slate-600'}`}>{t('login.subtitle')}</p>
                </motion.div>

                <motion.div variants={pageMotionItem} className="mb-4 sm:mb-6 relative z-10">
                    {/* Founder 31/10: one dot per digit the till expects, filling as the PIN is typed; they
                        pulse while the PIN is checked. A wrong PIN shakes the field. */}
                    <div
                        key={`pin-field-${shakeCount}`}
                        data-testid="login-pin-field"
                        className={`relative bg-white/10 border border-white/20 rounded-xl p-3 sm:p-4 ${shakeCount > 0 ? 'pos-login-shake' : ''}`}
                    >
                        <div
                            data-testid="login-pin-dots"
                            className={`flex items-center justify-center gap-3 sm:gap-4 py-1.5 ${isLoading ? 'animate-pulse motion-reduce:animate-none' : ''} ${isDark ? 'text-white' : 'text-slate-900'}`}
                            aria-hidden="true"
                        >
                            {Array.from({ length: autoSubmitLength }, (_, index) => (
                                <span
                                    key={index}
                                    className={`h-3.5 w-3.5 rounded-full border-2 border-current transition-colors duration-150 ${index < pin.length ? 'bg-current' : 'bg-transparent opacity-40'}`}
                                />
                            ))}
                        </div>
                        {showEnterKey && (
                            <button
                                type="button"
                                data-testid="login-enter-key"
                                onClick={handleLoginClick}
                                aria-label={t('login.loginButton')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) touch-manipulation select-none active:scale-95 transition-transform duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--pos-s-fg)"
                            >
                                <ArrowRight className="h-5 w-5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                    <p className="sr-only" aria-live="polite">{isLoading ? t('login.loggingIn') : ''}</p>
                    {shownError && (
                        <p className={`text-xs sm:text-sm mt-2 text-center ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
                            {shownError}
                            {timedOut && !isLoading && (
                                <button
                                    type="button"
                                    data-testid="login-retry"
                                    onClick={handleLoginClick}
                                    className="ml-2 font-semibold underline underline-offset-2 touch-manipulation"
                                >
                                    {t('common.retry')}
                                </button>
                            )}
                        </p>
                    )}
                </motion.div>

                <motion.div variants={pageMotionContainer} className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-6 relative z-10">
                    {keypadKeys.map((item) => (
                        <motion.button
                            key={item}
                            variants={pageMotionItem}
                            onClick={() => {
                                if (item === clearKey) {
                                    handleClear();
                                } else if (item === backspaceKey) {
                                    handleBackspace();
                                } else {
                                    handleNumberClick(item);
                                }
                            }}
                            disabled={isLoading || isLockedOut || isLeaving}
                            aria-label={
                                item === clearKey
                                    ? t('login.clear')
                                    : item === backspaceKey
                                        ? t('login.backspace', 'Backspace')
                                        : item
                            }
                            className={`
                                h-12 sm:h-14 md:h-16 rounded-xl border transition-transform duration-150 font-semibold text-base sm:text-lg
                                flex items-center justify-center
                                touch-manipulation select-none
                                bg-white/10 active:bg-(--pos-s-surface-2) ${isDark ? 'border-white/20' : 'border-white/40'}
                                ${item === clearKey
                                    ? 'text-zinc-600 dark:text-zinc-300'
                                    : item === backspaceKey
                                        ? 'text-yellow-700 dark:text-yellow-400'
                                        : isDark ? 'text-white' : 'text-slate-900'}
                                disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transform
                            `}
                        >
                            {/* Founder 31/10: clear and backspace are icons in the same frame as the digits
                                (the word «Καθαρισμός» barely fitted the key). */}
                            {item === clearKey ? (
                                <>
                                    <X size={22} aria-hidden="true" />
                                    <span className="sr-only">{t('login.clear')}</span>
                                </>
                            ) : item === backspaceKey ? (
                                <>
                                    <DeleteIcon size={20} aria-hidden="true" />
                                    <span className="sr-only">{t('login.backspace', 'Backspace')}</span>
                                </>
                            ) : (
                                item
                            )}
                        </motion.button>
                    ))}
                </motion.div>

                {noPinSet && (
                    <motion.button
                        variants={pageMotionItem}
                        onClick={() => setShowPinSetup(true)}
                        disabled={isLoading}
                        className={`w-full mt-2 sm:mt-3 bg-zinc-950 active:bg-black disabled:bg-white/10 text-white dark:bg-white dark:text-black dark:active:bg-zinc-200 px-4 sm:px-6 py-3 sm:py-4 rounded-xl border border-zinc-700 dark:border-white transition-transform duration-150 disabled:cursor-not-allowed font-semibold text-base sm:text-lg touch-manipulation select-none active:scale-[0.98]`}
                    >
                        {t('login.createPin', 'Create PIN')}
                    </motion.button>
                )}

                {/* PIN Setup Modal — portalled to document.body so it escapes
                    the login-card's flow and renders as a proper centered overlay.
                    Backdrop-click and Escape dismiss (unless pinResetRequired, in
                    which case the user MUST set a PIN before proceeding). */}
                {showPinSetup && createPortal(
                    <div
                        className="fixed inset-0 z-1050 flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="setup-pin-title"
                        onMouseDown={(e) => {
                            if (!pinResetRequired && e.target === e.currentTarget) {
                                setShowPinSetup(false);
                                setNewPin("");
                                setConfirmPin("");
                                setSetupError("");
                            }
                        }}
                    >
                        <div className="liquid-glass-modal-backdrop" />
                        <div
                            className="relative liquid-glass-modal-shell w-full px-10 py-8 sm:px-12"
                            style={{ maxWidth: '34rem' }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <div className="flex flex-col items-center mb-6">
                                <Lock className="mb-3 h-8 w-8 text-yellow-600 dark:text-yellow-300" aria-hidden="true" />
                                <h2
                                    id="setup-pin-title"
                                    className="text-2xl font-bold liquid-glass-modal-text text-center"
                                >
                                    {t('login.setupPin', 'Setup PIN')}
                                </h2>
                                <p className="liquid-glass-modal-text-muted text-sm mt-1.5 text-center">
                                    {t('login.setupPinDesc', 'Create a 6-digit PIN for admin access')}
                                </p>
                            </div>

                            <div className="space-y-5 mx-auto" style={{ maxWidth: '22rem' }}>
                                <div>
                                    <label htmlFor="setup-new-pin" className="liquid-glass-modal-text-muted text-sm font-medium block mb-2">
                                        {t('login.newPin', 'New PIN (6 digits)')}
                                    </label>
                                    <input
                                        id="setup-new-pin"
                                        type="password"
                                        inputMode="numeric"
                                        autoComplete="new-password"
                                        value={newPin}
                                        maxLength={6}
                                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                        placeholder={pinPlaceholder}
                                        className="w-full liquid-glass-modal-input text-center text-xl tracking-[0.4em] py-3"
                                        autoFocus
                                    />
                                </div>
                                <div>
                                    <label htmlFor="setup-confirm-pin" className="liquid-glass-modal-text-muted text-sm font-medium block mb-2">
                                        {t('login.confirmPin', 'Confirm PIN')}
                                    </label>
                                    <input
                                        id="setup-confirm-pin"
                                        type="password"
                                        inputMode="numeric"
                                        autoComplete="new-password"
                                        value={confirmPin}
                                        maxLength={6}
                                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                        placeholder={pinPlaceholder}
                                        className="w-full liquid-glass-modal-input text-center text-xl tracking-[0.4em] py-3"
                                    />
                                </div>

                                {setupError && (
                                    <p className="text-red-700 dark:text-red-400 text-sm text-center" role="alert">{setupError}</p>
                                )}

                                <div className={`grid gap-3 pt-2 ${pinResetRequired ? 'grid-cols-1' : 'grid-cols-2'}`}>
                                    {!pinResetRequired && (
                                        <button
                                            onClick={() => {
                                                setShowPinSetup(false);
                                                setNewPin("");
                                                setConfirmPin("");
                                                setSetupError("");
                                            }}
                                            className="min-w-0 whitespace-nowrap liquid-glass-modal-button text-sm sm:text-base"
                                        >
                                            {t('common.cancel', 'Cancel')}
                                        </button>
                                    )}
                                    <button
                                        onClick={async () => {
                                            setSetupError("");

                                            if (newPin.length !== 6) {
                                                setSetupError(t('login.pinTooShort', 'PIN must contain exactly 6 digits'));
                                                return;
                                            }
                                            if (newPin !== confirmPin) {
                                                setSetupError(t('login.pinMismatch', 'PINs do not match'));
                                                return;
                                            }

                                            try {
                                                setIsLoading(true);
                                                // Call the auth service to setup PIN
                                                const result = await bridge.auth.setupPin({
                                                    adminPin: newPin,
                                                    staffPin: newPin // Use same PIN for both initially
                                                });

                                                if (result?.success) {
                                                    console.log('[LoginPage] PIN setup successful');
                                                    // Explicitly clear the flag locally to prevent re-sync from re-asserting it
                                                    bridge.settings.updateLocal({
                                                        settingType: 'terminal',
                                                        settings: { pin_reset_required: false },
                                                    }).catch(() => {});
                                                    setShowPinSetup(false);
                                                    setNewPin("");
                                                    setConfirmPin("");
                                                    setNoPinSet(false);
                                                    setPinResetRequired(false);
                                                    // Both PINs are the new one: keep its digit count so the
                                                    // screen signs in by itself at it.
                                                    void rememberLoginPinLength(bridge, ['admin', 'staff'], newPin.length);
                                                    setPinSlots({
                                                        adminConfigured: true,
                                                        staffConfigured: true,
                                                        adminLength: newPin.length,
                                                        staffLength: newPin.length,
                                                    });
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
                                        disabled={isLoading || newPin.length !== 6}
                                        className="min-w-0 whitespace-nowrap liquid-glass-modal-button pos-modal-primary text-sm sm:text-base"
                                    >
                                        {isLoading ? '...' : t('login.savePin', 'Save PIN')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>,
                    document.body
                )}

                <motion.div variants={pageMotionItem} className="mt-4 sm:mt-6 text-center relative z-10">
                    {pinResetRequired ? (
                        <p className={`text-xs sm:text-sm mb-2 flex items-center justify-center gap-2 ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>{t('login.pinResetRequired', 'PIN reset required. Please set a new PIN to continue.')}</span>
                        </p>
                    ) : noPinSet && (
                        <p className={`text-xs sm:text-sm mb-2 flex items-center justify-center gap-2 ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>{t('login.noPinWarning', 'No PIN configured. Please create one to continue.')}</span>
                        </p>
                    )}
                    <p className={`text-xs sm:text-sm ${isDark ? 'text-white/70' : 'text-slate-600'}`}>
                        {t('login.footer')}
                        {appVersion && <span className={`ml-2 ${isDark ? 'text-white/50' : 'text-slate-600'}`}>v{appVersion}</span>}
                    </p>
                </motion.div>
            </motion.div>
        </motion.div>
    );
}

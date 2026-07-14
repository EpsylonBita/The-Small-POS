import { useEffect, useState, useRef, createElement } from 'react';
import { toast } from 'react-hot-toast';
import { useI18n } from '../contexts/i18n-context';
import { AlertTriangle, Power, RefreshCw, Ban, CheckCircle, Clock } from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../lib';

interface UseAppEventsProps {
    onLogout: () => void;
}

type ShutdownKind = 'shutdown' | 'restart';

interface ShutdownOverlayState {
    active: boolean;
    kind: ShutdownKind | null;
    source: string | null;
    startedAt: string | null;
}

const SHUTDOWN_OVERLAY_TIMEOUT_MS = 12000;
const SHUTDOWN_TOAST_ID = 'pos-app-lifecycle';

// True when this webview is a secondary customer/kitchen display (launched with an
// `externalDisplay` marker in the query string or hash). Mirrors App.tsx's
// resolveExternalDisplayKind detection so operator-only alerts can be suppressed on
// customer-facing screens. Kept dependency-free to avoid a circular import with App.
function isExternalDisplayWebview(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        const fromSearch = new URLSearchParams(window.location.search).get('externalDisplay');
        const hash = window.location.hash || '';
        const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
        const fromHash = new URLSearchParams(hashQuery).get('externalDisplay');
        return Boolean((fromSearch || fromHash || '').trim());
    } catch {
        return false;
    }
}

export function useAppEvents({ onLogout }: UseAppEventsProps) {
    const { t } = useI18n();
    const [shutdownState, setShutdownState] = useState<ShutdownOverlayState>({
        active: false,
        kind: null,
        source: null,
        startedAt: null,
    });

    // Use refs to store latest values to avoid re-subscribing on every render
    const onLogoutRef = useRef(onLogout);
    const tRef = useRef(t);
    const shutdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Update refs when values change
    useEffect(() => {
        onLogoutRef.current = onLogout;
        tRef.current = t;
    }, [onLogout, t]);

    useEffect(() => {
        return () => {
            if (shutdownTimerRef.current) {
                clearTimeout(shutdownTimerRef.current);
                shutdownTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        // Use refs inside handlers to get latest values without re-subscribing
        const handleAppClose = () => {
            // Handle graceful shutdown if needed
        };

        const activateShutdownOverlay = (kind: ShutdownKind, data: any) => {
            const startedAt = new Date().toISOString();
            const source = typeof data?.source === 'string' ? data.source : null;

            setShutdownState({
                active: true,
                kind,
                source,
                startedAt,
            });

            if (shutdownTimerRef.current) {
                clearTimeout(shutdownTimerRef.current);
            }

            shutdownTimerRef.current = setTimeout(() => {
                console.warn('[useAppEvents] Clearing stale shutdown overlay after timeout', {
                    kind,
                    source,
                    startedAt,
                });
                setShutdownState({
                    active: false,
                    kind: null,
                    source: null,
                    startedAt: null,
                });
                toast.dismiss(SHUTDOWN_TOAST_ID);
            }, SHUTDOWN_OVERLAY_TIMEOUT_MS);
        };

        const handleControlCommand = (data: any) => {
            console.log('Control command received:', data);
            toast.error(data.message || tRef.current('system.controlCommand', { type: data.type }), {
                duration: 5000,
                icon: createElement(AlertTriangle, { className: 'w-4 h-4 text-amber-500' }),
            });
        };

        const handleShutdownInitiated = (data: any) => {
            console.log('Shutdown initiated:', data);
            activateShutdownOverlay('shutdown', data);
            toast.error(tRef.current('system.shuttingDown'), {
                duration: Infinity,
                id: SHUTDOWN_TOAST_ID,
                icon: createElement(Power, { className: 'w-4 h-4 text-red-500' }),
            });
        };

        const handleRestartInitiated = (data: any) => {
            console.log('Restart initiated:', data);
            activateShutdownOverlay('restart', data);
            toast.loading(tRef.current('system.restarting'), {
                duration: Infinity,
                id: SHUTDOWN_TOAST_ID,
                icon: createElement(RefreshCw, { className: 'w-4 h-4 text-blue-500 animate-spin' }),
            });
        };

        const handleTerminalDisabled = (data: any) => {
            console.log('Terminal disabled:', data);
            toast.error(tRef.current('system.terminalDisabled'), {
                duration: Infinity,
                icon: createElement(Ban, { className: 'w-4 h-4 text-red-500' }),
            });
        };

        const handleTerminalEnabled = (data: any) => {
            console.log('Terminal enabled:', data);
            toast.success(tRef.current('system.terminalEnabled'), {
                duration: 3000,
                icon: createElement(CheckCircle, { className: 'w-4 h-4 text-green-500' }),
            });
        };

        // Note: Update event handlers (handleUpdateAvailable, handleUpdateDownloaded, handleUpdateError)
        // have been removed - they are now handled exclusively by useAutoUpdater hook
        // to prevent listener conflicts and duplicate notifications

        const handleSessionTimeout = (data: any) => {
            console.warn('Session timeout received:', data);
            toast.error(tRef.current('system.sessionExpired'), {
                duration: 5000,
                icon: createElement(Clock, { className: 'w-4 h-4 text-amber-500' }),
            });
            onLogoutRef.current();
        };

        const handleTerminalSettingsUpdated = (settings: any) => {
            console.log('Terminal settings updated:', settings);
        };

        const handlePrintWorkerAlert = (data: any) => {
            // This backend event broadcasts to every webview. The customer- and
            // kitchen-display webviews render their own <Toaster>, but this is an
            // operator action ("check the print queue" — the queue lives on the main
            // POS), so suppress it on any external-display webview to avoid showing
            // "Printing is failing" on a customer-facing screen.
            if (isExternalDisplayWebview()) return;
            // The backend re-emits this every N consecutive dispatch failures. A
            // stable toast id collapses repeats instead of stacking, and because this
            // is app-level the operator is warned even when the Print Queue panel
            // (buried in Settings) is closed.
            toast.error(
                tRef.current('settings.printQueue.workerAlert', {
                    defaultValue: 'Printing is failing — check the print queue.',
                    count: data?.count,
                }),
                {
                    id: 'print-worker-alert',
                    duration: 8000,
                },
            );
        };

        // List of channels we're subscribing to
        const handlers: Record<string, (data?: any) => void> = {
            'app-close': handleAppClose,
            'control-command-received': handleControlCommand,
            'app-shutdown-initiated': handleShutdownInitiated,
            'app-restart-initiated': handleRestartInitiated,
            'terminal-disabled': handleTerminalDisabled,
            'terminal-enabled': handleTerminalEnabled,
            'session-timeout': handleSessionTimeout,
            'terminal-settings-updated': handleTerminalSettingsUpdated,
            'print-worker-alert': handlePrintWorkerAlert,
        };
        const channels = Object.keys(handlers);

        // Register listeners via typed event bridge
        channels.forEach(channel => {
            onEvent(channel, handlers[channel]);
        });

        return () => {
            // Cleanup listeners on unmount
            channels.forEach(channel => {
                offEvent(channel, handlers[channel]);
            });
        };
    }, []); // Empty deps - only run once on mount

    // #6: proactively warn once at startup if the print queue is globally paused
    // (e.g. the app was restarted while paused). Otherwise every receipt/kitchen
    // ticket silently queues unprinted, with the only indication buried in
    // Settings > Print Queue. Suppressed on external-display webviews.
    useEffect(() => {
        if (isExternalDisplayWebview()) return;
        let cancelled = false;
        void (async () => {
            try {
                const status = (await getBridge().printer.listJobs()) as {
                    success?: boolean;
                    queuePaused?: boolean;
                };
                if (cancelled) return;
                if (status?.success && status?.queuePaused === true) {
                    toast(
                        tRef.current('settings.printQueue.pausedAtStartup', {
                            defaultValue:
                                'The print queue is paused — jobs are queuing but not printing. Resume it in Settings > Print Queue.',
                        }),
                        { id: 'print-queue-paused-startup', icon: '⏸️', duration: 10000 },
                    );
                }
            } catch {
                // Non-fatal: the startup queue-status probe failed.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return {
        isShuttingDown: shutdownState.active,
        shutdownState,
    };
}

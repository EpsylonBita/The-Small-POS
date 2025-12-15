import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { useI18n } from '../contexts/i18n-context';

interface UseAppEventsProps {
    onLogout: () => void;
}

export function useAppEvents({ onLogout }: UseAppEventsProps) {
    const { t } = useI18n();
    const [isShuttingDown, setIsShuttingDown] = useState(false);

    // Use refs to store latest values to avoid re-subscribing on every render
    const onLogoutRef = useRef(onLogout);
    const tRef = useRef(t);

    // Update refs when values change
    useEffect(() => {
        onLogoutRef.current = onLogout;
        tRef.current = t;
    }, [onLogout, t]);

    useEffect(() => {
        if (!window.electron?.ipcRenderer) return;

        // Use refs inside handlers to get latest values without re-subscribing
        const handleAppClose = () => {
            // Handle graceful shutdown if needed
        };

        const handleControlCommand = (data: any) => {
            console.log('Control command received:', data);
            toast.error(data.message || tRef.current('system.controlCommand', { type: data.type }), {
                duration: 5000,
                icon: '⚠️',
            });
        };

        const handleShutdownInitiated = (data: any) => {
            console.log('Shutdown initiated:', data);
            setIsShuttingDown(true);
            toast.error(tRef.current('system.shuttingDown'), {
                duration: Infinity,
                icon: '🔴',
            });
        };

        const handleRestartInitiated = (data: any) => {
            console.log('Restart initiated:', data);
            setIsShuttingDown(true);
            toast.loading(tRef.current('system.restarting'), {
                duration: Infinity,
                icon: '🔄',
            });
        };

        const handleTerminalDisabled = (data: any) => {
            console.log('Terminal disabled:', data);
            toast.error(tRef.current('system.terminalDisabled'), {
                duration: Infinity,
                icon: '🚫',
            });
        };

        const handleTerminalEnabled = (data: any) => {
            console.log('Terminal enabled:', data);
            toast.success(tRef.current('system.terminalEnabled'), {
                duration: 3000,
                icon: '✅',
            });
        };

        // Note: Update event handlers (handleUpdateAvailable, handleUpdateDownloaded, handleUpdateError)
        // have been removed - they are now handled exclusively by useAutoUpdater hook
        // to prevent listener conflicts and duplicate notifications

        const handleSessionTimeout = (data: any) => {
            console.warn('Session timeout received:', data);
            toast.error(tRef.current('system.sessionExpired'), {
                duration: 5000,
                icon: '⏱️',
            });
            onLogoutRef.current();
        };

        const handleTerminalSettingsUpdated = (settings: any) => {
            console.log('Terminal settings updated:', settings);
        };

        // List of channels we're subscribing to
        const channels = [
            'app-close',
            'control-command-received',
            'app-shutdown-initiated',
            'app-restart-initiated',
            'terminal-disabled',
            'terminal-enabled',
            'session-timeout',
            'terminal-settings-updated',
        ];

        // Note: update-available, update-downloaded, update-error are managed by useAutoUpdater
        // We don't clear those listeners here to avoid conflicts

        // Clear any existing listeners first to prevent duplicates
        // But NOT update channels - those are managed by useAutoUpdater
        channels.forEach(channel => {
            try {
                window.electron?.ipcRenderer.removeAllListeners(channel);
            } catch {
                // Ignore errors if channel doesn't exist
            }
        });

        // Register listeners
        window.electron.ipcRenderer.on('app-close', handleAppClose);
        window.electron.ipcRenderer.on('control-command-received', handleControlCommand);
        window.electron.ipcRenderer.on('app-shutdown-initiated', handleShutdownInitiated);
        window.electron.ipcRenderer.on('app-restart-initiated', handleRestartInitiated);
        window.electron.ipcRenderer.on('terminal-disabled', handleTerminalDisabled);
        window.electron.ipcRenderer.on('terminal-enabled', handleTerminalEnabled);
        // Don't register update listeners here - useAutoUpdater handles them
        window.electron.ipcRenderer.on('session-timeout', handleSessionTimeout);
        window.electron.ipcRenderer.on('terminal-settings-updated', handleTerminalSettingsUpdated);

        return () => {
            // Cleanup all listeners on unmount
            channels.forEach(channel => {
                try {
                    window.electron?.ipcRenderer.removeAllListeners(channel);
                } catch {
                    // Ignore errors
                }
            });
        };
    }, []); // Empty deps - only run once on mount

    return { isShuttingDown };
}

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

        const handleUpdateAvailable = (data: any) => {
            console.log('Update available:', data);
            toast.success(tRef.current('system.updateAvailable'), {
                duration: 5000,
                icon: '📥',
            });
        };

        const handleUpdateDownloaded = (data: any) => {
            console.log('Update downloaded:', data);
            toast.success(tRef.current('system.updateDownloaded'), {
                duration: Infinity,
                icon: '✅',
            });
        };

        const handleUpdateError = (data: any) => {
            // Don't show toast for non-critical errors (404 = no releases, network issues)
            const message = data?.message || '';
            const isNonCritical = message.includes('404') || 
                                  message.includes('net::') ||
                                  message.includes('ENOTFOUND');
            
            if (isNonCritical) {
                console.log('Update check failed (non-critical):', message);
                return;
            }
            
            console.error('Update error:', data);
            toast.error(tRef.current('system.updateError'), {
                duration: 5000,
                icon: '❌',
            });
        };

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
            'update-available',
            'update-downloaded',
            'update-error',
            'session-timeout',
            'terminal-settings-updated',
        ];

        // Clear any existing listeners first to prevent duplicates
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
        window.electron.ipcRenderer.on('update-available', handleUpdateAvailable);
        window.electron.ipcRenderer.on('update-downloaded', handleUpdateDownloaded);
        window.electron.ipcRenderer.on('update-error', handleUpdateError);
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

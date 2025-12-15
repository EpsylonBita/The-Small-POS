import { useState, useEffect, useCallback, useRef } from 'react';
import { showUpdateToast } from '../components/updates/UpdateToast';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';

interface UpdateState {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    ready: boolean;
    error: string | null;
    updateInfo: UpdateInfo | null;
    progress: ProgressInfo | undefined;
}

export function useAutoUpdater() {
    const [state, setState] = useState<UpdateState>({
        checking: false,
        available: false,
        downloading: false,
        ready: false,
        error: null,
        updateInfo: null,
        progress: undefined
    });

    const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
        return localStorage.getItem('dismissedUpdateVersion');
    });

    // Current app version
    const [currentVersion, setCurrentVersion] = useState<string>('');

    // State for UpdateDialog visibility (triggered by menu)
    const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

    // Safe access to IPC to prevent errors in non-Electron environments (e.g. basic web view)
    const ipcRenderer = window.electron?.ipcRenderer;
    const electronAPI = (window as any).electronAPI;

    // Timeout ref for checking state
    const checkingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Ref to track if we received a response (to prevent timeout from firing after response)
    const receivedResponseRef = useRef<boolean>(false);

    useEffect(() => {
        if (!ipcRenderer) return;

        // Listen for IPC events
        const listeners = {
            'update-checking': () => {
                console.log('[useAutoUpdater] Received update-checking event');
                receivedResponseRef.current = false; // Reset on new check
                setState(s => ({ ...s, checking: true, error: null }));
                // Set a timeout to prevent stuck "checking" state (30 seconds)
                if (checkingTimeoutRef.current) {
                    clearTimeout(checkingTimeoutRef.current);
                }
                checkingTimeoutRef.current = setTimeout(() => {
                    // Check the ref value at timeout execution time
                    console.log('[useAutoUpdater] Timeout fired, receivedResponse:', receivedResponseRef.current);
                    if (!receivedResponseRef.current) {
                        console.warn('[useAutoUpdater] Check timed out after 30s');
                        setState(s => {
                            // Double-check we're still in checking state
                            if (s.checking && !s.available && !s.error) {
                                return { ...s, checking: false, error: 'Update check timed out. Please try again.' };
                            }
                            return s;
                        });
                    }
                }, 30000);
            },
            'update-available': (info: UpdateInfo) => {
                console.log('[useAutoUpdater] Received update-available event:', info?.version);
                receivedResponseRef.current = true; // Mark that we received a response
                if (checkingTimeoutRef.current) {
                    clearTimeout(checkingTimeoutRef.current);
                    checkingTimeoutRef.current = null;
                }
                setState(s => ({ ...s, checking: false, available: true, updateInfo: info, error: null }));
            },
            'update-not-available': (info: UpdateInfo) => {
                console.log('[useAutoUpdater] Received update-not-available event');
                receivedResponseRef.current = true; // Mark that we received a response
                if (checkingTimeoutRef.current) {
                    clearTimeout(checkingTimeoutRef.current);
                    checkingTimeoutRef.current = null;
                }
                setState(s => ({ ...s, checking: false, available: false, updateInfo: info, error: null }));
            },
            'download-progress': (progress: ProgressInfo) => {
                setState(s => ({ ...s, downloading: true, progress }));
            },
            'update-downloaded': (info: UpdateInfo) => {
                console.log('[useAutoUpdater] Received update-downloaded event');
                setState(s => ({ ...s, downloading: false, ready: true, updateInfo: info, progress: undefined }));
            },
            'update-error': (err: any) => {
                console.log('[useAutoUpdater] Received update-error event:', err);
                receivedResponseRef.current = true; // Mark that we received a response
                if (checkingTimeoutRef.current) {
                    clearTimeout(checkingTimeoutRef.current);
                    checkingTimeoutRef.current = null;
                }
                const message = err?.message || 'Update failed';
                // Don't treat 404 (no releases) or network errors as real errors
                const isNonCritical = message.includes('404') || 
                                      message.includes('net::') ||
                                      message.includes('ENOTFOUND');
                if (isNonCritical) {
                    // Just reset checking state, don't set error
                    setState(s => ({ ...s, checking: false, downloading: false }));
                } else {
                    setState(s => ({ ...s, checking: false, downloading: false, error: message }));
                }
            }
        };

        // Register listeners
        console.log('[useAutoUpdater] Registering listeners, ipcRenderer:', !!ipcRenderer);
        Object.entries(listeners).forEach(([channel, listener]) => {
            console.log(`[useAutoUpdater] Registering listener for ${channel}`);
            ipcRenderer.on(channel, listener);
        });

        // Initialize state check (optional, but good)
        ipcRenderer.invoke('update:get-state').then((initialState: Partial<UpdateState>) => {
            // Sync initial state if needed, but usually events drive this.
        }).catch(() => { });

        return () => {
            // Cleanup
            Object.entries(listeners).forEach(([channel, listener]) => {
                ipcRenderer.removeListener(channel, listener);
            });
            // Clear timeout on cleanup
            if (checkingTimeoutRef.current) {
                clearTimeout(checkingTimeoutRef.current);
                checkingTimeoutRef.current = null;
            }
        };
    }, [ipcRenderer]);

    // Fetch current app version on mount
    useEffect(() => {
        if (!ipcRenderer) return;
        ipcRenderer.invoke('system:get-info').then((info: any) => {
            if (info?.version) {
                setCurrentVersion(info.version);
            }
        }).catch(() => {
            // Fallback: try to get from package.json or env
            setCurrentVersion('Unknown');
        });
    }, [ipcRenderer]);

    // Listen for menu-triggered update check event (Requirements: 2.1)
    useEffect(() => {
        if (!electronAPI?.onMenuCheckForUpdates) return;

        const cleanup = electronAPI.onMenuCheckForUpdates(() => {
            // Open the update dialog and trigger a check
            setUpdateDialogOpen(true);
            // Trigger update check
            ipcRenderer?.invoke('update:check');
        });

        return cleanup;
    }, [electronAPI, ipcRenderer]);

    // Track if we've shown a notification for the current version to avoid duplicates
    const notifiedVersionRef = useRef<string | null>(null);

    // Show background update notification when update is available (Requirements: 3.3, 3.4)
    useEffect(() => {
        // Only show notification if:
        // 1. Update is available
        // 2. Not currently downloading or ready
        // 3. Dialog is not already open (user triggered check)
        // 4. Version hasn't been dismissed
        // 5. We haven't already notified for this version in this session
        if (
            state.available &&
            !state.downloading &&
            !state.ready &&
            !updateDialogOpen &&
            state.updateInfo?.version &&
            state.updateInfo.version !== dismissedVersion &&
            state.updateInfo.version !== notifiedVersionRef.current
        ) {
            // Mark this version as notified
            notifiedVersionRef.current = state.updateInfo.version;

            // Show clickable toast notification that opens UpdateDialog when clicked
            showUpdateToast(state.updateInfo.version, () => {
                setUpdateDialogOpen(true);
            });
        }
    }, [state.available, state.downloading, state.ready, state.updateInfo?.version, dismissedVersion, updateDialogOpen]);

    const checkForUpdates = useCallback(() => {
        ipcRenderer?.invoke('update:check');
    }, [ipcRenderer]);

    const downloadUpdate = useCallback(() => {
        ipcRenderer?.invoke('update:download');
    }, [ipcRenderer]);

    const cancelDownload = useCallback(() => {
        ipcRenderer?.invoke('update:cancel-download');
    }, [ipcRenderer]);

    const installUpdate = useCallback(() => {
        console.log('[useAutoUpdater] installUpdate called, state.ready:', state.ready);
        ipcRenderer?.invoke('update:install').then(() => {
            console.log('[useAutoUpdater] update:install invoke completed');
        }).catch((err: any) => {
            console.error('[useAutoUpdater] update:install error:', err);
        });
    }, [ipcRenderer, state.ready]);

    const dismissUpdate = useCallback(() => {
        if (state.updateInfo?.version) {
            setDismissedVersion(state.updateInfo.version);
            localStorage.setItem('dismissedUpdateVersion', state.updateInfo.version);
        }
        // Also close the dialog when dismissing
        setUpdateDialogOpen(false);
    }, [state.updateInfo]);

    // Derived state: should we show the notification?
    const showNotification = state.available && !state.downloading && !state.ready && (state.updateInfo?.version !== dismissedVersion);

    // Open the update dialog (for manual triggering)
    const openUpdateDialog = useCallback(() => {
        setUpdateDialogOpen(true);
        // Trigger update check when opening dialog
        ipcRenderer?.invoke('update:check');
    }, [ipcRenderer]);

    // Close the update dialog
    const closeUpdateDialog = useCallback(() => {
        setUpdateDialogOpen(false);
    }, []);

    return {
        ...state,
        currentVersion,
        checkForUpdates,
        downloadUpdate,
        cancelDownload,
        installUpdate,
        dismissUpdate,
        showNotification,
        // Dialog state and handlers (Requirements: 2.1)
        updateDialogOpen,
        openUpdateDialog,
        closeUpdateDialog,
    };
}


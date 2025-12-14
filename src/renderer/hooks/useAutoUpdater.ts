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

    // State for UpdateDialog visibility (triggered by menu)
    const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

    // Safe access to IPC to prevent errors in non-Electron environments (e.g. basic web view)
    const ipcRenderer = window.electron?.ipcRenderer;
    const electronAPI = (window as any).electronAPI;

    useEffect(() => {
        if (!ipcRenderer) return;

        // Listen for IPC events
        const listeners = {
            'update-checking': () => setState(s => ({ ...s, checking: true, error: null })),
            'update-available': (info: UpdateInfo) => {
                setState(s => ({ ...s, checking: false, available: true, updateInfo: info, error: null }));
            },
            'update-not-available': (info: UpdateInfo) => {
                setState(s => ({ ...s, checking: false, available: false, updateInfo: info, error: null }));
            },
            'download-progress': (progress: ProgressInfo) => {
                setState(s => ({ ...s, downloading: true, progress }));
            },
            'update-downloaded': (info: UpdateInfo) => {
                setState(s => ({ ...s, downloading: false, ready: true, updateInfo: info, progress: undefined }));
            },
            'update-error': (err: any) => {
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
        Object.entries(listeners).forEach(([channel, listener]) => {
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
        };
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
        ipcRenderer?.invoke('update:install');
    }, [ipcRenderer]);

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


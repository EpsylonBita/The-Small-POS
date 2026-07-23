import { useState, useEffect, useCallback, useRef } from 'react';
import { showUpdateToast } from '../components/updates/UpdateToast';
import type { UpdateInfo, ProgressInfo } from '../../lib/update-contracts';
import { getBridge, offEvent, onEvent } from '../../lib';
import type { UpdateState as BridgeUpdateState } from '../../lib';

const AUTO_UPDATE_STARTUP_DELAY_MS = 5_000;
const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UpdateState {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  ready: boolean;
  error: string | null;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | undefined;
  downloadedVersion: string | null;
  downloadedArtifactPath: string | null;
  installPending: boolean;
  installingVersion: string | null;
}

function normalizeProgress(
  progress: BridgeUpdateState['progress'] | ProgressInfo | undefined
): ProgressInfo | undefined {
  if (progress === undefined || progress === null) {
    return undefined;
  }

  if (typeof progress === 'number') {
    return {
      percent: progress,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      delta: 0,
    } as ProgressInfo;
  }

  return progress as ProgressInfo;
}

function normalizeUpdateInfo(
  updateInfo: BridgeUpdateState['updateInfo'],
  downloadedVersion?: string | null
): UpdateInfo | null {
  if (
    updateInfo &&
    typeof updateInfo === 'object' &&
    typeof (updateInfo as UpdateInfo).version === 'string' &&
    (updateInfo as UpdateInfo).version.trim()
  ) {
    return updateInfo as UpdateInfo;
  }

  if (downloadedVersion && downloadedVersion.trim()) {
    return {
      version: downloadedVersion.trim(),
    };
  }

  return null;
}

export function useAutoUpdater() {
  const bridge = getBridge();
  const [state, setState] = useState<UpdateState>({
    checking: false,
    available: false,
    downloading: false,
    ready: false,
    error: null,
    updateInfo: null,
    progress: undefined,
    downloadedVersion: null,
    downloadedArtifactPath: null,
    installPending: false,
    installingVersion: null,
  });
  const [hydrated, setHydrated] = useState(false);

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    return localStorage.getItem('dismissedUpdateVersion');
  });

  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  const checkingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const receivedResponseRef = useRef<boolean>(false);
  const notifiedVersionRef = useRef<string | null>(null);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  useEffect(() => {
    const listeners = {
      'update-checking': () => {
        receivedResponseRef.current = false;
        setState((s) => ({
          ...s,
          checking: true,
          error: null,
          available: false,
          ready: false,
          installPending: false,
          installingVersion: null,
          progress: undefined,
        }));

        if (checkingTimeoutRef.current) {
          clearTimeout(checkingTimeoutRef.current);
        }
        checkingTimeoutRef.current = setTimeout(() => {
          if (!receivedResponseRef.current) {
            setState((s) => {
              if (s.checking && !s.available && !s.error) {
                return {
                  ...s,
                  checking: false,
                  error: 'Update check timed out. Please try again.',
                };
              }
              return s;
            });
          }
        }, 30000);
      },
      'update-available': (info: UpdateInfo) => {
        receivedResponseRef.current = true;
        if (checkingTimeoutRef.current) {
          clearTimeout(checkingTimeoutRef.current);
          checkingTimeoutRef.current = null;
        }
        setState((s) => ({
          ...s,
          checking: false,
          available: true,
          downloading: false,
          ready: false,
          error: null,
          updateInfo: info,
          progress: undefined,
          installPending: false,
          installingVersion: null,
        }));
      },
      'update-not-available': (info: UpdateInfo) => {
        receivedResponseRef.current = true;
        if (checkingTimeoutRef.current) {
          clearTimeout(checkingTimeoutRef.current);
          checkingTimeoutRef.current = null;
        }
        setState((s) => ({
          ...s,
          checking: false,
          available: false,
          downloading: false,
          ready: false,
          error: null,
          updateInfo: info?.version ? info : null,
          progress: undefined,
          installPending: false,
          installingVersion: null,
        }));
      },
      'download-progress': (progress: ProgressInfo) => {
        setState((s) => ({
          ...s,
          downloading: true,
          ready: false,
          progress: normalizeProgress(progress),
          installPending: false,
          installingVersion: null,
        }));
      },
      'update-downloaded': (info: UpdateInfo) => {
        setState((s) => ({
          ...s,
          downloading: false,
          ready: true,
          available: true,
          error: null,
          updateInfo: info,
          downloadedVersion: info?.version ?? s.downloadedVersion,
          progress: undefined,
          installPending: false,
          installingVersion: null,
        }));
        if (info?.version) {
          setUpdateDialogOpen(true);
        }
      },
      'update-error': (err: any) => {
        receivedResponseRef.current = true;
        if (checkingTimeoutRef.current) {
          clearTimeout(checkingTimeoutRef.current);
          checkingTimeoutRef.current = null;
        }
        const message = err?.message || 'Update failed';
        const isNonCritical =
          message.includes('404') ||
          message.includes('net::') ||
          message.includes('ENOTFOUND');

        if (isNonCritical) {
          setState((s) => ({
            ...s,
            checking: false,
            downloading: false,
          }));
          return;
        }

        setState((s) => ({
          ...s,
          checking: false,
          downloading: false,
          error: message,
        }));
      },
    } as const;

    // Wave 11 L: `onEvent` is now generic. The heterogeneous-listener
    // record passes a different callback type per channel; we widen the
    // listener to `(data: any) => void` at the iteration site so the
    // union doesn't try to infer a single T from all branches.
    Object.entries(listeners).forEach(([channel, listener]) => {
      onEvent(channel, listener as (data: any) => void);
    });

    bridge.updates
      .getState()
      .then((initialState: Partial<BridgeUpdateState>) => {
        const downloadedVersion = initialState.downloadedVersion ?? null;
        const installPending = initialState.installPending ?? false;
        const installingVersion = initialState.installingVersion ?? null;
        const updateInfo = normalizeUpdateInfo(initialState.updateInfo ?? null, downloadedVersion);

        setState((s) => ({
          ...s,
          checking: initialState.checking ?? s.checking,
          available: initialState.available ?? s.available,
          downloading: initialState.downloading ?? s.downloading,
          ready: initialState.ready ?? s.ready,
          error: initialState.error ?? s.error,
          updateInfo,
          progress:
            initialState.progress !== undefined
              ? normalizeProgress(initialState.progress)
              : s.progress,
          downloadedVersion,
          downloadedArtifactPath: initialState.downloadedArtifactPath ?? null,
          installPending,
          installingVersion,
        }));

        if ((initialState.ready ?? false) && !installPending && updateInfo?.version) {
          setUpdateDialogOpen(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setHydrated(true);
      });

    return () => {
      Object.entries(listeners).forEach(([channel, listener]) => {
        offEvent(channel, listener as (data: any) => void);
      });
      if (checkingTimeoutRef.current) {
        clearTimeout(checkingTimeoutRef.current);
        checkingTimeoutRef.current = null;
      }
    };
  }, [bridge.updates]);

  useEffect(() => {
    bridge.system
      .getInfo()
      .then((info: any) => {
        if (info?.version) {
          setCurrentVersion(info.version);
        }
      })
      .catch(() => {
        setCurrentVersion('Unknown');
      });
  }, [bridge.system]);

  useEffect(() => {
    if (!hydrated) return;

    const runAutomaticCheck = () => {
      const latestState = latestStateRef.current;
      if (
        latestState.checking ||
        latestState.available ||
        latestState.downloading ||
        latestState.ready ||
        latestState.installPending ||
        latestState.installingVersion
      ) {
        return;
      }

      void bridge.updates.check();
    };

    const startupTimer = window.setTimeout(
      runAutomaticCheck,
      AUTO_UPDATE_STARTUP_DELAY_MS,
    );
    const periodicTimer = window.setInterval(
      runAutomaticCheck,
      AUTO_UPDATE_INTERVAL_MS,
    );

    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(periodicTimer);
    };
  }, [bridge.updates, hydrated]);

  useEffect(() => {
    const handleMenuCheckForUpdates = () => {
      setUpdateDialogOpen(true);
      if (!state.ready && !state.installPending && !state.installingVersion && !state.downloading) {
        void bridge.updates.check();
      }
    };

    onEvent('menu:check-for-updates', handleMenuCheckForUpdates);

    return () => {
      offEvent('menu:check-for-updates', handleMenuCheckForUpdates);
    };
  }, [bridge.updates, state.downloading, state.installPending, state.installingVersion, state.ready]);

  useEffect(() => {
    if (
      state.available &&
      !state.downloading &&
      !state.ready &&
      !updateDialogOpen &&
      state.updateInfo?.version &&
      state.updateInfo.version !== dismissedVersion &&
      state.updateInfo.version !== notifiedVersionRef.current
    ) {
      notifiedVersionRef.current = state.updateInfo.version;
      showUpdateToast(state.updateInfo.version, () => {
        setUpdateDialogOpen(true);
      });
    }
  }, [
    state.available,
    state.downloading,
    state.ready,
    state.updateInfo?.version,
    dismissedVersion,
    updateDialogOpen,
  ]);

  const checkForUpdates = useCallback(() => {
    void bridge.updates.check();
  }, [bridge.updates]);

  const downloadUpdate = useCallback(() => {
    void bridge.updates.download();
  }, [bridge.updates]);

  const cancelDownload = useCallback(() => {
    void bridge.updates.cancelDownload();
  }, [bridge.updates]);

  const installUpdate = useCallback(() => {
    bridge.updates.install().catch((err: any) => {
      console.error('[useAutoUpdater] update:install error:', err);
    });
  }, [bridge.updates]);

  const scheduleInstallOnNextRestart = useCallback(() => {
    bridge.updates
      .scheduleInstall()
      .then(() => {
        setState((s) => ({
          ...s,
          installPending: true,
          error: null,
        }));
        setUpdateDialogOpen(false);
      })
      .catch((err: any) => {
        console.error('[useAutoUpdater] update:schedule-install error:', err);
      });
  }, [bridge.updates]);

  const dismissUpdate = useCallback(() => {
    if (state.updateInfo?.version) {
      setDismissedVersion(state.updateInfo.version);
      localStorage.setItem('dismissedUpdateVersion', state.updateInfo.version);
    }
    setUpdateDialogOpen(false);
  }, [state.updateInfo]);

  const showNotification =
    state.available &&
    !state.downloading &&
    !state.ready &&
    state.updateInfo?.version !== dismissedVersion;

  const openUpdateDialog = useCallback(() => {
    setUpdateDialogOpen(true);
    if (!state.ready && !state.installPending && !state.installingVersion && !state.downloading) {
      void bridge.updates.check();
    }
  }, [
    bridge.updates,
    state.downloading,
    state.installPending,
    state.installingVersion,
    state.ready,
  ]);

  const closeUpdateDialog = useCallback(() => {
    setUpdateDialogOpen(false);
  }, []);

  return {
    ...state,
    hydrated,
    currentVersion,
    checkForUpdates,
    downloadUpdate,
    cancelDownload,
    installUpdate,
    scheduleInstallOnNextRestart,
    dismissUpdate,
    showNotification,
    updateDialogOpen,
    openUpdateDialog,
    closeUpdateDialog,
  };
}

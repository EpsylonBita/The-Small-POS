import React, { useState, useEffect, useMemo } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { Toaster, toast } from "react-hot-toast";
import { AlertTriangle } from "lucide-react";
import { ThemeProvider } from "./contexts/theme-context";
import { ShiftProvider, useShift } from "./contexts/shift-context";
import { I18nProvider, useI18n } from "./contexts/i18n-context";
import { ModuleProvider } from "./contexts/module-context";
import { BarcodeScannerProvider } from "./contexts/barcode-scanner-context";
import RefactoredMainLayout from "./components/RefactoredMainLayout";
import NewOrderPage from "./pages/NewOrderPage";
import LoginPage from "./pages/LoginPage";
import OnboardingPage from "./pages/OnboardingPage";
import { ErrorBoundary } from "./components/error/ErrorBoundary";
import { ScreenCaptureControlRequestModal } from "./components/ScreenCaptureControlRequestModal";
import { SyncNotificationManager } from "./components/SyncNotificationManager";
import { SyncStatusIndicator } from "./components/SyncStatusIndicator";

import { ActivityTracker } from "./services/ActivityTracker";
import { screenCaptureHandler } from "./services/ScreenCaptureHandler";
import AnimatedBackground from "./components/AnimatedBackground";
import ThemeToggle from "./components/ThemeToggle";
import CustomTitleBar from "./components/CustomTitleBar";
import FullscreenAwareLayout from "./components/FullscreenAwareLayout";
import { useBlockerRegistration } from "./hooks/useBlockerRegistration";
import { useFreezeWatchdog } from "./hooks/useFreezeWatchdog";
import { useMenuVersionPolling } from "./hooks/useMenuVersionPolling";
import { useAppEvents } from "./hooks/useAppEvents";
import { useCallerIdNotifications } from "./hooks/useCallerIdNotifications";
import { useWindowState } from "./hooks/useWindowState";
import { environment, updateAdminUrlFromSettings } from "../config/environment";
import { setSupabaseContext } from "../shared/supabase-config";
import { emitCompatEvent, getBridge, isBrowser, offEvent, onEvent } from "../lib";
import {
  getCachedTerminalCredentials,
  clearTerminalCredentialCache,
  refreshTerminalCredentialCache,
  updateTerminalCredentialCache,
} from "./services/terminal-credentials";
import { subscribeToAdminOrderDeletedEvents } from "./services/OrderDeleteRealtimeService";
import { DesktopRealtimeManager } from "./services/RealtimeManager";
import {
  emitParityQueueStatus,
  REALTIME_STATUS_EVENT,
  runParitySyncCycle,
} from "./services/ParitySyncCoordinator";
import { useOrderStore } from "./hooks/useOrderStore";

const INVALID_SESSION_IDENTITY_VALUES = new Set([
  '',
  'default-branch',
  'default-terminal',
  'default-organization',
  'default-org',
]);

const STARTUP_IPC_TIMEOUT_MS = 4000;
const STARTUP_CONFIG_SYNC_TIMEOUT_MS = 2500;
const CONFIGURED_TERMINAL_HINT_KEY = 'pos-terminal-configured';

function normalizeSessionIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (INVALID_SESSION_IDENTITY_VALUES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function getConfiguredTerminalHint(): boolean {
  try {
    return localStorage.getItem(CONFIGURED_TERMINAL_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function setConfiguredTerminalHint(configured: boolean): void {
  try {
    if (configured) {
      localStorage.setItem(CONFIGURED_TERMINAL_HINT_KEY, '1');
    } else {
      localStorage.removeItem(CONFIGURED_TERMINAL_HINT_KEY);
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function inferConfiguredTerminalFallback(): boolean {
  const cached = getCachedTerminalCredentials();
  try {
    return (
      getConfiguredTerminalHint() ||
      Boolean(localStorage.getItem('pos-user')) ||
      Boolean(localStorage.getItem('admin_dashboard_url')) ||
      Boolean(cached.terminalId || cached.branchId || cached.organizationId)
    );
  } catch {
    return Boolean(
      getConfiguredTerminalHint() ||
        cached.terminalId ||
        cached.branchId ||
        cached.organizationId,
    );
  }
}

async function withStartupTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = STARTUP_IPC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveSessionOrganizationId(userData: any): Promise<string | undefined> {
  const userOrganizationId = normalizeSessionIdentityValue(userData?.organizationId);
  if (userOrganizationId) {
    return userOrganizationId;
  }

  const cached = getCachedTerminalCredentials();
  const cachedOrganizationId = normalizeSessionIdentityValue(cached.organizationId);
  if (cachedOrganizationId) {
    return cachedOrganizationId;
  }

  try {
    const refreshed = await withStartupTimeout(
      refreshTerminalCredentialCache(),
      'refreshTerminalCredentialCache',
    );
    const refreshedOrganizationId = normalizeSessionIdentityValue(refreshed.organizationId);
    if (refreshedOrganizationId) {
      return refreshedOrganizationId;
    }
  } catch (error) {
    console.warn('[App] Failed to refresh terminal identity for session shaping:', error);
  }

  return undefined;
}

async function enrichSessionUserWithOrganization(userData: any): Promise<any> {
  if (!userData || typeof userData !== 'object') {
    return userData;
  }

  const organizationId = await resolveSessionOrganizationId(userData);
  if (!organizationId) {
    return userData;
  }

  updateTerminalCredentialCache({ organizationId });
  return {
    ...userData,
    organizationId,
  };
}

function ConfigGuard({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const bridge = getBridge();
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);

  // Check configuration status on startup and sync credentials to in-memory cache
  useEffect(() => {
    const checkConfiguration = async () => {
      if (isBrowser()) {
        // Non-native environment (dev), assume configured
        setIsConfigured(true);
        return;
      }
      try {
        // Yield to the event loop so React can flush the initial render
        // before we start invoking Tauri IPC commands.
        await new Promise(resolve => setTimeout(resolve, 0));
        
        // Update admin URL from stored settings (for API calls)
        await withStartupTimeout(
          updateAdminUrlFromSettings(),
          'updateAdminUrlFromSettings',
          STARTUP_CONFIG_SYNC_TIMEOUT_MS,
        ).catch((error) => {
          console.warn('[ConfigGuard] Admin URL refresh skipped:', error);
        });

        console.log('[ConfigGuard] Calling settings:is-configured...');
        const result: any = await withStartupTimeout(
          bridge.settings.isConfigured(),
          'settings.isConfigured',
        );
        console.log('[ConfigGuard] settings:is-configured result:', JSON.stringify(result));
        
        // Handle both direct response and handleIPCError wrapped response
        // Direct: { configured: boolean, reason: string }
        // Wrapped: { success: boolean, data: { configured: boolean, reason: string } }
        const configData = result?.data ?? result;
        const isConfiguredValue = configData?.configured ?? false;
        const reason = configData?.reason ?? 'Unknown';
        
        console.log('[ConfigGuard] Parsed: configured=%s, reason=%s', isConfiguredValue, reason);
        setConfiguredTerminalHint(Boolean(isConfiguredValue));
        setIsConfigured(isConfiguredValue);
        console.log('[ConfigGuard] isConfigured set to:', isConfiguredValue);

        // If not configured, ensure we clear any stale session data
        if (!isConfiguredValue) {
          console.log('Terminal not configured, clearing stale session data');
          localStorage.removeItem("pos-user");
          clearTerminalCredentialCache();
        } else {
          // If configured, sync terminal identity from the main process to the
          // in-memory cache. Native admin fetches handle POS authentication.
          try {
            const [settings, config] = await Promise.all([
              withStartupTimeout(
                bridge.terminalConfig.getSettings(),
                'terminalConfig.getSettings',
                STARTUP_CONFIG_SYNC_TIMEOUT_MS,
              ).catch(() => null),
              withStartupTimeout(
                bridge.terminalConfig.getFullConfig(),
                'terminalConfig.getFullConfig',
                STARTUP_CONFIG_SYNC_TIMEOUT_MS,
              ).catch(() => null),
            ]);

            const terminalId =
              config?.terminal_id ||
              settings?.['terminal.terminal_id'] ||
              settings?.terminal?.terminal_id;
            const branchId =
              config?.branch_id ||
              settings?.['terminal.branch_id'] ||
              settings?.terminal?.branch_id;
            const organizationId =
              config?.organization_id ||
              settings?.['terminal.organization_id'] ||
              settings?.terminal?.organization_id;

            console.log('[ConfigGuard] Resolved credentials:', {
              terminalId: terminalId || '(not found)',
              branchId: branchId || '(not found)',
              organizationId: organizationId || '(not found)',
            });

            if (terminalId) {
              updateTerminalCredentialCache({ terminalId });
            }
            if (branchId) {
              updateTerminalCredentialCache({ branchId });
            }
            if (organizationId) {
              updateTerminalCredentialCache({ organizationId });
            }
            setSupabaseContext({
              terminalId: terminalId || undefined,
              organizationId: organizationId || undefined,
              branchId: branchId || undefined,
              clientType: 'desktop',
            });
          } catch (syncErr) {
            console.warn('[ConfigGuard] Failed to sync terminal credentials cache:', syncErr);
          }
        }
      } catch (err) {
        console.error('Failed to check configuration:', err);
        const fallbackConfigured = inferConfiguredTerminalFallback();
        console.warn('[ConfigGuard] Falling back to cached configured hint:', {
          fallbackConfigured,
        });
        setConfiguredTerminalHint(fallbackConfigured);
        setIsConfigured(fallbackConfigured);
      }
    };

    checkConfiguration();
  }, [bridge.settings, bridge.terminalConfig]);

  // Listen for app:reset event (remote wipe / terminal deleted)
  useEffect(() => {
    const handleReset = (data: any) => {
      const reason = data?.reason || 'unknown';
      console.log('App reset triggered:', reason);

      // Clear all local storage
      localStorage.removeItem("pos-user");
      localStorage.removeItem("terminal_id");
      localStorage.removeItem("branch_id");
      localStorage.removeItem("organization_id");
      localStorage.removeItem("admin_dashboard_url");
      clearTerminalCredentialCache();
      setConfiguredTerminalHint(false);

      setIsConfigured(false);

      // Show appropriate message based on reason
      let message = t('system.remoteWipe') || 'Terminal has been reset remotely';
      if (reason === 'terminal_deleted') {
        message = t('system.terminalDeleted') || 'This terminal has been deleted from the admin dashboard. Please reconfigure.';
      } else if (reason === 'admin_command') {
        message = t('system.factoryReset') || 'Factory reset command received from admin dashboard.';
      }

      toast.error(message, {
        duration: 8000,
        icon: <AlertTriangle className="w-4 h-4 text-amber-500" />,
      });
    };

    onEvent('app:reset', handleReset);

    return () => {
      offEvent('app:reset', handleReset);
    };
  }, [t]);

  // Listen for terminal-credentials-updated event (after onboarding)
  // This stores terminal identity in in-memory cache for immediate renderer access
  useEffect(() => {
    const handleCredentialsUpdated = (data: {
      terminalId?: string;
      terminal_id?: string;
      branchId?: string;
      branch_id?: string;
      organizationId?: string;
      organization_id?: string;
      config?: {
        terminal_id?: string;
        branch_id?: string;
        organization_id?: string;
      };
    }) => {
      console.log('[ConfigGuard] Terminal credentials updated');
      const terminalId = data?.terminalId || data?.terminal_id || data?.config?.terminal_id;
      const branchId = data?.branchId || data?.branch_id || data?.config?.branch_id;
      const organizationId =
        data?.organizationId || data?.organization_id || data?.config?.organization_id;

      if (terminalId) {
        updateTerminalCredentialCache({ terminalId });
      }
      if (branchId) {
        updateTerminalCredentialCache({ branchId });
      }
      if (organizationId) {
        updateTerminalCredentialCache({ organizationId });
      }
      setConfiguredTerminalHint(true);
      const cached = getCachedTerminalCredentials();
      setSupabaseContext({
        terminalId: cached.terminalId || undefined,
        organizationId: cached.organizationId || undefined,
        branchId: cached.branchId || undefined,
        clientType: 'desktop',
      });
    };

    onEvent('terminal-credentials-updated', handleCredentialsUpdated);

    return () => {
      offEvent('terminal-credentials-updated', handleCredentialsUpdated);
    };
  }, []);

  // Listen for terminal-config-updated event (from heartbeat)
  // This updates in-memory terminal identity from server heartbeat
  useEffect(() => {
    const handleConfigUpdated = (data: {
      terminal_id?: string;
      branch_id?: string;
      organization_id?: string;
    }) => {
      console.log('[ConfigGuard] Terminal config updated from heartbeat:', data);
      if (data?.terminal_id) {
        updateTerminalCredentialCache({ terminalId: data.terminal_id });
      }
      if (data?.branch_id) {
        updateTerminalCredentialCache({ branchId: data.branch_id });
      }
      if (data?.organization_id) {
        updateTerminalCredentialCache({ organizationId: data.organization_id });
      }
      setConfiguredTerminalHint(true);
      const cached = getCachedTerminalCredentials();
      setSupabaseContext({
        terminalId: cached.terminalId || undefined,
        organizationId: cached.organizationId || undefined,
        branchId: cached.branchId || undefined,
        clientType: 'desktop',
      });
    };

    onEvent('terminal-config-updated', handleConfigUpdated);

    return () => {
      offEvent('terminal-config-updated', handleConfigUpdated);
    };
  }, []);

  useEffect(() => {
    if (isConfigured !== true || isBrowser()) {
      return;
    }

    let disposed = false;
    let unsubscribeRealtimeDeletes: (() => void) | null = null;
    let subscriptionGeneration = 0;

    const resubscribeToDeletedOrders = async () => {
      const generation = ++subscriptionGeneration;

      unsubscribeRealtimeDeletes?.();
      unsubscribeRealtimeDeletes = null;

      try {
        const credentials = await withStartupTimeout(
          refreshTerminalCredentialCache(),
          'refreshTerminalCredentialCache',
        );
        const terminalId = normalizeSessionIdentityValue(credentials.terminalId);
        const organizationId = normalizeSessionIdentityValue(credentials.organizationId);
        const branchId = normalizeSessionIdentityValue(credentials.branchId);

        if (disposed || generation !== subscriptionGeneration) {
          return;
        }

        if (!terminalId || !organizationId) {
          console.warn('[ConfigGuard] Skipping delete realtime subscription due to incomplete terminal identity', {
            terminalId: terminalId || null,
            organizationId: organizationId || null,
            branchId: branchId || null,
          });
          return;
        }

        unsubscribeRealtimeDeletes = subscribeToAdminOrderDeletedEvents({
          terminalId,
          organizationId,
          branchId: branchId || undefined,
        });
      } catch (error) {
        if (!disposed && generation === subscriptionGeneration) {
          console.warn('[ConfigGuard] Failed to start delete realtime subscription:', error);
        }
      }
    };

    const handleTerminalIdentityChanged = () => {
      void resubscribeToDeletedOrders();
    };

    void resubscribeToDeletedOrders();
    onEvent('terminal-credentials-updated', handleTerminalIdentityChanged);
    onEvent('terminal-config-updated', handleTerminalIdentityChanged);

    return () => {
      disposed = true;
      subscriptionGeneration += 1;
      offEvent('terminal-credentials-updated', handleTerminalIdentityChanged);
      offEvent('terminal-config-updated', handleTerminalIdentityChanged);
      unsubscribeRealtimeDeletes?.();
    };
  }, [isConfigured]);

  if (isConfigured === null) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-t-transparent border-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-800">{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  if (isConfigured === false) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <FullscreenAwareLayout>
            <OnboardingPage />
          </FullscreenAwareLayout>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  return <>{children}</>;
}

import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { UpdateDialog } from "./components/UpdateDialog";
import type { UpdateStatus } from "./components/UpdateDialog";

/**
 * Helper function to convert autoUpdater state to UpdateStatus
 * Used by UpdateDialog to display the correct state
 */
function getUpdateStatus(autoUpdater: ReturnType<typeof useAutoUpdater>): UpdateStatus {
  if (autoUpdater.checking) return 'checking';
  if (autoUpdater.downloading) return 'downloading';
  if (autoUpdater.ready && autoUpdater.updateInfo?.version) return 'downloaded';
  if (autoUpdater.error) return 'error';
  if (autoUpdater.available) return 'available';
  return 'not-available';
}

function AppContent() {
  const { t } = useI18n();
  const bridge = getBridge();
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { setStaff } = useShift();
  const autoUpdater = useAutoUpdater();
  const windowState = useWindowState();
  const silentRefreshOrders = useOrderStore((state) => state.silentRefresh);

  // Auto-check for updates on app startup
  useEffect(() => {
    if (environment.NODE_ENV === 'development') {
      return;
    }

    if (
      !autoUpdater.hydrated ||
      autoUpdater.ready ||
      autoUpdater.installPending ||
      !!autoUpdater.installingVersion
    ) {
      return;
    }

    // Wait 5 seconds after app starts to check for updates
    const checkUpdatesTimer = setTimeout(() => {
      console.log('[App] Auto-checking for updates on startup');
      autoUpdater.checkForUpdates();
    }, 5000);

    return () => clearTimeout(checkUpdatesTimer);
  }, [
    autoUpdater.checkForUpdates,
    autoUpdater.hydrated,
    autoUpdater.installPending,
    autoUpdater.installingVersion,
    autoUpdater.ready,
  ]);

  // Use custom hook for app events
  const { isShuttingDown, shutdownState } = useAppEvents({
    onLogout: () => {
      localStorage.removeItem("pos-user");
      setUser(null);
      // Do NOT clear shift on session timeout to preserve active shift per EOD policy
    }
  });
  const shutdownBlockerMetadata = useMemo(
    () => ({
      kind: shutdownState.kind,
      source: shutdownState.source,
      startedAt: shutdownState.startedAt,
    }),
    [shutdownState.kind, shutdownState.source, shutdownState.startedAt],
  );

  useBlockerRegistration({
    id: 'app-shutdown-overlay',
    label: 'App shutdown overlay',
    source: 'app-shell',
    active: isShuttingDown,
    metadata: shutdownBlockerMetadata,
  });

  useFreezeWatchdog({
    enabled: !!user && !isLoading,
    windowState,
  });

  // Start background menu version polling once a user session exists
  useMenuVersionPolling({ enabled: !!user });

  // Caller ID notifications (gated by module availability inside the hook)
  useCallerIdNotifications();

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const syncPollingState = () => {
      const shouldPoll =
        Boolean(user) &&
        document.visibilityState === 'visible' &&
        navigator.onLine;
      screenCaptureHandler.setIdleSessionPollingEnabled(shouldPoll);
    };

    syncPollingState();

    const handleVisibilityChange = () => {
      syncPollingState();
    };
    const handleOnline = () => {
      syncPollingState();
    };
    const handleOffline = () => {
      syncPollingState();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      screenCaptureHandler.setIdleSessionPollingEnabled(false);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [user]);

  useEffect(() => {
    if (!user || isBrowser()) {
      return;
    }

    let disposed = false;

    const refreshParityQueueStatus = async () => {
      await emitParityQueueStatus();
    };

    const syncNow = async () => {
      try {
        await runParitySyncCycle();
      } catch (error) {
        if (!disposed) {
          console.warn('[App] Parity sync cycle failed:', error);
        }
      }
    };

    void refreshParityQueueStatus();
    void syncNow();

    const intervalId = window.setInterval(() => {
      void refreshParityQueueStatus();
    }, 15000);

    const handleOnline = () => {
      void syncNow();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
    };
  }, [user]);

  useEffect(() => {
    if (!user || isBrowser()) {
      return;
    }

    let disposed = false;
    let manager: DesktopRealtimeManager | null = null;

    const startRealtime = async () => {
      try {
        const credentials = await refreshTerminalCredentialCache();
        const organizationId = normalizeSessionIdentityValue(credentials.organizationId);

        if (
          disposed ||
          !organizationId ||
          !environment.SUPABASE_URL ||
          !environment.SUPABASE_ANON_KEY
        ) {
          return;
        }

        manager = new DesktopRealtimeManager({
          supabaseUrl: environment.SUPABASE_URL,
          supabaseKey: environment.SUPABASE_ANON_KEY,
          organizationId,
          onOrderChange: () => {
            void silentRefreshOrders().catch(() => {});
          },
          onConfigChange: async (payload) => {
            try {
              await bridge.terminalConfig.syncFromAdmin();
            } catch (error) {
              console.warn('[App] Failed to refresh terminal config after realtime update:', error);
            }
            emitCompatEvent('terminal-config-updated', payload.new || payload.old || payload);
          },
          onModuleChange: (payload) => {
            emitCompatEvent('modules:refresh-needed', payload.new || payload.old || payload);
          },
          onFullSyncNeeded: () => {
            void runParitySyncCycle()
              .then(() => silentRefreshOrders().catch(() => {}))
              .catch((error) => {
                console.warn('[App] Full realtime sync failed:', error);
              });
          },
          onApiKeyRevoked: () => {
            toast.error(
              t('sync.messages.syncFailed', 'Sync failed') +
                ': realtime credentials were rejected.',
            );
          },
          onStatusChange: (status) => {
            emitCompatEvent(REALTIME_STATUS_EVENT, { status });
          },
        });

        emitCompatEvent(REALTIME_STATUS_EVENT, {
          status: manager.getConnectionStatus(),
        });
        await manager.connect();
      } catch (error) {
        if (!disposed) {
          console.warn('[App] Failed to start realtime manager:', error);
          emitCompatEvent(REALTIME_STATUS_EVENT, { status: 'error' });
        }
      }
    };

    void startRealtime();

    return () => {
      disposed = true;
      manager?.disconnect();
      emitCompatEvent(REALTIME_STATUS_EVENT, { status: 'disconnected' });
    };
  }, [bridge.terminalConfig, silentRefreshOrders, t, user]);

  // Track hash route for unauthenticated screens so UI updates without reload
  const [hash, setHash] = useState<string>(typeof window !== 'undefined' ? window.location.hash : '');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Check if user is logged in on app start and validate session
  useEffect(() => {
    let disposed = false;

    const validateAndRestoreSession = async () => {
      try {
        const storedUser = localStorage.getItem("pos-user");
        if (storedUser) {
          try {
            const parsedUser = JSON.parse(storedUser);

            // For local simple PIN login, just restore the session directly
            // (no database validation needed)
            if (parsedUser.staffId === 'local-simple-pin') {
              const enrichedUser = await withStartupTimeout(
                enrichSessionUserWithOrganization(parsedUser),
                'enrichSessionUserWithOrganization',
              ).catch(() => parsedUser);
              if (!disposed) {
                localStorage.setItem('pos-user', JSON.stringify(enrichedUser));
                setUser(enrichedUser);
                setStaff({
                  staffId: enrichedUser.staffId,
                  databaseStaffId: enrichedUser.databaseStaffId,
                  name: enrichedUser.staffName,
                  role: enrichedUser.role?.name || 'staff',
                  branchId: enrichedUser.branchId || 'default-branch',
                  terminalId: enrichedUser.terminalId || 'default-terminal',
                  organizationId: normalizeSessionIdentityValue(enrichedUser.organizationId),
                });
                try {
                  ActivityTracker.setContext({
                    staffId: enrichedUser.staffId,
                    sessionId: enrichedUser.sessionId,
                    terminalId: enrichedUser.terminalId,
                    branchId: enrichedUser.branchId,
                  })
                } catch { }
              }
              return;
            }

            // For database-backed staff, validate session with main process
            if (!isBrowser()) {
              try {
                const validationResult = await withStartupTimeout(
                  bridge.staffAuth.validateSession(),
                  'staffAuth.validateSession',
                );

                if (!validationResult || !validationResult.valid) {
                  console.warn('Session invalid or expired, clearing local storage');
                  localStorage.removeItem("pos-user");
                  return;
                }
              } catch (err) {
                console.error('Session validation failed:', err);
                localStorage.removeItem("pos-user");
                return;
              }
            }

            const enrichedUser = await withStartupTimeout(
              enrichSessionUserWithOrganization(parsedUser),
              'enrichSessionUserWithOrganization',
            ).catch(() => parsedUser);
            if (!disposed) {
              localStorage.setItem('pos-user', JSON.stringify(enrichedUser));
              setUser(enrichedUser);
              // Set staff in shift context
              setStaff({
                staffId: enrichedUser.staffId,
                databaseStaffId: enrichedUser.databaseStaffId,
                name: enrichedUser.staffName,
                role: enrichedUser.role?.name || 'staff',
                branchId: enrichedUser.branchId || 'default-branch',
                terminalId: enrichedUser.terminalId || 'default-terminal',
                organizationId: normalizeSessionIdentityValue(enrichedUser.organizationId),
              });
              try {
                ActivityTracker.setContext({
                  staffId: enrichedUser.staffId,
                  sessionId: enrichedUser.sessionId,
                  terminalId: enrichedUser.terminalId,
                  branchId: enrichedUser.branchId,
                })
              } catch { }
            }

          } catch (err) {
            console.error('Error restoring session:', err);
            localStorage.removeItem("pos-user");
          }
        }
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    };

    void validateAndRestoreSession();

    return () => {
      disposed = true;
    };
  }, []);

  // Periodic session validation - DISABLED
  // Users should only be logged out when they explicitly log out, not due to
  // periodic validation failures which can occur due to network issues, database
  // connectivity, or RPC timeouts.
  //
  // Original code logged users out every 5 minutes if validation failed,
  // causing unwanted automatic logouts during normal operation.
  //
  // If session validation is needed in the future, consider:
  // 1. Only logging out on explicit "session terminated" responses
  // 2. Adding retry logic before logging out
  // 3. Distinguishing between network errors and actual session expiry

  // Login function that uses secure IPC
  const handleLogin = async (pin: string) => {
    console.log('[App.tsx handleLogin] Called with PIN:', pin === '' ? '(empty)' : '(provided)');
    try {
      // Call secure auth login through typed bridge
      console.log('[App.tsx handleLogin] Invoking auth:login bridge method...');
      const result: any = await withStartupTimeout(
        bridge.auth.login(pin),
        'auth.login',
        6000,
      );
      console.log('[App.tsx handleLogin] IPC result:', JSON.stringify(result, null, 2));

      // Handle both response structures:
      // Old: { success, user }
      // New (handleIPCError wrapper): { success, data: { user } }
      const userData = result?.user || result?.data?.user;

      if (result && result.success && userData) {
        console.log('[App.tsx handleLogin] Login successful, setting user state...');

        const enrichedUser = await withStartupTimeout(
          enrichSessionUserWithOrganization(userData),
          'enrichSessionUserWithOrganization(login)',
          2500,
        ).catch((error) => {
          console.warn('[App.tsx handleLogin] Proceeding without enriched organization context:', error);
          return userData;
        });

        // Store session in localStorage
        localStorage.setItem('pos-user', JSON.stringify(enrichedUser));

        // Update React state
        setUser(enrichedUser);
        setStaff({
          staffId: enrichedUser.staffId,
          databaseStaffId: enrichedUser.databaseStaffId,
          name: enrichedUser.staffName,
          role: enrichedUser.role?.name || 'staff',
          branchId: enrichedUser.branchId || 'default-branch',
          terminalId: enrichedUser.terminalId || 'default-terminal',
          organizationId: normalizeSessionIdentityValue(enrichedUser.organizationId),
        });

        // Initialize activity tracking
        try {
          ActivityTracker.setContext({
            staffId: enrichedUser.staffId,
            sessionId: enrichedUser.sessionId,
            terminalId: enrichedUser.terminalId,
            branchId: enrichedUser.branchId,
          });
        } catch { }

        console.log('[App.tsx handleLogin] Returning true (success)');
        return true;
      }

      console.log('[App.tsx handleLogin] Result did not have success+user, returning false');
      console.log('[App.tsx handleLogin] result.success:', result?.success, 'result.user:', !!result?.user, 'result.data?.user:', !!result?.data?.user, 'error:', result?.error);
      return false;
    } catch (err) {
      console.error('[App.tsx handleLogin] Exception caught:', err);
      return false;
    }
  };

  // Logout function
  const handleLogout = async () => {
    try {
      await bridge.auth.logout();
    } catch (e) {
      console.error('auth:logout failed', e);
    }
    localStorage.removeItem("pos-user");
    setUser(null);
    // Do NOT clear shift context on explicit logout; EOD Z Report will clear shifts
  };

  // Show loading spinner during initial check
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-t-transparent border-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-800">{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  // Show login when no user
  if (!user) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <FullscreenAwareLayout
            updateAvailable={autoUpdater.available && !autoUpdater.downloading && !autoUpdater.ready}
            onCheckForUpdates={autoUpdater.openUpdateDialog}
          >
            <LoginPage onLogin={handleLogin} />
          </FullscreenAwareLayout>
          <Toaster
            position="top-center"
            toastOptions={{
              duration: 3000,
              style: { background: '#111827', color: '#fff' },
              success: { iconTheme: { primary: '#10B981', secondary: 'white' } },
              error: { iconTheme: { primary: '#EF4444', secondary: 'white' } },
            }}
          />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  // Show main POS interface if logged in
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <FullscreenAwareLayout
            updateAvailable={autoUpdater.available && !autoUpdater.downloading && !autoUpdater.ready}
            onCheckForUpdates={autoUpdater.openUpdateDialog}
          >
            {/* Shutdown/Restart Overlay */}
            {isShuttingDown && (
              <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                <div className="bg-white/10 backdrop-blur-md rounded-3xl p-8 shadow-2xl border border-white/30 text-center">
                  <div className="w-16 h-16 border-4 border-t-transparent border-white rounded-full animate-spin mx-auto mb-4"></div>
                  <h2 className="text-2xl font-bold text-white mb-2">{t('app.pleaseWait')}</h2>
                  <p className="text-white/80">
                    {shutdownState.kind === 'restart'
                      ? t('system.restarting')
                      : t('app.shuttingDownMessage')}
                  </p>
                </div>
              </div>
            )}

            {/* Sync Status Indicator - Heart Icon in Top-Left (after navbar) */}
            <div className="fixed top-12 left-20 z-40">
              <SyncStatusIndicator />
            </div>



            <Routes>
              <Route path="/" element={<RefactoredMainLayout onLogout={handleLogout} />} />
              <Route path="/dashboard" element={<RefactoredMainLayout onLogout={handleLogout} />} />
              <Route path="/new-order" element={<NewOrderPage />} />
              <Route path="*" element={<RefactoredMainLayout onLogout={handleLogout} />} />
            </Routes>

            <ScreenCaptureControlRequestModal />

            {/* Sync Notification Manager */}
            <SyncNotificationManager
              onSettingsUpdate={(settings) => {
                console.log('Settings updated:', settings);
                // Handle settings updates here
              }}
              onStaffPermissionUpdate={(update) => {
                console.log('Staff permission updated:', update);
                // Handle staff permission updates here
              }}
              onHardwareConfigUpdate={(update) => {
                console.log('Hardware config updated:', update);
                // Handle hardware config updates here
              }}
            />

            <Toaster
              position="top-center"
              toastOptions={{
                duration: 3000,
                style: {
                  background: "rgba(0, 0, 0, 0.8)",
                  color: "#fff",
                  borderRadius: "12px",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                },
              }}
            />

            {/* Unified Update Dialog - handles all update states */}
            <UpdateDialog
              isOpen={autoUpdater.updateDialogOpen}
              onClose={autoUpdater.closeUpdateDialog}
              status={getUpdateStatus(autoUpdater)}
              updateInfo={autoUpdater.updateInfo}
              progress={autoUpdater.progress}
              error={autoUpdater.error}
              currentVersion={autoUpdater.currentVersion}
              onDownload={autoUpdater.downloadUpdate}
              onCancel={autoUpdater.cancelDownload}
              onInstall={autoUpdater.installUpdate}
              onInstallLater={autoUpdater.scheduleInstallOnNextRestart}
              onRetry={autoUpdater.checkForUpdates}
            />
          </FullscreenAwareLayout>
        </HashRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <I18nProvider>
      <ConfigGuard>
        <ShiftProvider>
          <ModuleProvider>
            <BarcodeScannerProvider>
              <AppContent />
            </BarcodeScannerProvider>
          </ModuleProvider>
        </ShiftProvider>
      </ConfigGuard>
    </I18nProvider>
  );
}

export default App;

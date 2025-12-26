import React, { useState, useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { Toaster, toast } from "react-hot-toast";
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
import { SyncNotificationManager } from "./components/SyncNotificationManager";
import { SyncStatusIndicator } from "./components/SyncStatusIndicator";

import { ActivityTracker } from "./services/ActivityTracker";
// Initialize screen capture IPC listeners (side-effect import)
import "./services/ScreenCaptureHandler";
import AnimatedBackground from "./components/AnimatedBackground";
import ThemeToggle from "./components/ThemeToggle";
import { useMenuVersionPolling } from "./hooks/useMenuVersionPolling";
import { useAppEvents } from "./hooks/useAppEvents";
import { updateAdminUrlFromSettings } from "../config/environment";

// Extend window interface for electron API (Comment 1: secure preload)
declare global {
  interface Window {
    electron?: {
      ipcRenderer: {
        on: (channel: string, callback: (data: any) => void) => void;
        removeListener: (channel: string, callback: (data: any) => void) => void;
        removeAllListeners: (channel: string) => void;
        invoke: (channel: string, ...args: any[]) => Promise<any>;
      };
      clipboard?: {
        readText: () => Promise<string>;
        writeText: (text: string) => Promise<void>;
      };
    };
    isElectron?: boolean;
  }
}

function ConfigGuard({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);

  // Check configuration status on startup and sync credentials to localStorage
  useEffect(() => {
    const checkConfiguration = async () => {
      if (window.electron?.ipcRenderer) {
        try {
          // Small delay to ensure database is ready after restart
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Update admin URL from stored settings (for API calls)
          await updateAdminUrlFromSettings();

          console.log('[ConfigGuard] Calling settings:is-configured...');
          const result = await window.electron.ipcRenderer.invoke('settings:is-configured');
          console.log('[ConfigGuard] settings:is-configured result:', JSON.stringify(result));
          
          // Handle both direct response and handleIPCError wrapped response
          // Direct: { configured: boolean, reason: string }
          // Wrapped: { success: boolean, data: { configured: boolean, reason: string } }
          const configData = result?.data ?? result;
          const isConfiguredValue = configData?.configured ?? false;
          const reason = configData?.reason ?? 'Unknown';
          
          console.log('[ConfigGuard] Parsed: configured=%s, reason=%s', isConfiguredValue, reason);
          setIsConfigured(isConfiguredValue);
          console.log('[ConfigGuard] isConfigured set to:', isConfiguredValue);

          // If not configured, ensure we clear any stale session data
          if (!isConfiguredValue) {
            console.log('Terminal not configured, clearing stale session data');
            localStorage.removeItem("pos-user");
            localStorage.removeItem("terminal_id");
            localStorage.removeItem("pos_api_key");
          } else {
            // If configured, sync credentials from main process to localStorage
            // This ensures menu-version polling can authenticate immediately
            try {
              const settings = await window.electron.ipcRenderer.invoke('terminal-config:get-settings');
              console.log('[ConfigGuard] Raw settings from main:', JSON.stringify(settings, null, 2));

              const terminalId = settings?.['terminal.terminal_id'] || settings?.terminal?.terminal_id;
              const apiKey = settings?.['terminal.pos_api_key'] || settings?.terminal?.pos_api_key;

              console.log('[ConfigGuard] Resolved credentials:', {
                terminalId: terminalId || '(not found)',
                apiKeyLen: apiKey?.length || 0,
                apiKeyLast4: apiKey?.slice(-4) || '(not found)',
                lsTerminalId: localStorage.getItem('terminal_id') || '(not in localStorage)',
                lsApiKeyLen: localStorage.getItem('pos_api_key')?.length || 0
              });

              // Always sync if we have values - don't skip if already in localStorage
              // This handles cases where localStorage might be stale
              if (terminalId) {
                localStorage.setItem('terminal_id', terminalId);
                console.log('[ConfigGuard] Synced terminal_id to localStorage:', terminalId);
              }
              if (apiKey) {
                localStorage.setItem('pos_api_key', apiKey);
                console.log('[ConfigGuard] Synced pos_api_key to localStorage (len:', apiKey.length, ')');
              }
            } catch (syncErr) {
              console.warn('[ConfigGuard] Failed to sync credentials to localStorage:', syncErr);
            }
          }
        } catch (err) {
          console.error('Failed to check configuration:', err);
          setIsConfigured(false); // Default to not configured on error
        }
      } else {
        // Non-electron environment (dev), assume configured
        setIsConfigured(true);
      }
    };

    checkConfiguration();
  }, []);

  // Listen for app:reset event (remote wipe / terminal deleted)
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleReset = (data: any) => {
      const reason = data?.reason || 'unknown';
      console.log('App reset triggered:', reason);

      // Clear all local storage
      localStorage.removeItem("pos-user");
      localStorage.removeItem("terminal_id");
      localStorage.removeItem("pos_api_key");
      localStorage.removeItem("admin_dashboard_url");

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
        icon: '⚠️',
      });
    };

    window.electron.ipcRenderer.on('app:reset', handleReset);

    return () => {
      window.electron?.ipcRenderer.removeListener('app:reset', handleReset);
    };
  }, [t]);

  // Listen for terminal-credentials-updated event (after onboarding)
  // This stores credentials in localStorage for immediate renderer access
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleCredentialsUpdated = (data: { terminalId?: string; apiKey?: string }) => {
      console.log('[ConfigGuard] Terminal credentials updated, storing in localStorage');
      if (data?.terminalId) {
        localStorage.setItem('terminal_id', data.terminalId);
      }
      if (data?.apiKey) {
        localStorage.setItem('pos_api_key', data.apiKey);
      }
    };

    window.electron.ipcRenderer.on('terminal-credentials-updated', handleCredentialsUpdated);

    return () => {
      window.electron?.ipcRenderer.removeListener('terminal-credentials-updated', handleCredentialsUpdated);
    };
  }, []);

  // Listen for terminal-config-updated event (from heartbeat)
  // This stores branch_id and organization_id from the server
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleConfigUpdated = (data: { branch_id?: string; organization_id?: string }) => {
      console.log('[ConfigGuard] Terminal config updated from heartbeat:', data);
      if (data?.branch_id) {
        localStorage.setItem('branch_id', data.branch_id);
        console.log('[ConfigGuard] Stored branch_id in localStorage:', data.branch_id);
      }
      if (data?.organization_id) {
        localStorage.setItem('organization_id', data.organization_id);
        console.log('[ConfigGuard] Stored organization_id in localStorage:', data.organization_id);
      }
    };

    window.electron.ipcRenderer.on('terminal-config-updated', handleConfigUpdated);

    return () => {
      window.electron?.ipcRenderer.removeListener('terminal-config-updated', handleConfigUpdated);
    };
  }, []);

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
        <OnboardingPage />
      </ErrorBoundary>
    );
  }

  return <>{children}</>;
}

import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { UpdateNotification } from "./components/updates/UpdateNotification";
import { UpdateProgressModal } from "./components/updates/UpdateProgressModal";
import { UpdateReadyModal } from "./components/updates/UpdateReadyModal";
import { UpdateDialog } from "./components/UpdateDialog";
import type { UpdateStatus } from "./components/UpdateDialog";

/**
 * Helper function to convert autoUpdater state to UpdateStatus
 * Used by UpdateDialog to display the correct state
 */
function getUpdateStatus(autoUpdater: ReturnType<typeof useAutoUpdater>): UpdateStatus {
  if (autoUpdater.checking) return 'checking';
  if (autoUpdater.downloading) return 'downloading';
  if (autoUpdater.ready) return 'downloaded';
  if (autoUpdater.error) return 'error';
  if (autoUpdater.available) return 'available';
  return 'not-available';
}

function AppContent() {
  const { t } = useI18n();
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { setStaff, clearShift } = useShift();
  const autoUpdater = useAutoUpdater();

  // Use custom hook for app events
  const { isShuttingDown } = useAppEvents({
    onLogout: () => {
      localStorage.removeItem("pos-user");
      setUser(null);
      // Do NOT clear shift on session timeout to preserve active shift per EOD policy
    }
  });

  // Start background menu version polling once a user session exists
  useMenuVersionPolling({ enabled: !!user });

  // Track hash route for unauthenticated screens so UI updates without reload
  const [hash, setHash] = useState<string>(typeof window !== 'undefined' ? window.location.hash : '');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Check if user is logged in on app start and validate session
  useEffect(() => {
    const validateAndRestoreSession = async () => {
      const storedUser = localStorage.getItem("pos-user");
      if (storedUser) {
        try {
          const parsedUser = JSON.parse(storedUser);

          // For local simple PIN login, just restore the session directly
          // (no database validation needed)
          if (parsedUser.staffId === 'local-simple-pin') {
            setUser(parsedUser);
            setStaff({
              staffId: parsedUser.staffId,
              name: parsedUser.staffName,
              role: parsedUser.role?.name || 'staff',
              branchId: parsedUser.branchId || 'default-branch',
              terminalId: parsedUser.terminalId || 'default-terminal'
            });
            try {
              ActivityTracker.setContext({
                staffId: parsedUser.staffId,
                sessionId: parsedUser.sessionId,
                terminalId: parsedUser.terminalId,
                branchId: parsedUser.branchId,
              })
            } catch { }
            setIsLoading(false);
            return;
          }

          // For database-backed staff, validate session with main process
          if (window.electron?.ipcRenderer) {
            try {
              // Validate session
              const validationResult = await window.electron.ipcRenderer.invoke('staff-auth:validate-session');

              if (!validationResult || !validationResult.valid) {
                console.warn('Session invalid or expired, clearing local storage');
                localStorage.removeItem("pos-user");
                setIsLoading(false);
                return;
              }
            } catch (err) {
              console.error('Session validation failed:', err);
              localStorage.removeItem("pos-user");
              setIsLoading(false);
              return;
            }
          }

          setUser(parsedUser);
          // Set staff in shift context
          setStaff({
            staffId: parsedUser.staffId,
            name: parsedUser.staffName,
            role: parsedUser.role?.name || 'staff',
            branchId: parsedUser.branchId || 'default-branch',
            terminalId: parsedUser.terminalId || 'default-terminal'
          });
          try {
            ActivityTracker.setContext({
              staffId: parsedUser.staffId,
              sessionId: parsedUser.sessionId,
              terminalId: parsedUser.terminalId,
              branchId: parsedUser.branchId,
            })
          } catch { }

        } catch (err) {
          console.error('Error restoring session:', err);
          localStorage.removeItem("pos-user");
        }
      }
      setIsLoading(false);
    };

    validateAndRestoreSession();
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
      // Call the secure auth:login IPC handler (pass as object with pin property)
      console.log('[App.tsx handleLogin] Invoking auth:login IPC...');
      const result = await (window as any).electronAPI?.ipcRenderer?.invoke('auth:login', { pin });
      console.log('[App.tsx handleLogin] IPC result:', JSON.stringify(result, null, 2));

      // Handle both response structures:
      // Old: { success, user }
      // New (handleIPCError wrapper): { success, data: { user } }
      const userData = result?.user || result?.data?.user;

      if (result && result.success && userData) {
        console.log('[App.tsx handleLogin] Login successful, setting user state...');

        // Store session in localStorage
        localStorage.setItem('pos-user', JSON.stringify(userData));

        // Update React state
        setUser(userData);
        setStaff({
          staffId: userData.staffId,
          name: userData.staffName,
          role: userData.role.name,
          branchId: userData.branchId,
          terminalId: userData.terminalId,
        });

        // Initialize activity tracking
        try {
          ActivityTracker.setContext({
            staffId: userData.staffId,
            sessionId: userData.sessionId,
            terminalId: userData.terminalId,
            branchId: userData.branchId,
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
      await (window as any).electronAPI?.ipcRenderer?.invoke('auth:logout');
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
          <LoginPage onLogin={handleLogin} />
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
          <div className="min-h-screen">
            {/* Shutdown/Restart Overlay */}
            {isShuttingDown && (
              <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                <div className="bg-white/10 backdrop-blur-md rounded-3xl p-8 shadow-2xl border border-white/30 text-center">
                  <div className="w-16 h-16 border-4 border-t-transparent border-white rounded-full animate-spin mx-auto mb-4"></div>
                  <h2 className="text-2xl font-bold text-white mb-2">{t('app.pleaseWait')}</h2>
                  <p className="text-white/80">{t('app.shuttingDownMessage')}</p>
                </div>
              </div>
            )}

            {/* Sync Status Indicator - Heart Icon in Top-Left (after navbar) */}
            <div className="fixed top-4 left-20 z-40">
              <SyncStatusIndicator />
            </div>



            <Routes>
              <Route path="/" element={<RefactoredMainLayout onLogout={handleLogout} />} />
              <Route path="/dashboard" element={<RefactoredMainLayout onLogout={handleLogout} />} />
              <Route path="/new-order" element={<NewOrderPage />} />
              <Route path="*" element={<RefactoredMainLayout onLogout={handleLogout} />} />
            </Routes>

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

            {/* Auto Updater Modals */}
            <UpdateNotification
              isOpen={autoUpdater.showNotification}
              onClose={autoUpdater.dismissUpdate}
              updateInfo={autoUpdater.updateInfo}
              onDownload={autoUpdater.downloadUpdate}
              onInstallLater={autoUpdater.dismissUpdate}
            />

            <UpdateProgressModal
              isOpen={autoUpdater.downloading}
              progress={autoUpdater.progress}
              onCancel={autoUpdater.cancelDownload}
            />

            <UpdateReadyModal
              isOpen={autoUpdater.ready}
              updateInfo={autoUpdater.updateInfo}
              onInstallNow={autoUpdater.installUpdate}
              onInstallOnRestart={autoUpdater.dismissUpdate}
            />

            {/* Menu-triggered Update Dialog (Requirements: 2.1) */}
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
              onRetry={autoUpdater.checkForUpdates}
            />
          </div>
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

import React, { useCallback, useEffect, useState } from 'react';
import { useTheme } from '../contexts/theme-context';
import {
  Settings,
  RefreshCw,
  Monitor,
  Wifi,
  WifiOff,
  ToggleLeft,
  ToggleRight,
  Printer,
  Check,
  X,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { emitCompatEvent, getBridge } from '../../lib';
import { useFeatures } from '../hooks/useFeatures';
import { emitParityQueueStatus, runParitySyncCycle } from '../services/ParitySyncCoordinator';
import { getOfflineActionState, getOfflinePageBanner } from '../services/offline-page-capabilities';
import type { QueueStatus } from '../../../../shared/pos/sync-queue-types';
import type { PosFeatureFlags } from '../../../../shared/types/pos-features';

// =============================================
// SECTION COMPONENTS
// =============================================

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  isDark: boolean;
}

const Section: React.FC<SectionProps> = ({ title, icon, children, isDark }) => (
  <div
    className={`rounded-xl border p-6 mb-6 ${
      isDark
        ? 'bg-gray-800/50 border-gray-700'
        : 'bg-white border-gray-200'
    }`}
  >
    <div className="flex items-center gap-3 mb-4">
      {icon}
      <h2
        className={`text-lg font-semibold ${
          isDark ? 'text-gray-100' : 'text-gray-900'
        }`}
      >
        {title}
      </h2>
    </div>
    {children}
  </div>
);

const Row: React.FC<{
  label: string;
  value: string | React.ReactNode;
  isDark: boolean;
}> = ({ label, value, isDark }) => (
  <div className="flex justify-between items-center py-2 border-b border-white/5 last:border-b-0">
    <span
      className={`text-sm font-medium ${
        isDark ? 'text-gray-400' : 'text-gray-500'
      }`}
    >
      {label}
    </span>
    <span
      className={`text-sm ${isDark ? 'text-gray-200' : 'text-gray-800'}`}
    >
      {value}
    </span>
  </div>
);

// =============================================
// TERMINAL CONFIG SECTION
// =============================================

const TerminalConfigSection: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const {
    features: _,
    terminalType,
    parentTerminalId,
    ownerTerminalId,
    posOperatingMode,
  } = useFeatures();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    bridge.terminalConfig
      .getFullConfig()
      .then((c: unknown) => {
        if (c && typeof c === 'object') setConfig(c as Record<string, unknown>);
      })
      .catch(() => {});
  }, []);

  const terminalId =
    (config?.terminal_id as string) ?? (config?.terminalId as string) ?? '—';
  const branchId =
    (config?.branch_id as string) ?? (config?.branchId as string) ?? '—';
  const organizationId =
    (config?.organization_id as string) ??
    (config?.organizationId as string) ??
    '—';

  return (
    <Section
      title="Terminal Configuration"
      icon={<Monitor size={20} className={isDark ? 'text-blue-400' : 'text-blue-600'} />}
      isDark={isDark}
    >
      <Row label="Terminal ID" value={terminalId} isDark={isDark} />
      <Row
        label="Terminal Type"
        value={terminalType ?? 'main'}
        isDark={isDark}
      />
      <Row label="Branch" value={branchId} isDark={isDark} />
      <Row label="Organization" value={organizationId} isDark={isDark} />
      {parentTerminalId && (
        <Row label="Parent Terminal" value={parentTerminalId} isDark={isDark} />
      )}
      {ownerTerminalId && (
        <Row label="Owner Terminal" value={ownerTerminalId} isDark={isDark} />
      )}
      {posOperatingMode && (
        <Row label="Operating Mode" value={posOperatingMode} isDark={isDark} />
      )}
    </Section>
  );
};

// =============================================
// SYNC SETTINGS SECTION
// =============================================

const SyncSettingsSection: React.FC<{ isDark: boolean; isOnline: boolean }> = ({ isDark, isOnline }) => {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const syncAction = getOfflineActionState('settings', 'sync-now', isOnline);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await emitParityQueueStatus();
      setQueueStatus(status);
    } catch {
      // Queue may not be initialized yet
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 10_000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleSyncNow = useCallback(async () => {
    if (syncAction.disabled) {
      return;
    }
    setSyncing(true);
    try {
      await runParitySyncCycle();
      setLastSync(new Date().toLocaleTimeString());
      await refreshStatus();
    } catch (err) {
      console.error('[Settings] Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  }, [refreshStatus, syncAction.disabled]);

  return (
    <Section
      title="Sync Settings"
      icon={
        queueStatus && queueStatus.pending > 0 ? (
          <WifiOff size={20} className="text-amber-400" />
        ) : (
          <Wifi size={20} className={isDark ? 'text-green-400' : 'text-green-600'} />
        )
      }
      isDark={isDark}
    >
      <Row
        label="Pending Items"
        value={
          queueStatus ? (
            <span
              className={
                queueStatus.pending > 0 ? 'text-amber-400 font-bold' : ''
              }
            >
              {queueStatus.pending}
            </span>
          ) : (
            '—'
          )
        }
        isDark={isDark}
      />
      <Row
        label="Failed Items"
        value={
          queueStatus?.failed ? (
            <span className="text-red-400 font-bold">{queueStatus.failed}</span>
          ) : (
            '0'
          )
        }
        isDark={isDark}
      />
      <Row
        label="Conflicts"
        value={String(queueStatus?.conflicts ?? 0)}
        isDark={isDark}
      />
      <Row
        label="Total Queue"
        value={String(queueStatus?.total ?? 0)}
        isDark={isDark}
      />
      {lastSync && <Row label="Last Sync" value={lastSync} isDark={isDark} />}
      <div className="mt-4">
        <button
          onClick={handleSyncNow}
          disabled={syncing || syncAction.disabled}
          title={syncAction.message || undefined}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isDark
              ? 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-700 disabled:text-gray-500'
              : 'bg-blue-500 hover:bg-blue-600 text-white disabled:bg-gray-300 disabled:text-gray-500'
          }`}
        >
          {syncing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
          {syncing ? 'Syncing...' : 'Sync Now'}
        </button>
        {syncAction.disabled && syncAction.message ? (
          <p className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            {syncAction.message}
          </p>
        ) : null}
      </div>
    </Section>
  );
};

// =============================================
// FEATURE FLAGS SECTION
// =============================================

const FeatureFlagsSection: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const { features, loading } = useFeatures();

  if (loading) {
    return (
      <Section
        title="Feature Flags"
        icon={<ToggleRight size={20} className={isDark ? 'text-purple-400' : 'text-purple-600'} />}
        isDark={isDark}
      >
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      </Section>
    );
  }

  const flagEntries = Object.entries(features).filter(
    ([, value]) => typeof value === 'boolean',
  ) as [keyof PosFeatureFlags, boolean][];

  return (
    <Section
      title="Feature Flags"
      icon={<ToggleRight size={20} className={isDark ? 'text-purple-400' : 'text-purple-600'} />}
      isDark={isDark}
    >
      <div className="grid grid-cols-2 gap-2">
        {flagEntries.map(([key, enabled]) => (
          <div
            key={key}
            className={`flex items-center gap-2 py-1.5 px-3 rounded-lg text-sm ${
              isDark ? 'bg-gray-700/50' : 'bg-gray-50'
            }`}
          >
            {enabled ? (
              <Check size={14} className="text-green-400 flex-shrink-0" />
            ) : (
              <X size={14} className="text-red-400 flex-shrink-0" />
            )}
            <span className={isDark ? 'text-gray-300' : 'text-gray-700'}>
              {key}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
};

// =============================================
// HARDWARE/PRINTER SECTION
// =============================================

const HardwareSection: React.FC<{ isDark: boolean; isOnline: boolean }> = ({ isDark, isOnline }) => {
  const [printerIp, setPrinterIp] = useState('');
  const [printerPort, setPrinterPort] = useState('9100');
  const [printerType, setPrinterType] = useState('thermal');
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [saving, setSaving] = useState(false);
  const printerTestAction = getOfflineActionState('settings', 'printer-test', isOnline);

  useEffect(() => {
    const bridge = getBridge();
    bridge.settings
      .getLocal('printer')
      .then((settings: unknown) => {
        if (settings && typeof settings === 'object') {
          const s = settings as Record<string, unknown>;
          if (typeof s.ip === 'string') setPrinterIp(s.ip);
          if (typeof s.port === 'string') setPrinterPort(s.port);
          if (typeof s.type === 'string') setPrinterType(s.type);
        }
      })
      .catch(() => {});
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const bridge = getBridge();
      await bridge.settings.updateLocal('printer', {
        ip: printerIp,
        port: printerPort,
        type: printerType,
      });
      emitCompatEvent('terminal-settings-updated', {
        printer: { ip: printerIp, port: printerPort, type: printerType },
      });
    } catch (err) {
      console.error('[Settings] Failed to save printer config:', err);
    } finally {
      setSaving(false);
    }
  }, [printerIp, printerPort, printerType]);

  const handleTestConnection = useCallback(async () => {
    if (printerTestAction.disabled) {
      return;
    }
    setTestResult(null);
    try {
      const bridge = getBridge();
      await bridge.printer.testDraft({
        profileDraft: {
          name: 'Settings Printer Test',
          type: 'network',
          connectionDetails: {
            type: 'network',
            ip: printerIp.trim(),
            port: printerPort.trim() || '9100',
            render_mode: 'text',
          },
          paperSize: '80mm',
          characterSet: 'cp737',
          greekRenderMode: 'latin_fallback',
          escposCodePage: null,
          receiptTemplate: 'classic',
          fontType: 'a',
          layoutDensity: 'balanced',
          headerEmphasis: 'normal',
          role: 'receipt',
          isDefault: true,
          enabled: true,
        },
        sampleKind: printerType,
      });
      setTestResult('success');
    } catch {
      setTestResult('error');
    }
    setTimeout(() => setTestResult(null), 3000);
  }, [printerIp, printerPort, printerTestAction.disabled]);

  const inputClass = `w-48 px-3 py-1.5 rounded-lg text-sm border ${
    isDark
      ? 'bg-gray-700 border-gray-600 text-gray-200 focus:border-blue-500'
      : 'bg-white border-gray-300 text-gray-800 focus:border-blue-500'
  } outline-none transition-colors`;

  return (
    <Section
      title="Hardware / Printer"
      icon={<Printer size={20} className={isDark ? 'text-orange-400' : 'text-orange-600'} />}
      isDark={isDark}
    >
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className={`text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Printer IP
          </span>
          <input
            type="text"
            value={printerIp}
            onChange={(e) => setPrinterIp(e.target.value)}
            placeholder="192.168.1.100"
            className={inputClass}
          />
        </div>
        <div className="flex justify-between items-center">
          <span className={`text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Port
          </span>
          <input
            type="text"
            value={printerPort}
            onChange={(e) => setPrinterPort(e.target.value)}
            placeholder="9100"
            className={inputClass}
          />
        </div>
        <div className="flex justify-between items-center">
          <span className={`text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Printer Type
          </span>
          <select
            value={printerType}
            onChange={(e) => setPrinterType(e.target.value)}
            className={inputClass}
          >
            <option value="thermal">Thermal</option>
            <option value="impact">Impact</option>
            <option value="inkjet">Inkjet</option>
          </select>
        </div>
      </div>
      <div className="flex gap-3 mt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isDark
              ? 'bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-700'
              : 'bg-green-500 hover:bg-green-600 text-white disabled:bg-gray-300'
          }`}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Save
        </button>
        <button
          onClick={handleTestConnection}
          disabled={!printerIp || printerTestAction.disabled}
          title={printerTestAction.message || undefined}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isDark
              ? 'bg-gray-600 hover:bg-gray-500 text-gray-200 disabled:bg-gray-700 disabled:text-gray-500'
              : 'bg-gray-200 hover:bg-gray-300 text-gray-700 disabled:bg-gray-100 disabled:text-gray-400'
          }`}
        >
          <Printer size={14} />
          Test Connection
        </button>
        {printerTestAction.disabled && printerTestAction.message ? (
          <span className={`text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            {printerTestAction.message}
          </span>
        ) : null}
        {testResult === 'success' && (
          <span className="flex items-center gap-1 text-sm text-green-400">
            <Check size={14} /> Connected
          </span>
        )}
        {testResult === 'error' && (
          <span className="flex items-center gap-1 text-sm text-red-400">
            <AlertTriangle size={14} /> Failed
          </span>
        )}
      </div>
    </Section>
  );
};

// =============================================
// MAIN SETTINGS PAGE
// =============================================

const SettingsPage: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const offlineBanner = getOfflinePageBanner('settings', !isOnline);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <div className={`min-h-full p-6 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <Settings
            size={28}
            className={isDark ? 'text-gray-300' : 'text-gray-700'}
          />
          <h1
            className={`text-2xl font-bold ${
              isDark ? 'text-gray-100' : 'text-gray-900'
            }`}
          >
            Settings
          </h1>
        </div>

        {offlineBanner ? (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
              isDark
                ? 'border-amber-800/70 bg-amber-950/40 text-amber-100'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {offlineBanner}
          </div>
        ) : null}

        <TerminalConfigSection isDark={isDark} />
        <SyncSettingsSection isDark={isDark} isOnline={isOnline} />
        <FeatureFlagsSection isDark={isDark} />
        <HardwareSection isDark={isDark} isOnline={isOnline} />
      </div>
    </div>
  );
};

export default SettingsPage;

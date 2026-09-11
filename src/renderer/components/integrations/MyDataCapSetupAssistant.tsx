import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';
import { POSGlassButton } from '../ui/pos-glass-components';

// App-local view contract mirrors ecr.capSetup; native owns service discovery and
// installer verification. No arbitrary paths or installer URLs cross this API.
export interface MyDataCapSetupStatus {
  success: boolean;
  platformSupported: boolean;
  serviceInstalled: boolean;
  serviceRunning: boolean;
  installerLaunched?: boolean;
  code?: string;
  settings?: { capturePath?: string; outputPath?: string; fileEncoding?: 'utf-8' | 'windows-1253' };
  target?: { type: 'network' | 'usb_serial'; host?: string; serial_port?: string; baud_rate?: number };
}

export function MyDataCapSetupAssistant({ scopeKey, onDetected, onStatus, disabled }: {
  scopeKey: string;
  onDetected: (status: MyDataCapSetupStatus) => void;
  onStatus?: (status: MyDataCapSetupStatus | null) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MyDataCapSetupStatus | null>(null);
  const [busy, setBusy] = useState<'status' | 'open_installer' | null>(null);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;
  const generation = useRef(0);
  const active = useRef(false);
  const inFlight = useRef(false);
  const detected = useRef(onDetected);
  detected.current = onDetected;
  const statusChanged = useRef(onStatus);
  statusChanged.current = onStatus;
  const allowInstaller = useRef(false);
  allowInstaller.current = !disabled && status?.platformSupported === true && (status.success || status.serviceInstalled);

  const request = useCallback(async (action: 'status' | 'open_installer') => {
    if (inFlight.current) return;
    if (action === 'open_installer' && !allowInstaller.current) return;
    const requestedScope = scopeKey;
    const run = ++generation.current;
    const isCurrent = () => active.current && run === generation.current && requestedScope === liveScope.current;
    inFlight.current = true;
    setBusy(action);
    setFailed(false);
    statusChanged.current?.(null);
    try {
      const result = await getBridge().ecr.capSetup(action);
      if (!isCurrent()) return;
      setStatus(result);
      if (action === 'status') statusChanged.current?.(result);
      setFailed(!result.success);
      if (result.success && result.serviceInstalled) detected.current(result);
      if (action === 'open_installer' && result.installerLaunched === true) {
        setInstallerOpened(true);
        // Launching a UAC/installer window is not installation or connection success.
        const refreshed = await getBridge().ecr.capSetup('status');
        if (!isCurrent()) return;
        setStatus(refreshed);
        statusChanged.current?.(refreshed);
        setFailed(!refreshed.success);
        if (refreshed.success && refreshed.serviceInstalled) detected.current(refreshed);
      }
    } catch {
      if (isCurrent()) { setFailed(true); statusChanged.current?.(null); }
    } finally {
      if (isCurrent()) { inFlight.current = false; setBusy(null); }
    }
  }, [scopeKey]);

  useEffect(() => {
    active.current = true;
    inFlight.current = false;
    setStatus(null);
    setInstallerOpened(false);
    request('status');
    const refresh = () => { if (document.hasFocus()) request('status'); };
    window.addEventListener('focus', refresh);
    return () => { active.current = false; generation.current += 1; window.removeEventListener('focus', refresh); };
  }, [request]);

  const phase = status?.platformSupported === false ? 'unsupported'
    : failed ? 'failed' : !status || busy === 'status' ? 'checking'
      : status.serviceRunning ? 'running' : status.serviceInstalled ? 'stopped' : 'missing';
  const messages = {
    checking: t('integrations.mydata.capSetup.checking', 'Checking installed RBS support…'),
    unsupported: t('integrations.mydata.capSetup.unsupported', 'RBS support setup is available on Windows.'),
    failed: t('integrations.mydata.capSetup.failed', 'Could not complete the support check or installer action. Refresh and try again.'),
    running: t('integrations.mydata.capSetup.running', 'RBS service is running. Check the connection details, then connect and test the cashier.'),
    stopped: t('integrations.mydata.capSetup.stopped', 'RBS support is installed. Open its connection setup and start the vendor service, then refresh.'),
    missing: t('integrations.mydata.capSetup.missing', 'RBS support is not installed. Open the official installer and complete its setup.'),
  };
  return <div className="md:col-span-2 rounded-2xl border border-purple-500/20 bg-purple-500/10 p-3" data-testid="mydata-cap-setup">
    <p role="status" className="text-sm">{messages[phase]}</p>
    {status?.success && status.target && <p className="mt-2 text-xs">
      {t('integrations.mydata.capServiceTarget', 'Vendor service target')}: {status.target.type === 'network' ? status.target.host : status.target.serial_port}
    </p>}
    {installerOpened && <p className="mt-2 text-xs">{t('integrations.mydata.capSetup.installerOpened', 'Installer opened. Complete the Windows prompts, then refresh. The cashier is not verified yet.')}</p>}
    {failed && status?.code && <p className="mt-1 text-xs">{t('integrations.mydata.capSetup.errorCode', 'Support code')}: {status.code}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {status?.platformSupported && <POSGlassButton variant="secondary"
        disabled={disabled || busy !== null || (!status.success && !status.serviceInstalled)}
        onClick={() => request('open_installer')}>
        {busy === 'open_installer' ? t('integrations.mydata.capSetup.opening', 'Opening official setup…')
          : status.serviceInstalled ? t('integrations.mydata.capSetup.openSetup', 'Open connection setup')
            : t('integrations.mydata.capSetup.install', 'Install RBS support')}
      </POSGlassButton>}
      <POSGlassButton variant="secondary" disabled={disabled || busy !== null} onClick={() => request('status')}>
        {t('integrations.mydata.capSetup.refresh', 'Refresh support status')}
      </POSGlassButton>
    </div>
  </div>;
}

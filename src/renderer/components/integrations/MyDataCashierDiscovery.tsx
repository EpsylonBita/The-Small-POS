import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';
import { POSGlassButton } from '../ui/pos-glass-components';

export function MyDataCashierDiscovery({ scopeKey, onSelect, disabled }: {
  scopeKey: string; onSelect: (host: string) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;
  const active = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const resultScope = useRef<string | null>(null);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  useEffect(() => {
    active.current = true;
    inFlight.current = false;
    resultScope.current = null;
    setHosts([]); setPhase('idle');
    return () => { active.current = false; generation.current += 1; };
  }, [scopeKey]);

  const find = async () => {
    if (inFlight.current || blocked.current) return;
    const scope = scopeKey;
    const request = ++generation.current;
    const isCurrent = () => active.current && request === generation.current && scope === liveScope.current;
    inFlight.current = true;
    resultScope.current = null;
    setHosts([]); setPhase('searching');
    try {
      const result = await getBridge().ecr.capDiscover();
      if (!isCurrent()) return;
      if (!result.success || !Array.isArray(result.candidates)) throw new Error('Discovery failed');
      const found = result.candidates.filter(candidate =>
        candidate.detectedFamily === 'rbs_mat' && candidate.verification === 'network_only'
        && typeof candidate.host === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate.host)
        && candidate.host.split('.').every(part => Number(part) <= 255));
      resultScope.current = scope;
      setHosts([...new Set(found.map(candidate => candidate.host))]);
      setPhase('done');
    } catch {
      if (isCurrent()) setPhase('failed');
    } finally {
      if (isCurrent()) inFlight.current = false;
    }
  };
  return <div className="md:col-span-2 rounded-2xl border border-purple-500/20 p-3" data-testid="mydata-cashier-discovery">
    <POSGlassButton variant="secondary" disabled={disabled || phase === 'searching'} onClick={find}>
      {phase === 'searching' ? t('integrations.mydata.discovery.searching', 'Finding cashiers on this LAN…') : t('integrations.mydata.discovery.find', 'Find cashier')}
    </POSGlassButton>
    <p className="mt-2 text-xs">{t('integrations.mydata.discovery.help', 'Discovery checks the local network only. Selecting an IP does not connect or verify the cashier, or change the CAP Driver service configuration.')}</p>
    {phase === 'failed' && <p role="alert" className="mt-2 text-sm">{t('integrations.mydata.discovery.failed', 'Could not search this LAN. Try again or enter the device IP manually.')}</p>}
    {phase === 'done' && hosts.length === 0 && <p role="status" className="mt-2 text-sm">{t('integrations.mydata.discovery.empty', 'No RBS/MAT cashier found. Check its network connection or enter the IP manually.')}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {hosts.map(host => <POSGlassButton key={host} variant="secondary" disabled={disabled} onClick={() => {
        if (!blocked.current && active.current && resultScope.current === liveScope.current && resultScope.current === scopeKey) onSelect(host);
      }}>{t('integrations.mydata.discovery.select', 'Select')} MAT ECR · {host}</POSGlassButton>)}
    </div>
  </div>;
}

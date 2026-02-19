import { useEffect, useState } from 'react';
import { getBridge } from './lib';

/**
 * Minimal app shell -- proves the Tauri backend is reachable and the IPC
 * abstraction layer is functioning.  Will be replaced with the full router
 * and layout once UI migration begins.
 */
export default function App() {
  const [version, setVersion] = useState<string>('...');
  const [platform, setPlatform] = useState<string>('...');

  useEffect(() => {
    const bridge = getBridge();

    bridge.app.getVersion().then((res) => {
      setVersion(res?.version ?? 'unknown');
    }).catch(() => setVersion('error'));

    bridge.system.getInfo().then((res) => {
      setPlatform(`${res?.platform ?? '?'} / ${res?.arch ?? '?'}`);
    }).catch(() => setPlatform('error'));
  }, []);

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 text-white">
      <div className="text-center space-y-4">
        <h1 className="text-3xl font-bold text-pos-primary">The Small POS</h1>
        <p className="text-slate-400">Tauri v2 Shell</p>
        <div className="mt-6 space-y-1 text-sm text-slate-500">
          <p>Version: {version}</p>
          <p>Platform: {platform}</p>
        </div>
      </div>
    </div>
  );
}

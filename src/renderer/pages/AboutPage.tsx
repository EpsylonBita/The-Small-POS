import React, { useEffect, useState } from 'react';
import { useTheme } from '../contexts/theme-context';
import { Info, Copy, Check, ExternalLink } from 'lucide-react';

interface AboutInfo {
  version: string;
  buildTimestamp: string;
  gitSha: string;
  platform: string;
  arch: string;
  rustVersion: string;
}

const AboutPage: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    api?.invoke?.('diagnostics:get-about')
      .then((data: AboutInfo) => setAbout(data))
      .catch((err: any) => console.error('Failed to load about info:', err));
  }, []);

  const handleCopy = async () => {
    if (!about) return;
    const text = [
      `The Small POS v${about.version}`,
      `Build: ${about.buildTimestamp}`,
      `Git SHA: ${about.gitSha}`,
      `Platform: ${about.platform} (${about.arch})`,
      `Rust: ${about.rustVersion}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="flex justify-between items-center py-3 border-b border-white/10 last:border-b-0">
      <span className={`text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {label}
      </span>
      <span className={`text-sm font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className={`w-full max-w-lg rounded-2xl border ${isDark ? 'bg-gray-900/80 border-white/10' : 'bg-white border-gray-200'} shadow-xl`}>
        {/* Header */}
        <div className="p-6 pb-4 text-center border-b border-white/10">
          <div className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 ${isDark ? 'bg-blue-500/20' : 'bg-blue-50'}`}>
            <Info className="w-8 h-8 text-blue-500" />
          </div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            The Small POS
          </h1>
          {about && (
            <p className={`text-lg font-mono mt-1 ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
              v{about.version}
            </p>
          )}
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Tauri v2 Desktop Application
          </p>
        </div>

        {/* Info rows */}
        <div className="px-6 py-2">
          {about ? (
            <>
              <Row label="Version" value={`v${about.version}`} />
              <Row label="Build Date" value={about.buildTimestamp} />
              <Row label="Git SHA" value={about.gitSha} />
              <Row label="Platform" value={`${about.platform} (${about.arch})`} />
              <Row label="Rust" value={about.rustVersion} />
            </>
          ) : (
            <div className="py-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto" />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-white/10 flex gap-3 justify-center">
          <button
            onClick={handleCopy}
            disabled={!about}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
              ${isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}
              disabled:opacity-50`}
          >
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied!' : 'Copy Info'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AboutPage;

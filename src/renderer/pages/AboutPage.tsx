import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTheme } from '../contexts/theme-context';
import { Copy, Check } from 'lucide-react';
import { getBridge, type DiagnosticsAboutInfo } from '../../lib';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

const AboutPage: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [about, setAbout] = useState<DiagnosticsAboutInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const bridge = getBridge();
    bridge.diagnostics
      .getAbout()
      .then((data) => setAbout(data))
      .catch((err: unknown) => console.error('Failed to load about info:', err));
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
    <motion.div variants={pageMotionItem} className="flex justify-between items-center py-3 border-b border-white/10 last:border-b-0">
      <span className={`text-sm font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {label}
      </span>
      <span className={`text-sm font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
        {value}
      </span>
    </motion.div>
  );

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="flex h-full flex-col items-center justify-center p-8">
      <motion.div variants={pageMotionItem} className={`w-full max-w-lg rounded-3xl border shadow-xl ${isDark ? 'bg-gray-900/80 border-white/10' : 'bg-white border-gray-200'}`}>
        {/* Header */}
        <motion.div variants={pageMotionItem} className="p-6 pb-4 text-center border-b border-white/10">
          <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            The Small POS
          </h1>
          {about && (
            <p className={`text-lg font-mono mt-1 ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
              v{about.version}
            </p>
          )}
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Tauri v2 Desktop Application
          </p>
        </motion.div>

        {/* Info rows */}
        <motion.div variants={pageMotionContainer} className="px-6 py-2">
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400 mx-auto" />
            </div>
          )}
        </motion.div>

        {/* Actions */}
        <motion.div variants={pageMotionItem} className="p-4 border-t border-white/10 flex gap-3 justify-center">
          <button
            onClick={handleCopy}
            disabled={!about}
            className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl text-sm font-semibold transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400
              ${isDark
                ? 'bg-yellow-400 text-black'
                : 'bg-black text-white'}
              disabled:opacity-50`}
          >
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied!' : 'Copy Info'}
          </button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
};

export default AboutPage;

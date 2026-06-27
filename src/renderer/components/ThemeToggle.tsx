import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useI18n } from '../contexts/i18n-context';

export default function ThemeToggle() {
    const { theme, setTheme, resolvedTheme } = useTheme();
    const { t } = useI18n();
    const isDark = resolvedTheme === 'dark';
    const cycle = () => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto');
    const label = theme === 'auto' ? (
        <span className="text-xs font-semibold">A</span>
    ) : resolvedTheme === 'dark' ? (
        <Moon className="h-5 w-5" />
    ) : (
        <Sun className="h-5 w-5" />
    );
    return (
        <button
            onClick={cycle}
            aria-label={t('app.themeToggle.title', { theme })}
            className={`inline-flex items-center justify-center transition text-2xl p-2 active:scale-95 ${isDark ? 'text-white/70 active:text-white' : 'text-slate-900 active:text-black'}`}
        >
            <span className="leading-none select-none">{label}</span>
        </button>
    );
}

import React from 'react';
import { useTheme } from '../contexts/theme-context';
import { useI18n } from '../contexts/i18n-context';

export default function ThemeToggle() {
    const { theme, setTheme, resolvedTheme } = useTheme();
    const { t } = useI18n();
    const cycle = () => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto');
    const label = theme === 'auto' ? 'A' : resolvedTheme === 'dark' ? '🌙' : '☀';
    return (
        <button
            onClick={cycle}
            title={t('app.themeToggle.title', { theme })}
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 border border-white/20 text-white hover:bg-white/20 transition"
        >
            <span className="text-lg leading-none select-none">{label}</span>
        </button>
    );
}

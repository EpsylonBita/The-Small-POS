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
            className="text-white/70 hover:text-white transition text-2xl p-2"
        >
            <span className="leading-none select-none">{label}</span>
        </button>
    );
}

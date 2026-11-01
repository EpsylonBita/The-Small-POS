import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';

export const ThemeSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();

  const handleToggle = () => {
    try {
      setTheme(resolvedTheme === 'light' ? 'dark' : 'light');
    } catch {
      toast.error(t('errors.saveFailed'));
    }
  };

  return (
    <button
      onClick={handleToggle}
      type="button"
      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-150 active:scale-95 ${
        resolvedTheme === 'light' ? 'text-slate-900' : 'text-gray-300'
      }`}
      // The name lived only in title, which touch never shows; aria-label names the icon button.
      aria-label={resolvedTheme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
      title={resolvedTheme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
    >
      <span className="inline-flex items-center justify-center">
        {resolvedTheme === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </span>
    </button>
  );
}; 

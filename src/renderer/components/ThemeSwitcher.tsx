import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';

export const ThemeSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();

  const handleToggle = () => {
    setTheme(resolvedTheme === 'light' ? 'dark' : 'light');
  };

  return (
    <button
      onClick={handleToggle}
      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-150 active:scale-95 ${
        resolvedTheme === 'light'
          ? 'text-slate-900 hover:text-yellow-500'
          : 'text-gray-300 hover:text-yellow-400'
      }`}
      title={resolvedTheme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
    >
      <span className="inline-flex items-center justify-center">
        {resolvedTheme === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </span>
    </button>
  );
}; 

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { localeBundles } from '../locales/bundles';

const resources = {
  en: {
    translation: localeBundles.en,
  },
  el: {
    translation: localeBundles.el,
  },
  de: {
    translation: localeBundles.de,
  },
  fr: {
    translation: localeBundles.fr,
  },
  it: {
    translation: localeBundles.it,
  },
};

// Get language from localStorage or default to 'en'
// Note: For main process, this will be updated via IPC when SettingsService is available
const getInitialLanguage = (): string => {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('language');
      if (stored && ['en', 'el', 'de', 'fr', 'it'].includes(stored)) {
        return stored;
      }
    }
  } catch (e) {
    // Main process doesn't have localStorage - default to 'en'
    // Language will be updated via updateLanguageFromDatabase() after SettingsService init
  }
  return 'en';
};

// Initialize i18next on first load
if (!i18n.isInitialized) {
  i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: getInitialLanguage(), // read from localStorage or default to 'en'
      fallbackLng: 'en',
      interpolation: {
        escapeValue: false, // react already does escaping
      },
      react: {
        useSuspense: false,
      },
      debug: false,
      initImmediate: false,
    });
}

// Always refresh resource bundles so new/changed translations are picked up
// (handles Vite HMR where the module re-evaluates but isInitialized is already true)
i18n.addResourceBundle('en', 'translation', localeBundles.en, true, true);
i18n.addResourceBundle('el', 'translation', localeBundles.el, true, true);
i18n.addResourceBundle('de', 'translation', localeBundles.de, true, true);
i18n.addResourceBundle('fr', 'translation', localeBundles.fr, true, true);
i18n.addResourceBundle('it', 'translation', localeBundles.it, true, true);

/**
 * Update i18n language from database
 * Called after SettingsService is initialized in main process
 */
export function updateLanguageFromDatabase(settingsService: any): void {
  try {
    const language = settingsService.getLanguage();
    if (language && ['en', 'el', 'de', 'fr', 'it'].includes(language)) {
      i18n.changeLanguage(language);
      console.log(`[i18n] Language updated from database: ${language}`);
    }
  } catch (e) {
    console.warn('[i18n] Failed to update language from database:', e);
  }
}

export default i18n;

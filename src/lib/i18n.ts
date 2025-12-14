import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enTranslations = require('../locales/en.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const elTranslations = require('../locales/el.json');

const resources = {
  en: {
    translation: enTranslations,
  },
  el: {
    translation: elTranslations,
  },
};

// Get language from localStorage or default to 'en'
const getInitialLanguage = (): string => {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('language');
      if (stored && ['en', 'el'].includes(stored)) {
        return stored;
      }
    }
  } catch (e) {
    console.warn('Failed to read language from localStorage:', e);
  }
  return 'en';
};

// Only initialize if not already initialized
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

export default i18n;

/**
 * Main Process i18n
 * 
 * Separate i18n instance for the main process that doesn't use React-specific plugins.
 * This avoids issues with react-i18next in the Electron main process.
 */

import i18n from 'i18next';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enTranslations = require('../../locales/en.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const elTranslations = require('../../locales/el.json');

const resources = {
  en: {
    translation: enTranslations,
  },
  el: {
    translation: elTranslations,
  },
};

// Create a separate i18n instance for main process
const mainI18n = i18n.createInstance();

mainI18n.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
  initImmediate: false,
});

/**
 * Update language from settings
 */
export function updateMainLanguage(language: 'en' | 'el'): void {
  if (language && ['en', 'el'].includes(language)) {
    mainI18n.changeLanguage(language);
    console.log(`[main-i18n] Language updated to: ${language}`);
  }
}

/**
 * Initialize main process language from settings service
 * Call this after settings service is available
 */
export function initializeMainLanguageFromSettings(settingsService: { getLanguage: () => 'en' | 'el' }): void {
  try {
    const savedLanguage = settingsService.getLanguage();
    console.log(`[main-i18n] initializeMainLanguageFromSettings called`);
    console.log(`[main-i18n] Saved language from database: "${savedLanguage}"`);
    console.log(`[main-i18n] Current mainI18n language: "${mainI18n.language}"`);
    updateMainLanguage(savedLanguage);
    console.log(`[main-i18n] After update, mainI18n language: "${mainI18n.language}"`);
  } catch (error) {
    console.error('[main-i18n] Failed to initialize language from settings:', error);
  }
}

/**
 * Get current language
 */
export function getCurrentLanguage(): string {
  return mainI18n.language;
}

export default mainI18n;

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enTranslations = require('../../locales/en.json')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const elTranslations = require('../../locales/el.json')

// Read persisted language from localStorage before initialization
const savedLanguage = localStorage.getItem('language') || 'en'

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    resources: {
      en: {
        translation: enTranslations
      },
      el: {
        translation: elTranslations
      }
    },
    lng: savedLanguage, // Use persisted language or default to 'en'
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false // react already safes from xss
    }
  })

export default i18n

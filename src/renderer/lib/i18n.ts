import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { localeBundles } from '../../locales/bundles'

// Read persisted language from localStorage before initialization
const savedLanguage = localStorage.getItem('language') || 'en'

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    resources: {
      en: {
        translation: localeBundles.en
      },
      el: {
        translation: localeBundles.el
      },
      de: {
        translation: localeBundles.de
      },
      fr: {
        translation: localeBundles.fr
      },
      it: {
        translation: localeBundles.it
      }
    },
    lng: savedLanguage, // Use persisted language or default to 'en'
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false // react already safes from xss
    }
  })

export default i18n

import { createContext, useContext } from 'react'
import type { TFunction } from 'i18next'

export type SupportedLanguage = 'en' | 'el' | 'de' | 'fr' | 'it' | 'sq'
export interface I18nContextType {
  language: string
  setLanguage: (lang: SupportedLanguage) => Promise<void>
  t: TFunction
}

// Keep the context and consumer outside the provider's locale import graph.
// Translation HMR must not replace the context held by a mounted provider.
export const I18nContext = createContext<I18nContextType | undefined>(undefined)
export function useI18n(): I18nContextType {
  const context = useContext(I18nContext)
  if (context === undefined) throw new Error('useI18n must be used within an I18nProvider')
  return context
}

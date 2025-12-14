'use client'

import React, { createContext, useContext, useState, ReactNode } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { TFunction } from 'i18next'
import i18n from '../../lib/i18n'

type SupportedLanguage = 'en' | 'el'

interface I18nContextType {
  language: string
  setLanguage: (lang: SupportedLanguage) => void
  t: TFunction
}

const I18nContext = createContext<I18nContextType | undefined>(undefined)

interface I18nProviderProps {
  children: ReactNode
}

export const I18nProvider: React.FC<I18nProviderProps> = ({ children }) => {
  return (
    <I18nextProvider i18n={i18n}>
      <I18nProviderContent>{children}</I18nProviderContent>
    </I18nextProvider>
  )
}

const I18nProviderContent: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t, i18n: i18nInstance } = useTranslation()
  const [language, setLanguageState] = useState<string>(i18nInstance.language || 'en')

  const setLanguage = (lang: SupportedLanguage) => {
    try {
      localStorage.setItem('language', lang)
    } catch (e) {
      console.warn('Failed to save language to localStorage:', e)
    }
    i18nInstance.changeLanguage(lang)
    setLanguageState(lang)
  }

  const contextValue: I18nContextType = {
    language,
    setLanguage,
    t
  }

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  )
}

export const useI18n = (): I18nContextType => {
  const context = useContext(I18nContext)
  if (context === undefined) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return context
}

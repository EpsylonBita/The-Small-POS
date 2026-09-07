'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { TFunction } from 'i18next'
import i18n from '../../lib/i18n'
import { getBridge } from '../../lib'

type SupportedLanguage = 'en' | 'el' | 'de' | 'fr' | 'it'

interface I18nContextType {
  language: string
  setLanguage: (lang: SupportedLanguage) => Promise<void>
  t: TFunction
}

const I18nContext = createContext<I18nContextType | undefined>(undefined)

const assertLanguageSaved = (result: { success?: boolean; error?: unknown } | null | undefined) => {
  if (result?.success === false) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Failed to save language')
  }
}

const readCachedLanguage = (): string | null => {
  try {
    return localStorage.getItem('language')
  } catch (error) {
    console.warn('[i18n-context] Language cache unavailable:', error)
    return null
  }
}

const cacheLanguage = (language: string): void => {
  try {
    localStorage.setItem('language', language)
  } catch (error) {
    // Native settings remain durable even when WebView storage is unavailable.
    console.warn('[i18n-context] Could not cache language:', error)
    try {
      // A stale cache otherwise wins over the newly saved native value next start.
      localStorage.removeItem('language')
    } catch {
      // Storage may be entirely blocked; startup can still read native settings.
    }
  }
}

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
  const bridge = getBridge()

  // On mount, sync language between localStorage and main process database
  useEffect(() => {
    const syncLanguage = async () => {
      try {
        // Get language from main process database
        const dbLanguage = await bridge.settings.getLanguage()
        // Get language from localStorage
        const localLanguage = readCachedLanguage()

        console.log(`[i18n-context] Sync check - localStorage: "${localLanguage}", database: "${dbLanguage}"`)

        // If localStorage has a valid language that differs from database, save to database
        if (localLanguage && ['en', 'el', 'de', 'fr', 'it'].includes(localLanguage) && localLanguage !== dbLanguage) {
          console.log(`[i18n-context] Syncing localStorage language "${localLanguage}" to database`)
          const result = await bridge.settings.setLanguage(localLanguage)
          assertLanguageSaved(result)
          console.log(`[i18n-context] Sync to database result:`, result)
          // Update i18n instance to match
          if (i18nInstance.language !== localLanguage) {
            await i18nInstance.changeLanguage(localLanguage)
            setLanguageState(localLanguage)
          }
        } else if (dbLanguage && ['en', 'el', 'de', 'fr', 'it'].includes(dbLanguage)) {
          // Database has the authoritative value, sync to localStorage and i18n
          if (i18nInstance.language !== dbLanguage) {
            await i18nInstance.changeLanguage(dbLanguage)
            setLanguageState(dbLanguage)
            console.log(`[i18n-context] Synced from database to: "${dbLanguage}"`)
          }
          cacheLanguage(dbLanguage)
        }
      } catch (e) {
        console.warn('[i18n-context] Failed to sync language:', e)
      }
    }
    syncLanguage()
  }, [bridge.settings, i18nInstance])

  const setLanguage = async (lang: SupportedLanguage): Promise<void> => {
    const previousLanguage = i18nInstance.language
    const result = await bridge.settings.setLanguage(lang)
    assertLanguageSaved(result)

    try {
      await i18nInstance.changeLanguage(lang)
    } catch (error) {
      // Avoid keeping a new native preference when translation activation failed.
      try {
        assertLanguageSaved(await bridge.settings.setLanguage(previousLanguage))
      } catch (rollbackError) {
        console.warn('[i18n-context] Could not restore previous language:', rollbackError)
      }
      throw error
    }

    cacheLanguage(lang)
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

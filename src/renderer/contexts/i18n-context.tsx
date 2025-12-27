/// <reference path="../types/electron.d.ts" />
'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
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

  // On mount, sync language between localStorage and main process database
  useEffect(() => {
    const syncLanguage = async () => {
      try {
        // Type-safe access to electron IPC (may not exist in non-Electron environments)
        const electron = (window as any).electron;
        if (electron?.ipcRenderer) {
          // Get language from main process database
          const dbLanguage = await electron.ipcRenderer.invoke('settings:get-language');
          // Get language from localStorage
          const localLanguage = localStorage.getItem('language');

          console.log(`[i18n-context] Sync check - localStorage: "${localLanguage}", database: "${dbLanguage}"`);

          // If localStorage has a valid language that differs from database, save to database
          if (localLanguage && ['en', 'el'].includes(localLanguage) && localLanguage !== dbLanguage) {
            console.log(`[i18n-context] Syncing localStorage language "${localLanguage}" to database`);
            const result = await electron.ipcRenderer.invoke('settings:set-language', localLanguage);
            console.log(`[i18n-context] Sync to database result:`, result);
            // Update i18n instance to match
            if (i18nInstance.language !== localLanguage) {
              i18nInstance.changeLanguage(localLanguage);
              setLanguageState(localLanguage);
            }
          } else if (dbLanguage && ['en', 'el'].includes(dbLanguage)) {
            // Database has the authoritative value, sync to localStorage and i18n
            localStorage.setItem('language', dbLanguage);
            if (i18nInstance.language !== dbLanguage) {
              i18nInstance.changeLanguage(dbLanguage);
              setLanguageState(dbLanguage);
              console.log(`[i18n-context] Synced from database to: "${dbLanguage}"`);
            }
          }
        }
      } catch (e) {
        console.warn('[i18n-context] Failed to sync language:', e);
      }
    };
    syncLanguage();
  }, [i18nInstance]);

  const setLanguage = async (lang: SupportedLanguage) => {
    try {
      console.log(`[i18n-context] setLanguage called with: "${lang}"`);
      // Save to localStorage (for renderer process)
      localStorage.setItem('language', lang);
      console.log(`[i18n-context] Saved to localStorage: "${lang}"`);
      // Save to database (for main process)
      const electron = (window as any).electron;
      if (electron?.ipcRenderer) {
        console.log(`[i18n-context] Calling settings:set-language IPC with: "${lang}"`);
        const result = await electron.ipcRenderer.invoke('settings:set-language', lang);
        console.log(`[i18n-context] IPC result:`, result);
      } else {
        console.warn('[i18n-context] window.electron.ipcRenderer not available');
      }
    } catch (e) {
      console.warn('Failed to save language:', e);
    }
    // Update i18n instance
    i18nInstance.changeLanguage(lang);
    setLanguageState(lang);
    console.log(`[i18n-context] Language state updated to: "${lang}"`);
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

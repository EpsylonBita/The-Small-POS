'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

// Theme System Integration:
// - Applies .dark class to document.documentElement when resolvedTheme === 'dark'
// - CSS variables in glassmorphism.css respond to .dark selector for liquid glass effects
// - Supports three modes: 'light', 'dark', 'auto' (time-based: 6 AM - 6 PM = light)
// - No 'dim' option as per design requirements

export type Theme = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

export const applyThemeToDocument = (
  targetDocument: Document,
  resolvedTheme: ResolvedTheme,
  theme: Theme,
): void => {
  const isDark = resolvedTheme === 'dark'
  const themeRoots = [targetDocument.documentElement, targetDocument.body]

  themeRoots.forEach((element) => {
    element.classList.toggle('dark', isDark)
    element.setAttribute('data-theme', theme)
  })
}

interface ThemeContextType {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

interface ThemeProviderProps {
  children: ReactNode
}

const getTimeBasedTheme = (): ResolvedTheme => {
  const hour = new Date().getHours()
  return (hour >= 6 && hour < 18) ? 'light' : 'dark'
}

const readInitialTheme = (): Theme => {
  try {
    const savedTheme = localStorage.getItem('pos-theme')
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'auto') {
      return savedTheme
    }
  } catch (error) {
    console.warn('[Theme] Could not read saved theme:', error)
  }
  return 'auto'
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === 'auto' ? getTimeBasedTheme() : theme,
  )

  // A caller may show success only after the preference has been persisted.
  // Let storage errors reach the action handler; keep the visible theme intact.
  const setTheme = React.useCallback((nextTheme: Theme): void => {
    localStorage.setItem('pos-theme', nextTheme)
    setThemeState(nextTheme)
  }, [])

  // In auto mode, theme only changes at 06:00 and 18:00 local time.
  // Schedule a one-shot timer for the next boundary instead of polling.
  const getMsUntilNextBoundary = (): number => {
    const now = new Date()
    const next = new Date(now)
    const hour = now.getHours()

    if (hour < 6) {
      next.setHours(6, 0, 0, 0)
    } else if (hour < 18) {
      next.setHours(18, 0, 0, 0)
    } else {
      next.setDate(next.getDate() + 1)
      next.setHours(6, 0, 0, 0)
    }

    const diff = next.getTime() - now.getTime()
    return Math.max(diff, 1000)
  }

  // Update resolved theme based on current theme setting
  useEffect(() => {
    const updateResolvedTheme = () => {
      if (theme === 'auto') {
        setResolvedTheme(getTimeBasedTheme())
      } else {
        setResolvedTheme(theme)
      }
    }

    updateResolvedTheme()

    let timeout: ReturnType<typeof setTimeout> | null = null
    const scheduleNextAutoUpdate = () => {
      if (theme !== 'auto') return
      timeout = setTimeout(() => {
        updateResolvedTheme()
        scheduleNextAutoUpdate()
      }, getMsUntilNextBoundary())
    }

    if (theme === 'auto') {
      scheduleNextAutoUpdate()
    }

    return () => {
      if (timeout) clearTimeout(timeout)
    }
  }, [theme])

  // Apply resolved theme to document root for CSS (.dark selectors)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      applyThemeToDocument(document, resolvedTheme, theme)
    }
  }, [resolvedTheme, theme])

  const value = {
    theme,
    resolvedTheme,
    setTheme,
  }

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
} 

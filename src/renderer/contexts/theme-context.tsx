'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

// Theme System Integration:
// - Applies .dark class to document.documentElement when resolvedTheme === 'dark'
// - CSS variables in glassmorphism.css respond to .dark selector for liquid glass effects
// - Supports three modes: 'light', 'dark', 'auto' (time-based: 6 AM - 6 PM = light)
// - No 'dim' option as per design requirements

export type Theme = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeContextType {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

interface ThemeProviderProps {
  children: ReactNode
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>('auto')
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark')

  // Function to determine theme based on time
  const getTimeBasedTheme = (): ResolvedTheme => {
    const now = new Date()
    const hour = now.getHours()
    
    // Light theme from 6 AM to 6 PM (18:00), dark theme otherwise
    return (hour >= 6 && hour < 18) ? 'light' : 'dark'
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

    // Set up interval to check time every minute for auto theme
    let interval: NodeJS.Timeout | null = null
    if (theme === 'auto') {
      interval = setInterval(updateResolvedTheme, 60000) // Check every minute
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [theme])

  // Load theme from localStorage on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('pos-theme') as Theme
    if (savedTheme && ['light', 'dark', 'auto'].includes(savedTheme)) {
      setTheme(savedTheme)
    }
  }, [])

  // Save theme to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('pos-theme', theme)
  }, [theme])

  // Apply resolved theme to document root for CSS (.dark selectors)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (resolvedTheme === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
      root.setAttribute('data-theme', theme);
    }
  }, [resolvedTheme, theme]);

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
/**
 * Electron API Safety Utility
 * Provides safe access to window.electronAPI with proper undefined checks
 *
 * IMPORTANT: Always use this utility instead of accessing window.electronAPI directly
 * This prevents runtime errors when running outside Electron context (e.g., tests, browser)
 */

import type { ElectronAPI } from '../../preload/index'

/**
 * Get the Electron API safely
 * Returns undefined if not running in Electron context
 *
 * @returns ElectronAPI instance or undefined
 */
export function getElectronAPI(): ElectronAPI | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window as any).electronAPI
}

/**
 * Check if running in Electron context
 *
 * @returns true if Electron API is available
 */
export function isElectronContext(): boolean {
  return getElectronAPI() !== undefined
}

/**
 * Get Electron API or throw error with helpful message
 * Use this when Electron context is required
 *
 * @throws Error if not in Electron context
 * @returns ElectronAPI instance
 */
export function requireElectronAPI(): ElectronAPI {
  const api = getElectronAPI()

  if (!api) {
    throw new Error(
      'Electron API is not available. ' +
      'This component must be run in an Electron context. ' +
      'If you are running tests, mock the Electron API. ' +
      'If you are in a browser, check your environment.'
    )
  }

  return api
}

/**
 * Execute function only if in Electron context
 * Useful for optional Electron features
 *
 * @param fn - Function to execute with Electron API
 * @param fallback - Optional fallback value if not in Electron context
 * @returns Result of fn or fallback
 */
export function withElectronAPI<T>(
  fn: (api: ElectronAPI) => T,
  fallback?: T
): T | undefined {
  const api = getElectronAPI()

  if (!api) {
    return fallback
  }

  return fn(api)
}

/**
 * Execute async function only if in Electron context
 * Useful for optional Electron features
 *
 * @param fn - Async function to execute with Electron API
 * @param fallback - Optional fallback value if not in Electron context
 * @returns Promise<Result of fn or fallback>
 */
export async function withElectronAPIAsync<T>(
  fn: (api: ElectronAPI) => Promise<T>,
  fallback?: T
): Promise<T | undefined> {
  const api = getElectronAPI()

  if (!api) {
    return fallback
  }

  return await fn(api)
}

/**
 * Safe wrapper for window.electronAPI.invoke
 * Provides better error handling and type safety
 *
 * @param channel - IPC channel name
 * @param args - Arguments to pass to main process
 * @returns Promise<Result from main process>
 */
export async function safeInvoke<T = any>(
  channel: string,
  ...args: any[]
): Promise<T | undefined> {
  const api = getElectronAPI()

  if (!api || typeof api.invoke !== 'function') {
    console.warn(`Electron API not available for invoke: ${channel}`)
    return undefined
  }

  try {
    return await api.invoke(channel, ...args)
  } catch (error) {
    console.error(`Error invoking Electron API channel "${channel}":`, error)
    throw error
  }
}

/**
 * Safe wrapper for window.electronAPI.on (event listener)
 *
 * @param channel - IPC channel name
 * @param callback - Callback function
 * @returns Cleanup function to remove listener
 */
export function safeOn(
  channel: string,
  callback: (...args: any[]) => void
): () => void {
  const api = getElectronAPI()

  if (!api || typeof api.on !== 'function') {
    console.warn(`Electron API not available for listener: ${channel}`)
    return () => {} // Return no-op cleanup
  }

  api.on(channel, callback)

  // Return cleanup function
  return () => {
    if (api && typeof api.off === 'function') {
      api.off(channel, callback)
    }
  }
}

/**
 * Safe wrapper for window.electronAPI.send
 *
 * @param channel - IPC channel name
 * @param args - Arguments to send
 */
export function safeSend(channel: string, ...args: any[]): void {
  const api = getElectronAPI()

  if (!api || typeof api.send !== 'function') {
    console.warn(`Electron API not available for send: ${channel}`)
    return
  }

  try {
    api.send(channel, ...args)
  } catch (error) {
    console.error(`Error sending to Electron API channel "${channel}":`, error)
    throw error
  }
}

/**
 * Log Electron API availability on app startup
 * Call this once when the app initializes
 */
export function logElectronAPIStatus(): void {
  const api = getElectronAPI()

  if (api) {
    console.log('✅ Electron API is available')
    console.log('📡 Available IPC methods:', Object.keys(api))
  } else {
    console.warn('⚠️ Electron API is NOT available')
    console.warn('   Running in non-Electron context (browser or tests)')
  }
}

// Auto-log on module load in development
if (process.env.NODE_ENV === 'development') {
  if (typeof window !== 'undefined') {
    // Wait for window to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', logElectronAPIStatus)
    } else {
      logElectronAPIStatus()
    }
  }
}

/**
 * React Hook: Use Electron API
 * Provides reactive access to Electron API availability
 *
 * @returns [api | undefined, isAvailable]
 */
export function useElectronAPI(): [ElectronAPI | undefined, boolean] {
  const api = getElectronAPI()
  const isAvailable = api !== undefined

  return [api, isAvailable]
}

// Export types for convenience
export type { ElectronAPI }

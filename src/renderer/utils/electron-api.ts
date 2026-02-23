/**
 * External URL helper routed through the platform bridge.
 *
 * Desktop runtimes always use the backend command so URL policy is enforced
 * centrally. Browser fallback is only for non-desktop development contexts.
 */

import { getBridge, isBrowser } from '../../lib'

export async function openExternalUrl(url: string): Promise<boolean> {
  const target = typeof url === 'string' ? url.trim() : ''
  if (!target) return false

  try {
    if (!isBrowser()) {
      await getBridge().invoke('system:open-external-url', { url: target })
      return true
    }
  } catch (error) {
    console.error('Failed to open external URL via native gateway:', error)
    return false
  }

  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(target, '_blank', 'noopener,noreferrer')
    return true
  }

  return false
}

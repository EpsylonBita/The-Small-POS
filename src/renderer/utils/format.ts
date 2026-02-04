// Shared formatting utilities for the POS renderer
// Keep this light and framework-agnostic

import i18n from '../../lib/i18n'

const resolveLocale = (locale?: string): string => {
  const fallback = typeof navigator !== 'undefined' ? navigator.language : 'en-US'
  const candidate = (locale || i18n.language || fallback || 'en-US').replace('_', '-')
  if (candidate.includes('-')) {
    return candidate
  }
  if (candidate === 'el') return 'el-GR'
  if (candidate === 'en') return 'en-US'
  return candidate
}

export function formatCurrency(amount: number, currency: string = 'EUR', locale?: string): string {
  const resolvedLocale = resolveLocale(locale)
  const safe = Number.isFinite(amount) ? amount : 0
  try {
    return new Intl.NumberFormat(resolvedLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
  } catch {
    // Fallback in case of unsupported locale/currency
    const prefix = currency === 'EUR' ? '\u20AC' : `${currency} `
    return `${prefix}${safe.toFixed(2)}`
  }
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, locale?: string): string {
  const resolvedLocale = resolveLocale(locale)
  const safe = Number.isFinite(value) ? value : 0
  try {
    return new Intl.NumberFormat(resolvedLocale, options).format(safe)
  } catch {
    return `${safe}`
  }
}

export function formatDate(value: Date | string | number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const resolvedLocale = resolveLocale(locale)
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleDateString(resolvedLocale, options)
}

export function formatTime(value: Date | string | number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const resolvedLocale = resolveLocale(locale)
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleTimeString(resolvedLocale, options)
}

export function formatDateTime(value: Date | string | number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const resolvedLocale = resolveLocale(locale)
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleString(resolvedLocale, options)
}

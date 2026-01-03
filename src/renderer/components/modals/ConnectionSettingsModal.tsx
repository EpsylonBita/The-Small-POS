import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { getApiUrl } from '../../../config/environment'
import { useTheme } from '../../contexts/theme-context'
import { useI18n } from '../../contexts/i18n-context'
import { Wifi, Lock, Palette, Globe, ChevronDown, Sun, Moon, Monitor, Database, Printer, Eye, EyeOff, Clipboard } from 'lucide-react'
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import PrinterSettingsModal from './PrinterSettingsModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';

interface Props {
  isOpen: boolean
  onClose: () => void
}

const ConnectionSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { language: currentLanguage, setLanguage } = useI18n()
  const [terminalId, setTerminalId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [showPinSettings, setShowPinSettings] = useState(false)
  const [editingPin, setEditingPin] = useState(false)
  const [showPrinterSettingsModal, setShowPrinterSettingsModal] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showDatabaseSettings, setShowDatabaseSettings] = useState(false)
  const [showClearOperationalConfirm, setShowClearOperationalConfirm] = useState(false)
  const [isClearingOperational, setIsClearingOperational] = useState(false)




  useEffect(() => {
    if (!isOpen) return
    const lsTerminal = localStorage.getItem('terminal_id') || ''
    const lsApiKey = localStorage.getItem('pos_api_key') || ''
    const lsPin = localStorage.getItem('staff.simple_pin') || ''
    setTerminalId(lsTerminal)
    setApiKey(lsApiKey)
    setPin(lsPin)
  }, [isOpen])

  const handleSaveConnection = async () => {
    if (!terminalId || !apiKey) {
      toast.error(t('modals.connectionSettings.enterBoth'))
      return
    }

    // Check if terminal ID or API key changed
    const oldTerminalId = localStorage.getItem('terminal_id')
    const oldApiKey = localStorage.getItem('pos_api_key')
    const hasChanged = oldTerminalId !== terminalId || oldApiKey !== apiKey

    localStorage.setItem('terminal_id', terminalId)
    localStorage.setItem('pos_api_key', apiKey)

    try {
      // Persist under the correct category ('terminal'), not 'pos'
      await (window as any)?.electronAPI?.ipcRenderer?.invoke('settings:update-local', {
        settingType: 'terminal',
        settings: { terminal_id: terminalId, pos_api_key: apiKey }
      })
    } catch (e) {
      console.warn('Failed to persist connection settings to main process:', e)
    }

    // Try to pull branch_id from Admin-provisioned terminal config via main process
    try {
      // Ask main to refresh terminal settings (Supabase -> local cache)
      await (window as any)?.electronAPI?.refreshTerminalSettings?.()
      const bid = await (window as any)?.electronAPI?.getTerminalBranchId?.()
      if (bid) {
        localStorage.setItem('branch_id', bid)
        try {
          await (window as any)?.electronAPI?.ipcRenderer?.invoke('settings:update-local', {
            settingType: 'terminal',
            settings: { branch_id: bid }
          })
        } catch (e) {
          console.warn('Failed to persist branch_id to main process:', e)
        }
      } else {
        console.warn('[ConnectionSettings] Could not resolve branch_id for terminal', terminalId)
      }
    } catch (e) {
      console.warn('[ConnectionSettings] Branch resolution failed:', e)
    }

    // If terminal ID or API key changed, trigger full sync from Admin Dashboard
    if (hasChanged) {
      try {
        console.log('[ConnectionSettings] Terminal ID or API key changed, clearing shifts and updating credentials...')

        // Clear any active shifts from old terminal
        localStorage.removeItem('activeShift')
        localStorage.removeItem('staff')

        // Update terminal credentials in the sync service
        await (window as any)?.electronAPI?.ipcRenderer?.invoke('settings:update-terminal-credentials', {
          terminalId,
          apiKey
        })

        toast.success(t('modals.connectionSettings.connectionSaved') + ' - Syncing data...')
      } catch (e) {
        console.warn('Failed to update credentials or trigger sync:', e)
        toast.success(t('modals.connectionSettings.connectionSaved'))
      }
    } else {
      toast.success(t('modals.connectionSettings.connectionSaved'))
    }
  }

  const handleSavePin = async () => {
    if (!pin || pin.length < 4) {
      toast.error(t('modals.connectionSettings.pinMinLength'))
      return
    }
    if (pin !== confirmPin) {
      toast.error(t('modals.connectionSettings.pinNoMatch'))
      return
    }
    localStorage.setItem('staff.simple_pin', pin)

    try {
      await (window as any)?.electronAPI?.ipcRenderer?.invoke('settings:update-local', {
        settingType: 'staff',
        settings: { simple_pin: pin }
      })
    } catch (e) {
      console.warn('Failed to persist PIN settings to main process:', e)
    }

    toast.success(t('modals.connectionSettings.pinSaved'))
    setEditingPin(false)
  }

  const handleSaveTheme = (newTheme: 'light' | 'dark' | 'auto') => {
    setTheme(newTheme)
    toast.success(t('modals.connectionSettings.themeUpdated'))
  }

  const handlePasteBoth = async () => {
    try {
      let clipboardText = ''

      // Best effort: try browser clipboard first
      try {
        clipboardText = await navigator.clipboard.readText()
      } catch (clipboardError: any) {
        console.warn('[Paste Both] Browser clipboard failed, will fall back to manual paste:', clipboardError?.message)
      }

      // If browser clipboard failed or returned empty, try Electron clipboard (if available)
      if (!clipboardText && typeof window !== 'undefined') {
        const electronAPI = (window as any).electron || (window as any).electronAPI
        if (electronAPI && typeof electronAPI.clipboard?.readText === 'function') {
          try {
            clipboardText = await electronAPI.clipboard.readText()
          } catch (electronClipboardError: any) {
            console.warn('[Paste Both] Electron clipboard failed, will fall back to manual paste:', electronClipboardError?.message)
          }
        }
      }

      // Absolute fallback: ask user to paste manually into a prompt
      if (!clipboardText) {
        if (typeof window === 'undefined') {
          toast.error(t('modals.connectionSettings.pasteError'))
          return
        }
        const manual = window.prompt(t('modals.connectionSettings.pastePrompt'))
        if (!manual) {
          // User cancelled
          return
        }
        clipboardText = manual
      }

      // Try to parse the clipboard content
      // Format: "Terminal ID: terminal-xxx\nAPI Key: yyy" or just two lines
      const lines = clipboardText.split('\n').map(line => line.trim()).filter(line => line)

      let foundTerminalId = ''
      let foundApiKey = ''

      // Parse each line
      for (const line of lines) {
        if (line.toLowerCase().includes('terminal id:')) {
          foundTerminalId = line.split(':').slice(1).join(':').trim()
        } else if (line.toLowerCase().includes('api key:')) {
          foundApiKey = line.split(':').slice(1).join(':').trim()
        } else if (!foundTerminalId && line.startsWith('terminal-')) {
          // If it looks like a terminal ID (starts with "terminal-")
          foundTerminalId = line
        } else if (!foundApiKey && foundTerminalId && line.length > 10) {
          // If we already have terminal ID and this looks like an API key
          foundApiKey = line
        }
      }

      if (foundTerminalId && foundApiKey) {
        setTerminalId(foundTerminalId)
        setApiKey(foundApiKey)
        toast.success(t('modals.connectionSettings.pastedBoth'))
      } else if (foundTerminalId || foundApiKey) {
        if (foundTerminalId) setTerminalId(foundTerminalId)
        if (foundApiKey) setApiKey(foundApiKey)
        toast.success(t('modals.connectionSettings.pastedPartial'))
      } else {
        toast.error(t('modals.connectionSettings.pasteFormatError'))
      }
    } catch (e: any) {
      toast.error(e?.message || t('modals.connectionSettings.pasteError'))
    }
  }

  const handleTest = async () => {
    if (!terminalId || !apiKey) {
      toast.error(t('modals.connectionSettings.enterToTest'))
      return
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': terminalId,
        'x-pos-api-key': apiKey,
        'Origin': window.location.origin,
      }
      const res = await fetch(getApiUrl('/pos/orders?limit=1'), { method: 'GET', headers })
      let body: any = null
      try { body = await res.json() } catch { }
      if (res.ok) {
        toast.success(t('modals.connectionSettings.connected'))
      } else {
        const msg = body?.error || body?.message || `HTTP ${res.status}`
        toast.error(t('modals.connectionSettings.connectionFailed', { msg }))
        console.warn('[Connection Test] Failed', { status: res.status, body })
      }
    } catch (e: any) {
      toast.error(e?.message || t('modals.connectionSettings.networkError'))
    }
  }

  const handleClearDatabase = async () => {
    // Double confirmation for factory reset - this is a destructive operation
    const firstConfirm = confirm(t('settings.database.confirmClear'))
    if (!firstConfirm) {
      return
    }

    const secondConfirm = confirm(t('settings.database.confirmFactoryReset'))
    if (!secondConfirm) {
      return
    }

    try {
      toast.loading(t('settings.database.resetting') || 'Performing factory reset...')

      // Call the factory reset handler in main process
      const result = await window.electron?.ipcRenderer?.invoke('settings:factory-reset')

      if (result?.success) {
        // Clear all localStorage
        localStorage.clear()

        toast.dismiss()
        toast.success(t('settings.database.resetSuccess') || 'Factory reset complete. App will restart...')

        // Restart the app to go back to onboarding
        setTimeout(async () => {
          try {
            await window.electron?.ipcRenderer?.invoke('app:restart')
          } catch (e) {
            console.error('Failed to restart app, falling back to reload:', e)
            window.location.reload()
          }
        }, 1500)
      } else {
        throw new Error(result?.error || 'Unknown error')
      }
    } catch (e) {
      console.error('Failed to perform factory reset', e)
      toast.dismiss()
      toast.error(t('settings.database.clearFailed'))
    }
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.connectionSettings.title')}
      size="md"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="space-y-4">
        {/* Connection Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showConnectionSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''
          }`}>
          <button
            onClick={() => setShowConnectionSettings(!showConnectionSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Wifi className="w-5 h-5 text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
              <span className="font-medium">{t('modals.connectionSettings.connectionSettings')}</span>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showConnectionSettings ? 'rotate-180' : ''}`} />
          </button>

          {showConnectionSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border`}>
              <div className="pt-3">
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.terminalId')}</label>
                <input
                  value={terminalId}
                  onChange={e => setTerminalId(e.target.value)}
                  className="liquid-glass-modal-input"
                  placeholder={t('modals.connectionSettings.terminalPlaceholder')}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.apiKey')}</label>
                <div className="relative">
                  <input
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    type={showApiKey ? 'text' : 'password'}
                    className="liquid-glass-modal-input pr-10"
                    placeholder={t('modals.connectionSettings.apiKeyPlaceholder')}
                  />
                  <button
                    type="button"
                    aria-label={showApiKey ? t('common.hide') : t('common.show')}
                    onClick={() => setShowApiKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-white/20 dark:hover:bg-gray-700/40"
                  >
                    {showApiKey ? (
                      <EyeOff className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Eye className="w-4 h-4 text-gray-400" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handlePasteBoth}
                  title={t('modals.connectionSettings.pasteBothTooltip')}
                  className={liquidGlassModalButton('secondary', 'md') + ' flex items-center gap-2'}
                >
                  <Clipboard className="w-4 h-4" />
                  {t('modals.connectionSettings.pasteBoth')}
                </button>
                <button onClick={handleTest} className={liquidGlassModalButton('secondary', 'md')}>
                  {t('modals.connectionSettings.test')}
                </button>
                <button onClick={handleSaveConnection} className={liquidGlassModalButton('primary', 'md')}>
                  {t('modals.connectionSettings.save')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* PIN Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showPinSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''
          }`}>
          <button
            onClick={() => setShowPinSettings(!showPinSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Lock className="w-5 h-5 text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('modals.connectionSettings.pinSetup')}</span>
                {pin && !editingPin && <span className={`text-xs liquid-glass-modal-text-muted`}>••••</span>}
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showPinSettings ? 'rotate-180' : ''}`} />
          </button>

          {showPinSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border`}>
              {!editingPin ? (
                <button
                  onClick={() => setEditingPin(true)}
                  className={liquidGlassModalButton('primary', 'md') + ' mt-3'}
                >
                  {t('modals.connectionSettings.changePin')}
                </button>
              ) : (
                <>
                  <div className="pt-3">
                    <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.newPin')}</label>
                    <input
                      value={pin}
                      onChange={e => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      className="liquid-glass-modal-input"
                      placeholder={t('modals.connectionSettings.enterPin')}
                    />
                  </div>
                  <div>
                    <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.confirmPin')}</label>
                    <input
                      value={confirmPin}
                      onChange={e => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      className="liquid-glass-modal-input"
                      placeholder={t('modals.connectionSettings.confirmPinPlaceholder')}
                    />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setEditingPin(false)}
                      className={liquidGlassModalButton('secondary', 'md')}
                    >
                      {t('modals.connectionSettings.cancel')}
                    </button>
                    <button onClick={handleSavePin} className={liquidGlassModalButton('primary', 'md')}>
                      {t('modals.connectionSettings.savePin')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Theme Switcher */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Palette className="w-5 h-5 text-pink-400 drop-shadow-[0_0_8px_rgba(244,114,182,0.6)]" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.theme')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSaveTheme('light')}
                className={`p-2 rounded-lg transition-all ${theme === 'light'
                  ? 'bg-yellow-500/30 border-2 border-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.light')}
              >
                <Sun className={`w-5 h-5 ${theme === 'light' ? 'text-yellow-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('dark')}
                className={`p-2 rounded-lg transition-all ${theme === 'dark'
                  ? 'bg-indigo-500/30 border-2 border-indigo-400 shadow-[0_0_12px_rgba(129,140,248,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.dark')}
              >
                <Moon className={`w-5 h-5 ${theme === 'dark' ? 'text-indigo-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('auto')}
                className={`p-2 rounded-lg transition-all ${theme === 'auto'
                  ? 'bg-cyan-500/30 border-2 border-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.system')}
              >
                <Monitor className={`w-5 h-5 ${theme === 'auto' ? 'text-cyan-300' : 'text-gray-400'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Language Switcher */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-blue-400 drop-shadow-[0_0_8px_rgba(96,165,250,0.6)]" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.language')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setLanguage('en')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'en'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langEnglish')}
              >
                EN
              </button>
              <button
                onClick={() => {
                  setLanguage('el')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'el'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langGreek')}
              >
                ΕΛ
              </button>
            </div>
          </div>
        </div>

        {/* Database Management */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showDatabaseSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowDatabaseSettings(!showDatabaseSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('settings.database.management', 'Database Management')}</span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showDatabaseSettings ? 'rotate-180' : ''}`} />
          </button>

          {showDatabaseSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border pt-4`}>
              <div className="flex flex-col gap-3">
                {/* Clear Sync Queue - Less destructive */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearSyncQueueLabel', 'Clear Sync Queue')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearSyncQueueHelp', 'Clears stuck sync items without deleting data')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await (window as any)?.electronAPI?.invoke?.('sync:clear-all')
                        if (result?.success) {
                          toast.success(t('settings.database.syncQueueCleared', { count: result.cleared }))
                        } else {
                          toast.error(result?.error || t('settings.database.syncQueueClearFailed'))
                        }
                      } catch (e) {
                        console.error('Failed to clear sync queue:', e)
                        toast.error(t('settings.database.syncQueueClearFailed'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-orange-600/30 border-2 border-orange-500 hover:bg-orange-600/50 text-orange-300 shadow-[0_0_12px_rgba(251,146,60,0.5)]`}
                  >
                    {t('settings.database.clearSyncButton')}
                  </button>
                </div>

                {/* Clear Old Orders - Medium destructive */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearOldOrdersLabel', 'Clear Old Orders')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearOldOrdersHelp', 'Removes orphaned orders from previous days')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await (window as any)?.electronAPI?.invoke?.('sync:clear-old-orders')
                        if (result?.success) {
                          toast.success(t('settings.database.oldOrdersCleared', { count: result.cleared }) || `Cleared ${result.cleared} old orders`)
                        } else {
                          toast.error(result?.error || t('settings.database.oldOrdersClearFailed', 'Failed to clear old orders'))
                        }
                      } catch (e) {
                        console.error('Failed to clear old orders:', e)
                        toast.error(t('settings.database.oldOrdersClearFailed', 'Failed to clear old orders'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-yellow-600/30 border-2 border-yellow-500 hover:bg-yellow-600/50 text-yellow-300 shadow-[0_0_12px_rgba(250,204,21,0.5)]`}
                  >
                    {t('settings.database.clearOldOrdersButton', 'Clear')}
                  </button>
                </div>

                {/* Sync Deleted Orders - Cleanup orphaned orders */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.syncDeletedOrdersLabel', 'Sync Deleted Orders')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.syncDeletedOrdersHelp', 'Removes orders deleted from admin dashboard')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await (window as any)?.electronAPI?.invoke?.('sync:cleanup-deleted-orders')
                        if (result?.success) {
                          toast.success(t('settings.database.deletedOrdersSynced', { count: result.deleted, checked: result.checked }) || `Synced: removed ${result.deleted} deleted orders (checked ${result.checked})`)
                        } else {
                          toast.error(result?.error || t('settings.database.syncDeletedOrdersFailed', 'Failed to sync deleted orders'))
                        }
                      } catch (e) {
                        console.error('Failed to sync deleted orders:', e)
                        toast.error(t('settings.database.syncDeletedOrdersFailed', 'Failed to sync deleted orders'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-blue-600/30 border-2 border-blue-500 hover:bg-blue-600/50 text-blue-300 shadow-[0_0_12px_rgba(96,165,250,0.5)]`}
                  >
                    {t('settings.database.syncButton', 'Sync')}
                  </button>
                </div>

                {/* Clear All Operational Data - Clears orders, shifts, drawers but keeps settings */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearOperationalLabel', 'Clear All Operational Data')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearOperationalHelp', 'Clears orders, shifts, drawers, payments. Keeps settings.')}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowClearOperationalConfirm(true)}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-amber-600/30 border-2 border-amber-500 hover:bg-amber-600/50 text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.5)]`}
                  >
                    {t('settings.database.clearOperationalButton', 'Clear')}
                  </button>
                </div>

                {/* Factory Reset - Destructive */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.label')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.helpText')}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleClearDatabase}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-red-600/30 border-2 border-red-500 hover:bg-red-600/50 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.5)]`}
                  >
                    {t('settings.database.clearButton')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Printer Settings trigger */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Printer className="w-5 h-5 text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
              <div className="text-left">
                <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.printer.label')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.printer.helpText')}</span>
              </div>
            </div>
            <button
              onClick={() => setShowPrinterSettingsModal(true)}
              className={liquidGlassModalButton('primary', 'md')}
            >
              {t('settings.printer.configureButton')}
            </button>
          </div>
        </div>

        {showPrinterSettingsModal && (
          <PrinterSettingsModal
            isOpen={showPrinterSettingsModal}
            onClose={() => setShowPrinterSettingsModal(false)}
          />
        )}

        {/* Clear Operational Data Confirmation Dialog */}
        <ConfirmDialog
          isOpen={showClearOperationalConfirm}
          onClose={() => setShowClearOperationalConfirm(false)}
          onConfirm={async () => {
            setIsClearingOperational(true)
            try {
              const result = await (window as any)?.electronAPI?.ipcRenderer?.invoke('database:clear-operational-data')
              if (result?.success) {
                toast.success(t('settings.database.operationalCleared', 'All operational data cleared successfully'))
                setShowClearOperationalConfirm(false)
              } else {
                toast.error(result?.error || t('settings.database.operationalClearFailed', 'Failed to clear operational data'))
              }
            } catch (e) {
              console.error('Failed to clear operational data:', e)
              toast.error(t('settings.database.operationalClearFailed', 'Failed to clear operational data'))
            } finally {
              setIsClearingOperational(false)
            }
          }}
          title={t('settings.database.confirmClearOperationalTitle', 'Clear Operational Data')}
          message={t('settings.database.confirmClearOperationalMessage', 'This action cannot be undone. All operational data will be permanently deleted.')}
          variant="warning"
          confirmText={t('settings.database.clearOperationalButton', 'Clear')}
          cancelText={t('common.actions.cancel', 'Cancel')}
          isLoading={isClearingOperational}
          requireCheckbox={t('settings.database.confirmClearOperationalCheckbox', 'I understand that this will delete all orders, shifts, drawers, payments, and driver earnings')}
          details={
            <ul className="list-disc list-inside space-y-1 text-white/70">
              <li>{t('settings.database.clearItem.orders', 'All orders')}</li>
              <li>{t('settings.database.clearItem.shifts', 'All staff shifts')}</li>
              <li>{t('settings.database.clearItem.drawers', 'All cash drawer sessions')}</li>
              <li>{t('settings.database.clearItem.payments', 'All payments and expenses')}</li>
              <li>{t('settings.database.clearItem.earnings', 'All driver earnings')}</li>
            </ul>
          }
        />
      </div>
    </LiquidGlassModal>
  )
}

export default ConnectionSettingsModal

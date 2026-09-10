import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Volume2, Upload, Play, Square, AlertTriangle } from 'lucide-react'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { useAppAudioEnabled } from '../../services/appAudio'
import {
  PLATFORM_SOUND_PRESETS,
  importPlatformSoundFile,
  previewPlatformSound,
  selectImportedPlatformSound,
  selectPlatformSoundPreset,
  stopPlatformSoundPreview,
  usePlatformNotificationSoundSelection,
  type PlatformSoundPresetId,
  type PlatformSoundSelectionId,
} from '../../services/platformNotificationSound'

export const PlatformNotificationSoundSettings: React.FC = () => {
  const { t } = useTranslation()
  const selection = usePlatformNotificationSoundSelection()
  const audioEnabled = useAppAudioEnabled()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const importAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      importAbortRef.current?.abort()
      stopPlatformSoundPreview()
    }
  }, [])

  useEffect(() => {
    if (!audioEnabled) stopPlatformSoundPreview()
  }, [audioEnabled])

  const withBusyGuard = async (run: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    stopPlatformSoundPreview()
    try {
      const result = await run()
      if (!mountedRef.current) return
      if (!result.ok && result.error !== 'settings.platforms.sound.errors.cancelled') {
        setError(result.error ?? 'settings.platforms.sound.errors.saveFailed')
      }
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  const handlePreview = (id: PlatformSoundSelectionId) => {
    if (busyRef.current || !audioEnabled) return
    if (selection.previewingId === id) {
      stopPlatformSoundPreview()
      return
    }
    previewPlatformSound(id)
  }

  const handleSelectPreset = (id: PlatformSoundPresetId) => {
    void withBusyGuard(() => selectPlatformSoundPreset(id))
  }

  const handleSelectImported = () => {
    void withBusyGuard(() => selectImportedPlatformSound())
  }

  const handleFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busyRef.current) return
    importAbortRef.current?.abort()
    const controller = new AbortController()
    importAbortRef.current = controller
    void withBusyGuard(() => importPlatformSoundFile(file, controller.signal))
  }

  const options: Array<{ id: PlatformSoundSelectionId; label: string }> = [
    ...PLATFORM_SOUND_PRESETS.map((preset) => ({
      id: preset.id as PlatformSoundSelectionId,
      label: t(preset.labelKey, preset.defaultLabel),
    })),
    ...(selection.hasImportedClip
      ? [
          {
            id: 'custom' as PlatformSoundSelectionId,
            label: t('settings.platforms.sound.options.custom', {
              name: selection.importedName ?? '',
              defaultValue: 'Imported: {{name}}',
            }),
          },
        ]
      : []),
  ]

  return (
    <div className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-black/10">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-400/20 text-indigo-600 dark:text-indigo-300">
          <Volume2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <span className="block text-sm font-semibold liquid-glass-modal-text">
            {t('settings.platforms.sound.title', 'Order alert sound')}
          </span>
          <span className="block text-xs liquid-glass-modal-text-muted">
            {t(
              'settings.platforms.sound.help',
              'Choose the sound played on this register when a new platform order needs approval.',
            )}
          </span>
        </div>
      </div>

      {!audioEnabled && (
        <p className="text-xs liquid-glass-modal-text-muted">
          {t(
            'settings.platforms.sound.mutedNote',
            'App sound is muted, so preview is unavailable. Alerts will resume when sound is re-enabled.',
          )}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <span className="text-xs liquid-glass-modal-text">{t(error)}</span>
        </div>
      )}

      <div role="radiogroup" aria-label={t('settings.platforms.sound.title', 'Order alert sound')} className="space-y-2">
        {options.map((option) => {
          const isSelected = selection.selectedId === option.id
          const isPreviewing = selection.previewingId === option.id
          return (
            <div
              key={option.id}
              className="flex items-center justify-between gap-3 rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2 dark:bg-gray-800/10"
            >
              <label className="flex min-w-0 flex-1 items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="platform-notification-sound"
                  checked={isSelected}
                  disabled={busy}
                  onChange={() =>
                    option.id === 'custom' ? handleSelectImported() : handleSelectPreset(option.id)
                  }
                />
                <span className="truncate text-sm liquid-glass-modal-text">{option.label}</span>
              </label>
              <button
                type="button"
                onClick={() => handlePreview(option.id)}
                disabled={!audioEnabled || busy}
                className={liquidGlassModalButton('secondary', 'sm')}
                aria-label={
                  isPreviewing
                    ? t('settings.platforms.sound.stop', 'Stop')
                    : t('settings.platforms.sound.preview', 'Preview')
                }
              >
                <span className="inline-flex items-center gap-1.5">
                  {isPreviewing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {isPreviewing
                    ? t('settings.platforms.sound.stop', 'Stop')
                    : t('settings.platforms.sound.preview', 'Preview')}
                </span>
              </button>
            </div>
          )
        })}
      </div>

      <div>
        <label
          htmlFor="platform-notification-sound-file"
          aria-disabled={busy}
          className={`${liquidGlassModalButton('secondary', 'md')} inline-flex items-center gap-2 ${
            busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'
          }`}
        >
          <Upload className="h-4 w-4" />
          {t('settings.platforms.sound.chooseFile', 'Choose file…')}
        </label>
        <input
          id="platform-notification-sound-file"
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav"
          className="sr-only"
          disabled={busy}
          onChange={handleFileChosen}
        />
        <p className="mt-1 text-xs liquid-glass-modal-text-muted">
          {t(
            'settings.platforms.sound.fileHelp',
            'MP3 or WAV, up to 5 MB and 30 seconds long.',
          )}
        </p>
      </div>
    </div>
  )
}

export default PlatformNotificationSoundSettings

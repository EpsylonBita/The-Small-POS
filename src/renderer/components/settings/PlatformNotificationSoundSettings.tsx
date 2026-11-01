import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Play, Square, AlertTriangle } from 'lucide-react'
import { solidButton } from './SettingsKit'
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
    <section className="pos-group">
      <header className="pos-group__head">
        <h3 className="pos-group__title">
          {t('settings.platforms.sound.title', 'Order alert sound')}
        </h3>
        <p className="pos-group__desc">
          {t(
            'settings.platforms.sound.help',
            'Choose the sound played on this register when a new platform order needs approval.',
          )}
        </p>
      </header>
      <div className="space-y-3 px-5 pb-4 pt-2">

      {!audioEnabled && (
        <p className="text-sm liquid-glass-modal-text-muted">
          {t(
            'settings.platforms.sound.mutedNote',
            'App sound is muted, so preview is unavailable. Alerts will resume when sound is re-enabled.',
          )}
        </p>
      )}

      {error && (
        <div role="alert" className="pos-notice pos-notice--bad">
          <AlertTriangle className="pos-notice__icon h-4 w-4" aria-hidden="true" />
          <span className="text-sm">{t(error)}</span>
        </div>
      )}

      <div role="radiogroup" aria-label={t('settings.platforms.sound.title', 'Order alert sound')} className="space-y-2">
        {options.map((option) => {
          const isSelected = selection.selectedId === option.id
          const isPreviewing = selection.previewingId === option.id
          return (
            <div
              key={option.id}
              className={`pos-choice-row${isSelected ? ' is-selected' : ''}`}
            >
              <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3 cursor-pointer">
                <input
                  className="pos-radio"
                  type="radio"
                  name="platform-notification-sound"
                  checked={isSelected}
                  disabled={busy}
                  onChange={() =>
                    option.id === 'custom' ? handleSelectImported() : handleSelectPreset(option.id)
                  }
                />
                <span className="truncate text-base liquid-glass-modal-text">{option.label}</span>
              </label>
              <button
                type="button"
                onClick={() => handlePreview(option.id)}
                disabled={!audioEnabled || busy}
                className={solidButton('secondary', 'sm')}
                aria-label={
                  isPreviewing
                    ? t('settings.platforms.sound.stop', 'Stop')
                    : t('settings.platforms.sound.preview', 'Preview')
                }
              >
                {isPreviewing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {isPreviewing
                  ? t('settings.platforms.sound.stop', 'Stop')
                  : t('settings.platforms.sound.preview', 'Preview')}
              </button>
            </div>
          )
        })}
      </div>

      <div>
        <label
          htmlFor="platform-notification-sound-file"
          aria-disabled={busy}
          className={`${solidButton('secondary', 'md')} ${
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
        <p className="mt-1 text-sm liquid-glass-modal-text-muted">
          {t(
            'settings.platforms.sound.fileHelp',
            'MP3 or WAV, up to 5 MB and 30 seconds long.',
          )}
        </p>
      </div>
      </div>
    </section>
  )
}

export default PlatformNotificationSoundSettings

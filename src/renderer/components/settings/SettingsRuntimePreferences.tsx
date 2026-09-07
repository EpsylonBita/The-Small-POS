import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';
import type { WindowsSettingsSection } from '../../../lib/ipc-adapter';
import { applySavedAppAudioPreference, playAppAudioTest, useAppAudioEnabled } from '../../services/appAudio';
import { requireSettingsSuccess } from '../../utils/settings-operation';

interface SettingsRuntimePreferencesProps {
  onOpenPrinterSettings?: () => void;
  onOpenSecurity?: () => void;
}

export function SettingsRuntimePreferences({ onOpenPrinterSettings, onOpenSecurity }: SettingsRuntimePreferencesProps) {
  const { t } = useTranslation();
  const bridge = useMemo(() => getBridge(), []);
  const savedAudioEnabled = useAppAudioEnabled();
  const [audioEnabled, setAudioEnabled] = useState(savedAudioEnabled);
  const [savingAudio, setSavingAudio] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [openingSection, setOpeningSection] = useState<WindowsSettingsSection | null>(null);
  const [systemError, setSystemError] = useState('');
  const audioLabelId = useId();

  useEffect(() => {
    if (!savingAudio) setAudioEnabled(savedAudioEnabled);
  }, [savedAudioEnabled, savingAudio]);

  const saveAudio = async () => {
    if (savingAudio) return;
    const next = !audioEnabled;
    setAudioEnabled(next);
    setSavingAudio(true);
    setAudioError('');
    try {
      requireSettingsSuccess(await bridge.settings.updateLocal({
        settingType: 'ui', settings: { audio_enabled: next },
      }));
      applySavedAppAudioPreference(next);
    } catch (error) {
      setAudioEnabled(savedAudioEnabled);
      setAudioError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingAudio(false);
    }
  };

  const openSystemSettings = async (section: WindowsSettingsSection) => {
    if (openingSection) return;
    setOpeningSection(section);
    setSystemError('');
    try {
      requireSettingsSuccess(await bridge.system.openSettings(section));
    } catch (error) {
      setSystemError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningSection(null);
    }
  };

  const systemSections: { section: WindowsSettingsSection; label: string }[] = [
    { section: 'display', label: t('settings.workflow.windowsDisplay', { defaultValue: 'Display and brightness' }) },
    { section: 'sound', label: t('settings.workflow.windowsSound', { defaultValue: 'Speakers and volume' }) },
    { section: 'touch', label: t('settings.workflow.windowsTouch', { defaultValue: 'Pointer and touch feedback' }) },
    { section: 'power', label: t('settings.workflow.windowsPower', { defaultValue: 'Screen sleep and power' }) },
  ];
  const buttonClass = 'min-h-[44px] rounded-xl border liquid-glass-modal-border px-4 py-3 text-sm font-medium liquid-glass-modal-text active:bg-black/5 dark:active:bg-white/5 disabled:cursor-wait disabled:opacity-50';

  return (
    <div className="space-y-5" data-testid="settings-runtime-preferences">
      <section className="rounded-2xl border liquid-glass-modal-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 id={audioLabelId} className="font-medium liquid-glass-modal-text">
              {t('settings.workflow.posSounds', { defaultValue: 'POS notification sounds' })}
            </h3>
            <p className="text-xs liquid-glass-modal-text-muted mt-1">
              {t('settings.workflow.posSoundsHelp', { defaultValue: 'Sounds for incoming orders, kiosk notifications and kitchen updates. Visual alerts stay active.' })}
            </p>
          </div>
          <button type="button" role="switch" aria-labelledby={audioLabelId} aria-checked={audioEnabled}
            disabled={savingAudio} onClick={() => void saveAudio()}
            className="flex h-11 w-14 shrink-0 items-center justify-center rounded-xl disabled:opacity-50">
            <span className={`relative h-7 w-12 rounded-full transition-colors ${audioEnabled ? 'bg-yellow-400' : 'bg-slate-400/50'}`}>
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${audioEnabled ? 'left-1 translate-x-5' : 'left-1'}`} />
            </span>
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" disabled={!savedAudioEnabled || savingAudio} className={buttonClass} onClick={() => playAppAudioTest()}>
            {t('settings.workflow.testSound', { defaultValue: 'Test sound' })}
          </button>
          {savingAudio && <span role="status" className="text-xs liquid-glass-modal-text-muted">{t('settings.workflow.saving', { defaultValue: 'Saving…' })}</span>}
        </div>
        {audioError && <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {t('settings.workflow.audioSaveFailed', { defaultValue: 'Could not save the sound setting.' })} {audioError}
        </p>}
      </section>

      <section className="rounded-2xl border liquid-glass-modal-border p-4 space-y-3">
        <h3 className="font-medium liquid-glass-modal-text">{t('settings.workflow.windowsDeviceSettings', { defaultValue: 'Windows device settings' })}</h3>
        <p className="text-xs liquid-glass-modal-text-muted">
          {t('settings.workflow.windowsDeviceHelp', { defaultValue: 'Windows manages monitor brightness, speakers, pointer and touch feedback, and screen sleep. Open the relevant page to adjust this device.' })}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {systemSections.map(({ section, label }) => (
            <button type="button" key={section} className={buttonClass} disabled={openingSection !== null}
              onClick={() => void openSystemSettings(section)}>
              {label}
            </button>
          ))}
        </div>
        {openingSection && <p role="status" className="text-xs liquid-glass-modal-text-muted">{t('settings.workflow.openingWindows', { defaultValue: 'Opening Windows settings…' })}</p>}
        {systemError && <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {t('settings.workflow.windowsOpenFailed', { defaultValue: 'Could not open Windows settings.' })} {systemError}
        </p>}
      </section>

      {(onOpenPrinterSettings || onOpenSecurity) && <div className="flex flex-wrap gap-2">
        {onOpenPrinterSettings && <button type="button" className={buttonClass} onClick={onOpenPrinterSettings}>
          {t('settings.workflow.receiptSettings', { defaultValue: 'Receipt and printer settings' })}
        </button>}
        {onOpenSecurity && <button type="button" className={buttonClass} onClick={onOpenSecurity}>
          {t('settings.workflow.securitySettings', { defaultValue: 'PIN and security settings' })}
        </button>}
      </div>}
    </div>
  );
}

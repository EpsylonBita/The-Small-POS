import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';
import type { WindowsSettingsSection } from '../../../lib/ipc-adapter';
import { applySavedAppAudioPreference, playAppAudioTest, useAppAudioEnabled } from '../../services/appAudio';
import { requireSettingsSuccess } from '../../utils/settings-operation';
import { POSGlassSwitch } from '../ui/pos-glass-components';
import { solidButton } from './SettingsKit';

// Sections link to each other only through the settings rail (one navigation per screen).
/** soundExtras: the other sound settings (platform order sound, efood mute) shown with the POS sounds. */
export function SettingsRuntimePreferences({ soundExtras }: { soundExtras?: React.ReactNode } = {}) {
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
  const buttonClass = solidButton('secondary', 'md');

  return (
    <div className="space-y-5" data-testid="settings-runtime-preferences">
      <section className="pos-group">
        <div className="pos-row">
          <div className="pos-row__label">
            <h3 id={audioLabelId} className="pos-row__title">
              {t('settings.workflow.posSounds', { defaultValue: 'POS notification sounds' })}
            </h3>
            <p className="pos-row__help">
              {t('settings.workflow.posSoundsHelp', { defaultValue: 'Sounds for incoming orders, kiosk notifications and kitchen updates. Visual alerts stay active.' })}
            </p>
          </div>
          <div className="pos-row__control">
            <POSGlassSwitch aria-labelledby={audioLabelId} checked={audioEnabled}
              disabled={savingAudio} onChange={() => void saveAudio()} />
          </div>
        </div>
        <div className="pos-row pos-row--stack">
          <div className="flex items-center gap-3">
            <button type="button" disabled={!savedAudioEnabled || savingAudio} className={buttonClass} onClick={() => playAppAudioTest()}>
              {t('settings.workflow.testSound', { defaultValue: 'Test sound' })}
            </button>
            {savingAudio && <span role="status" className="text-sm liquid-glass-modal-text-muted">{t('settings.workflow.saving', { defaultValue: 'Saving…' })}</span>}
          </div>
          {audioError && <p role="alert" className="pos-notice pos-notice--bad text-sm">
            {t('settings.workflow.audioSaveFailed', { defaultValue: 'Could not save the sound setting.' })} {audioError}
          </p>}
        </div>
      </section>

      {soundExtras}

      <section className="pos-group">
        <header className="pos-group__head">
          <h3 className="pos-group__title">{t('settings.workflow.windowsDeviceSettings', { defaultValue: 'Windows device settings' })}</h3>
          <p className="pos-group__desc">
            {t('settings.workflow.windowsDeviceHelp', { defaultValue: 'Windows manages monitor brightness, speakers, pointer and touch feedback, and screen sleep. Open the relevant page to adjust this device.' })}
          </p>
        </header>
        <div className="grid gap-2 px-5 pb-4 pt-2 sm:grid-cols-2">
          {systemSections.map(({ section, label }) => (
            <button type="button" key={section} className={buttonClass} disabled={openingSection !== null}
              onClick={() => void openSystemSettings(section)}>
              {label}
            </button>
          ))}
        </div>
        {(openingSection || systemError) && (
          <div className="px-5 pb-4">
            {openingSection && <p role="status" className="text-sm liquid-glass-modal-text-muted">{t('settings.workflow.openingWindows', { defaultValue: 'Opening Windows settings…' })}</p>}
            {systemError && <p role="alert" className="pos-notice pos-notice--bad text-sm">
              {t('settings.workflow.windowsOpenFailed', { defaultValue: 'Could not open Windows settings.' })} {systemError}
            </p>}
          </div>
        )}
      </section>
    </div>
  );
}

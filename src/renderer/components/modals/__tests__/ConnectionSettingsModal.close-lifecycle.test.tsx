import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConnectionSettingsModal from '../ConnectionSettingsModal';

const mocks = vi.hoisted(() => ({
  bridge: {
    settings: { getAdminUrl: vi.fn(), getLocal: vi.fn() },
    terminalConfig: { getFullConfig: vi.fn() },
  },
}));
vi.mock('../../../../lib', () => ({ getBridge: () => mocks.bridge, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: any) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key }) }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: (key: string) => key }) }));
vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ enabledModules: [] }) }));
vi.mock('../../../hooks/useFeatures', () => ({ useFeatures: () => ({ features: {}, terminalType: 'main', posOperatingMode: 'standalone' }) }));
vi.mock('../../../hooks/useHardwareManager', () => ({ useHardwareManager: () => ({ status: {}, refresh: vi.fn(), loading: false, error: null }) }));
vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: vi.fn(), confirmationModal: null }) }));
vi.mock('../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({}), refreshTerminalCredentialCache: async () => ({}), updateTerminalCredentialCache: vi.fn() }));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: vi.fn() }));
vi.mock('../PrinterSettingsModal', () => ({ default: () => null }));
vi.mock('../../peripherals/CashRegisterSection', () => ({ default: () => null }));
vi.mock('../../peripherals/CallerIdSection', () => ({ default: () => null }));
vi.mock('../../ecr/PaymentTerminalsSection', () => ({ PaymentTerminalsSection: () => null }));
vi.mock('../../settings/WaiterDevicesSection', () => ({ WaiterDevicesSection: () => null }));
vi.mock('../../recovery/RecoveryPanel', () => ({ default: () => null }));
vi.mock('../../printing/PrintQueuePanel', () => ({ default: () => null }));
vi.mock('../../settings/SettingsRuntimePreferences', () => ({ SettingsRuntimePreferences: () => null }));
// LiquidGlassModal and ConfirmDialog deliberately stay real: their exit lifecycle
// must not remove the settings shell before the dirty-close request is accepted.

beforeEach(() => {
  localStorage.clear();
  mocks.bridge.settings.getAdminUrl.mockResolvedValue('https://admin.example.test');
  mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7' } });
  mocks.bridge.terminalConfig.getFullConfig.mockResolvedValue({ sync_health: 'polling' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

it.each(['Escape', 'backdrop'])('keeps the real settings modal editable after dirty %s close is cancelled', async (trigger) => {
  const onClose = vi.fn();
  render(<ConnectionSettingsModal isOpen onClose={onClose} />);
  await screen.findByText('Settings are up to date');
  fireEvent.click(screen.getByRole('button', { name: /^Devices\s*Scale, scanner and hardware/i }));
  fireEvent.change(screen.getByDisplayValue('COM7'), { target: { value: 'COM9' } });
  const settings = screen.getByRole('dialog', { name: 'modals.connectionSettings.title' });

  if (trigger === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
  else fireEvent.click(settings.parentElement!.querySelector('.liquid-glass-modal-backdrop')!);

  const confirmation = await screen.findByRole('dialog', { name: 'Unsaved device changes' });
  expect(settings).not.toHaveClass('leaving');
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  fireEvent.animationEnd(confirmation, { animationName: 'modal-close' });
  // jsdom lacks AnimationEvent, so React may register its prefixed fallback.
  fireEvent(confirmation, new Event('webkitAnimationEnd', { bubbles: true }));

  expect(screen.queryByRole('dialog', { name: 'Unsaved device changes' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'modals.connectionSettings.title' })).toBe(settings);
  expect(screen.getByDisplayValue('COM9')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

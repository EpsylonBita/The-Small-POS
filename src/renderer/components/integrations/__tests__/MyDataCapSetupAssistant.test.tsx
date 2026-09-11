import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyDataCapSetupAssistant } from '../MyDataCapSetupAssistant';

const mocks = vi.hoisted(() => ({ capSetup: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ ecr: { capSetup: mocks.capSetup } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
vi.mock('../../ui/pos-glass-components', () => ({
  POSGlassButton: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button>,
}));
const missing = { success: true, platformSupported: true, serviceInstalled: false, serviceRunning: false };
const running = { ...missing, serviceInstalled: true, serviceRunning: true, settings: { capturePath: 'D:\\CAP' } };

describe('CAP installation assistant', () => {
  beforeEach(() => {
    mocks.capSetup.mockReset();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(cleanup);

  it('only launches the official installer after an explicit click and refreshes without claiming connected', async () => {
    mocks.capSetup.mockResolvedValue(missing);
    const onDetected = vi.fn();
    render(<MyDataCapSetupAssistant scopeKey="branch-a/terminal-a" onDetected={onDetected} disabled={false} />);
    const install = await screen.findByRole('button', { name: 'Install RBS support' });
    expect(mocks.capSetup.mock.calls.map(call => call[0])).toEqual(['status']);
    mocks.capSetup.mockResolvedValueOnce({ ...missing, installerLaunched: true }).mockResolvedValueOnce(missing);
    fireEvent.click(install);
    await screen.findByText('Installer opened. Complete the Windows prompts, then refresh. The cashier is not verified yet.');
    await waitFor(() => expect(mocks.capSetup.mock.calls.map(call => call[0])).toEqual(['status', 'open_installer', 'status']));
    expect(onDetected).not.toHaveBeenCalled();
    expect(screen.getByText('RBS support is not installed. Open the official installer and complete its setup.')).toBeInTheDocument();
  });

  it('uses the installed service and focus refresh without opening or downloading setup again', async () => {
    mocks.capSetup.mockResolvedValue(running);
    const onDetected = vi.fn();
    render(<MyDataCapSetupAssistant scopeKey="branch-a/terminal-a" onDetected={onDetected} disabled={false} />);
    await screen.findByText('RBS service is running. Check the connection details, then connect and test the cashier.');
    expect(onDetected).toHaveBeenCalledWith(running);
    expect(screen.queryByRole('button', { name: 'Install RBS support' })).not.toBeInTheDocument();
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.capSetup).toHaveBeenCalledTimes(2));
    expect(mocks.capSetup).not.toHaveBeenCalledWith('open_installer');
  });

  it('offers connection setup when installed but stopped', async () => {
    mocks.capSetup.mockResolvedValue({ ...running, serviceRunning: false });
    render(<MyDataCapSetupAssistant scopeKey="a" onDetected={vi.fn()} disabled={false} />);
    await screen.findByRole('button', { name: 'Open connection setup' });
    expect(mocks.capSetup).not.toHaveBeenCalledWith('open_installer');
  });

  it('allows an explicit vendor setup action while running so its actual target can be changed', async () => {
    mocks.capSetup.mockResolvedValue(running);
    render(<MyDataCapSetupAssistant scopeKey="a" onDetected={vi.fn()} disabled={false} />);
    const open = await screen.findByRole('button', { name: 'Open connection setup' });
    expect(mocks.capSetup).not.toHaveBeenCalledWith('open_installer');
    fireEvent.click(open);
    await waitFor(() => expect(mocks.capSetup).toHaveBeenCalledWith('open_installer'));
  });

  it('allows vendor setup to repair unreadable installed configuration without reporting a matching target', async () => {
    mocks.capSetup.mockResolvedValue({ ...running, success: false, code: 'ini_unreadable', target: undefined });
    const onStatus = vi.fn();
    render(<MyDataCapSetupAssistant scopeKey="a" onDetected={vi.fn()} onStatus={onStatus} disabled={false} />);
    const open = await screen.findByRole('button', { name: 'Open connection setup' });
    expect(open).toBeEnabled();
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ success: false }));
    fireEvent.click(open);
    await waitFor(() => expect(mocks.capSetup).toHaveBeenCalledWith('open_installer'));
  });

  it('discards a delayed status result after branch or terminal scope changes', async () => {
    let oldResult!: (value: unknown) => void;
    mocks.capSetup.mockReturnValueOnce(new Promise(resolve => { oldResult = resolve; })).mockResolvedValue(running);
    const onDetected = vi.fn();
    const view = render(<MyDataCapSetupAssistant scopeKey="branch-a/terminal-a" onDetected={onDetected} disabled={false} />);
    view.rerender(<MyDataCapSetupAssistant scopeKey="branch-b/terminal-b" onDetected={onDetected} disabled={false} />);
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(running));
    await act(async () => oldResult({ ...running, settings: { capturePath: 'D:\\WrongBranch' } }));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('shows a recoverable check failure and never installs automatically', async () => {
    mocks.capSetup.mockRejectedValueOnce(new Error('native unavailable')).mockResolvedValue(running);
    render(<MyDataCapSetupAssistant scopeKey="a" onDetected={vi.fn()} disabled={false} />);
    await screen.findByText('Could not complete the support check or installer action. Refresh and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh support status' }));
    await screen.findByText('RBS service is running. Check the connection details, then connect and test the cashier.');
    expect(mocks.capSetup).not.toHaveBeenCalledWith('open_installer');
  });
});

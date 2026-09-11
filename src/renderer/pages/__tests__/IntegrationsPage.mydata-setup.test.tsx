import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((_section: string, key: string) => {
    if (key === 'branch_id') return 'branch-1'
    if (key === 'organization_id') return 'org-1'
    return null
  }),
  getDevices: vi.fn(),
  addDevice: vi.fn(),
  updateDevice: vi.fn(),
  connectDevice: vi.fn(),
  testConnection: vi.fn(),
  capSetup: vi.fn(),
  capDiscover: vi.fn(),
  translate: (_key: string, fallback: string) => fallback,
  openExternalUrl: vi.fn(),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    section: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <section {...props}>{children}</section>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mocks.translate,
  }),
}))

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('../../utils/format', () => ({
  formatTime: (value: string) => value,
}))

vi.mock('../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: {
    DELIVERY: 'delivery',
    ROOMS: 'rooms',
    PRODUCT_CATALOG: 'product_catalog',
    STAFF_SCHEDULE: 'staff_schedule',
  },
  useAcquiredModules: () => ({
    isLoading: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('../../components/ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    children,
    isOpen,
    title,
  }: {
    children: React.ReactNode
    isOpen: boolean
    title: React.ReactNode
  }) => (isOpen ? <div role="dialog" aria-label={String(title)}>{children}</div> : null),
  POSGlassButton: ({
    children,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  POSGlassInput: ({
    label,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiPost: mocks.posApiPost,
}))

vi.mock('../../utils/external-url', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock('../../hooks/useTerminalSettings', () => ({
  useTerminalSettings: () => ({
    getSetting: mocks.getSetting,
  }),
}))

vi.mock('../../services/offline-page-capabilities', () => ({
  getOfflineActionState: () => ({ disabled: false, message: null }),
}))

vi.mock('../../utils/plugin-icons', () => ({
  getPluginLogo: () => null,
}))

vi.mock('../../components/ui/page-motion', () => ({
  pageMotionContainer: {},
  pageMotionItem: {},
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    ecr: {
      getDevices: mocks.getDevices,
      addDevice: mocks.addDevice,
      updateDevice: mocks.updateDevice,
      connectDevice: mocks.connectDevice,
      testConnection: mocks.testConnection,
      capSetup: mocks.capSetup,
      capDiscover: mocks.capDiscover,
      disconnectDevice: vi.fn(),
    },
  }),
}))

vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ terminalId: 'terminal-1' }),
}))

import IntegrationsPage from '../IntegrationsPage'


const cap = { capturePath: 'D:\\CAP', outputPath: 'D:\\CAP\\OUT', serviceName: 'VendorCAP', fileEncoding: 'windows-1253', transactionTimeoutMs: 180000, cashPaymentCode: 4, cardPaymentCode: 6, eftPosIndex: 8, probeDeviceTcp: false };
const savedConnection = { type: 'network', host: '192.168.1.50', protocol: 'cap_driver', brand: 'RBS', model: 'configured model', department_map: { A: 1, B: 2, C: 3, D: 4 } };
function serve(connection: Record<string, unknown> = savedConnection) {
  mocks.posApiGet.mockImplementation(async (path: string) => ({
    success: true,
    data: path === '/pos/mydata/config'
      ? { config: { mode: 'fiscal_device', device_connection: connection }, provider_status: { is_enabled: false } }
      : { integrations: [{ plugin_id: 'mydata', name: 'MyData', category: 'government', is_purchased: true, status: 'pending' }] },
  }));
}
async function openSetup() {
  render(<IntegrationsPage />);
  await screen.findByRole('heading', { name: 'MyData' });
  fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
  return screen.findByRole('dialog');
}

describe('myDATA guided desktop setup', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mocks.getDevices.mockResolvedValue([{ id: 'mydata-fiscal-device', protocol: 'cap_driver', settings: cap }]);
    mocks.addDevice.mockResolvedValue({ success: true });
    mocks.updateDevice.mockResolvedValue({ success: true });
    mocks.connectDevice.mockResolvedValue({ success: true });
    mocks.testConnection.mockResolvedValue({ success: true, connected: true });
    mocks.capSetup.mockResolvedValue({ success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true, target: { type: 'network', host: savedConnection.host } });
    mocks.capDiscover.mockResolvedValue({ success: true, candidates: [] });
    mocks.posApiPost.mockResolvedValue({ success: true, data: { config: { mode: 'fiscal_device', device_connection: savedConnection } } });
  });
  afterEach(cleanup);

  it('loads advanced settings collapsed and reconnects CAP LAN with no guessed port', async () => {
    serve();
    await openSetup();
    await waitFor(() => expect(screen.getByLabelText('Capture folder')).toHaveValue(cap.capturePath));
    const modal = screen.getByRole('dialog');
    const advanced = within(modal).getByText('CAP Driver advanced settings').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(within(modal).getByLabelText('Device ERP port')).toHaveValue('');
    const submit = within(modal).getByRole('button', { name: 'Connect, test & save' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.posApiPost).toHaveBeenCalledWith('/pos/mydata/config', expect.objectContaining({ status: 'connected' })));
    const native = mocks.updateDevice.mock.calls[0][1];
    expect(native.settings).toMatchObject({ ...cap, requireService: true });
    expect(native.connectionDetails).toEqual({ ip: savedConnection.host });
    expect(mocks.posApiPost.mock.calls[0][1].device_connection).not.toHaveProperty('port');
  });

  it('retains a saved serial target and visibly disables direct Bluetooth', async () => {
    serve({ ...savedConnection, type: 'usb_serial', serial_port: 'COM7', baud_rate: 19200 });
    const modal = await openSetup();
    expect(within(modal).getByLabelText('Serial port')).toHaveValue('COM7');
    expect(within(modal).getByRole('option', { name: 'Bluetooth — unavailable' })).toBeDisabled();
  });

  it('does not publish connected when the native handshake is incomplete', async () => {
    serve();
    mocks.testConnection.mockResolvedValue({ success: true, connected: false });
    await openSetup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Connect, test & save' }));
    await waitFor(() => expect(mocks.testConnection).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeEnabled());
    expect(mocks.posApiPost).not.toHaveBeenCalled();
  });

  it('prefills installed CAP settings without overwriting a target edited while status is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.capSetup.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mocks.getDevices.mockResolvedValue([]);
    serve({ protocol: 'cap_driver' });
    await openSetup();
    await waitFor(() => expect(mocks.capSetup).toHaveBeenCalledWith('status'));
    fireEvent.change(screen.getByLabelText('Device IP address or host'), { target: { value: '192.168.1.99' } });
    fireEvent.change(screen.getByLabelText('Capture folder'), { target: { value: 'D:\\Edited' } });
    fireEvent.change(screen.getByLabelText('Output folder'), { target: { value: 'D:\\Edited\\Out' } });
    await act(async () => finish({ success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true,
      settings: { capturePath: 'D:\\Detected', outputPath: 'D:\\Detected\\Out', fileEncoding: 'windows-1253' },
      target: { type: 'network', host: '192.168.1.8' } }));
    expect(screen.getByLabelText('Device IP address or host')).toHaveValue('192.168.1.99');
    expect(screen.getByLabelText('Capture folder')).toHaveValue('D:\\Edited');
    expect(screen.getByLabelText('Output folder')).toHaveValue('D:\\Edited\\Out');
    expect(mocks.capSetup).not.toHaveBeenCalledWith('open_installer');
  });

  it('selects a discovered IP explicitly but requires the vendor service target to match before connecting', async () => {
    serve();
    mocks.capDiscover.mockResolvedValue({ success: true, candidates: [{ host: '192.168.1.169', detectedFamily: 'rbs_mat', label: 'MAT ECR', verification: 'network_only' }] });
    await openSetup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeEnabled());
    expect(mocks.capDiscover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find cashier' }));
    const candidate = await screen.findByRole('button', { name: 'Select MAT ECR · 192.168.1.169' });
    expect(screen.getByLabelText('Device IP address or host')).toHaveValue(savedConnection.host);
    fireEvent.click(candidate);
    expect(screen.getByLabelText('Device IP address or host')).toHaveValue('192.168.1.169');
    expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open connection setup' })).toBeEnabled();
    expect(mocks.connectDevice).not.toHaveBeenCalled();
    expect(mocks.posApiPost).not.toHaveBeenCalled();
    mocks.capSetup.mockResolvedValue({ success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true, target: { type: 'network', host: '192.168.1.169' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh support status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeEnabled());
    expect(screen.getByLabelText('Device IP address or host')).toHaveValue('192.168.1.169');
    expect(mocks.connectDevice).not.toHaveBeenCalled();
  });

  it('blocks connect if installed service target cannot be read', async () => {
    serve();
    mocks.capSetup.mockResolvedValue({ success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true });
    await openSetup();
    await screen.findByText('RBS service is running. Check the connection details, then connect and test the cashier.');
    expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeDisabled();
    expect(mocks.connectDevice).not.toHaveBeenCalled();
  });

  it.each(['CAP_SETUP_CODEPAGE_UNSUPPORTED', 'CONFIG_UNREADABLE', 'CAP_SETUP_CODEPAGE_MISSING'])('blocks a matching target with native status code %s and explains how to fix it', async code => {
    serve();
    mocks.capSetup.mockResolvedValue({ success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true, target: { type: 'network', host: savedConnection.host }, code });
    await openSetup();
    await screen.findByText('RBS service is running. Check the connection details, then connect and test the cashier.');
    expect(screen.getByRole('button', { name: 'Connect, test & save' })).toBeDisabled();
    expect(screen.getByText('The CAP service target is unavailable or differs from this form. Open connection setup, configure this IP or COM port in the vendor service, then refresh support status.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open connection setup' })).toBeEnabled();
    expect(mocks.connectDevice).not.toHaveBeenCalled();
    expect(mocks.posApiPost).not.toHaveBeenCalled();
  });
});

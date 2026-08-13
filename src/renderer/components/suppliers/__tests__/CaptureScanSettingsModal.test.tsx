/**
 * invoice-scan-capture task 12.6 — the scan settings modal.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**.
 * Requirements R1.3, R1.4, R2.1–R2.6, R3.1, R3.9, R12.5, R14.4, R15.5.
 *
 * What is worth pinning here is the *shape of each add flow*, because those are
 * the promises a shopkeeper judges the feature by:
 *
 * - A scanner is added in four visible steps — pick, see a real test page, name
 *   it, save — and never more (R2.1–R2.3, R15.5).
 * - An empty discovery is **not an error**: it points at the scan folder, the
 *   path that needs no driver at all (R2.4).
 * - The folder flow saves *before* the guided test, because saving is what
 *   starts the watching, and the arrival of a real file is the confirmation
 *   (R3.1, R3.9).
 * - Forgetting a source never touches a captured invoice (R2.6) — the sentence
 *   the user is shown has to say so, and it does.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadCaptureSources: vi.fn(),
  loadDefaultCaptureSourceId: vi.fn(),
  saveCaptureSources: vi.fn(async () => undefined),
  listScanners: vi.fn(),
  testScanner: vi.fn(),
  getCaptureTestPreview: vi.fn(async () => 'data:image/png;base64,TEST'),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../../test/en-translate');
  return { useTranslation: useTranslationEn };
});

vi.mock('react-hot-toast', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mocks.openDialog(...args),
}));

vi.mock('../../../services/capture-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/capture-client')>();
  return {
    ...actual,
    loadCaptureSources: mocks.loadCaptureSources,
    loadDefaultCaptureSourceId: mocks.loadDefaultCaptureSourceId,
    saveCaptureSources: mocks.saveCaptureSources,
    listScanners: mocks.listScanners,
    testScanner: mocks.testScanner,
    getCaptureTestPreview: mocks.getCaptureTestPreview,
  };
});

import CaptureScanSettingsModal, { folderDisplayName } from '../CaptureScanSettingsModal';

const SCANNER_SOURCE = {
  id: 'src-1',
  kind: 'connected_scanner' as const,
  name: 'Back office scanner',
  isDefault: true,
  deviceId: 'device-1',
};

const FOLDER_SOURCE = {
  id: 'src-2',
  kind: 'watched_folder' as const,
  name: 'Scans',
  isDefault: false,
  folderPath: 'D:\\Shared\\Scans',
  housekeeping: 'none' as const,
};

function renderModal(overrides: Record<string, unknown> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onSourcesChanged: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CaptureScanSettingsModal {...(props as never)} />) };
}

beforeEach(() => {
  mocks.loadCaptureSources.mockResolvedValue([]);
  mocks.loadDefaultCaptureSourceId.mockResolvedValue(null);
  mocks.listScanners.mockResolvedValue({ ok: true, devices: [{ deviceId: 'device-1', name: 'HP OfficeJet' }] });
  mocks.testScanner.mockResolvedValue({ ok: true, path: 'C:/captures/_test/page.png' });
  mocks.openDialog.mockResolvedValue('D:\\Shared\\Scans');
});

afterEach(() => {
  cleanup();
});

describe('folderDisplayName', () => {
  it('names a folder by its last segment, whichever slash the platform uses', () => {
    expect(folderDisplayName('D:\\Shared\\Scans')).toBe('Scans');
    expect(folderDisplayName('/mnt/office/scans/')).toBe('scans');
    expect(folderDisplayName('')).toBe('Scan folder');
  });
});

describe('CaptureScanSettingsModal', () => {
  it('offers both add paths, in plain language, when nothing is configured', async () => {
    renderModal();

    expect(await screen.findByText('No scanner set up yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Add the scanner sitting next to this till, or point us at the folder your machine saves scans into.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a scanner' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch a scan folder' })).toBeInTheDocument();
  });

  it('lists saved sources with a live status chip and a plain kind label', async () => {
    mocks.loadCaptureSources.mockResolvedValue([SCANNER_SOURCE, FOLDER_SOURCE]);
    mocks.loadDefaultCaptureSourceId.mockResolvedValue('src-1');
    renderModal();

    expect(await screen.findByText('Back office scanner')).toBeInTheDocument();
    expect(screen.getByTestId('capture-source-status-src-1')).toHaveTextContent('Ready');
    // A watched folder reads as "watching", not as an idle device.
    expect(screen.getByTestId('capture-source-status-src-2')).toHaveTextContent('Watching');
    expect(screen.getByText(/Scanner at this till/)).toBeInTheDocument();
    expect(screen.getByText(/Scan folder/)).toBeInTheDocument();
  });

  it('walks pick -> visible test page -> name -> save in four steps', async () => {
    renderModal();
    await screen.findByText('No scanner set up yet');

    // 1. Pick
    fireEvent.click(screen.getByRole('button', { name: 'Add a scanner' }));
    expect(
      await screen.findByText('Pick the machine you want to scan from.'),
    ).toBeInTheDocument();

    // 2. One test page, shown as an image the user can judge
    fireEvent.click(await screen.findByRole('button', { name: /HP OfficeJet/ }));
    const preview = await screen.findByAltText('Test page');
    expect(preview).toHaveAttribute('src', 'data:image/png;base64,TEST');
    expect(mocks.testScanner).toHaveBeenCalledWith('device-1');

    // 3. Name it
    fireEvent.click(screen.getByRole('button', { name: 'That looks right' }));
    const nameField = await screen.findByLabelText('What should we call it?');
    expect(nameField).toHaveValue('HP OfficeJet');
    fireEvent.change(nameField, { target: { value: 'Back office scanner' } });

    // 4. Save
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(mocks.saveCaptureSources).toHaveBeenCalled());
    const [saved, defaultId] = mocks.saveCaptureSources.mock.calls.at(-1) as [
      Array<Record<string, unknown>>,
      string | null,
    ];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'connected_scanner',
      name: 'Back office scanner',
      deviceId: 'device-1',
      isDefault: true,
    });
    expect(defaultId).toBe(saved[0].id);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Saved. You can scan from here now.');
  });

  it('treats an empty discovery as a signpost to the scan folder, not an error', async () => {
    mocks.listScanners.mockResolvedValue({ ok: true, devices: [] });
    renderModal();
    await screen.findByText('No scanner set up yet');

    fireEvent.click(screen.getByRole('button', { name: 'Add a scanner' }));

    expect(await screen.findByText('We could not find a scanner here.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No problem — most machines can save scans straight into a folder. Point us at that folder instead.',
      ),
    ).toBeInTheDocument();
    // The way out is offered right there.
    expect(screen.getAllByRole('button', { name: 'Watch a scan folder' }).length).toBeGreaterThan(0);
  });

  it('turns a discovery failure into a sentence rather than a device code', async () => {
    mocks.listScanners.mockResolvedValue({ ok: false, code: 'device_offline' });
    renderModal();
    await screen.findByText('No scanner set up yet');

    fireEvent.click(screen.getByRole('button', { name: 'Add a scanner' }));

    expect(
      await screen.findByText(
        'The scanner is switched off or unplugged. Turn it on and try again.',
      ),
    ).toBeInTheDocument();
  });

  it('saves a watched folder before the guided test, then confirms on real arrival', async () => {
    const { props } = renderModal();
    await screen.findByText('No scanner set up yet');

    fireEvent.click(screen.getByRole('button', { name: 'Watch a scan folder' }));

    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledWith({ directory: true, multiple: false }));
    // Saved first: saving is what starts the folder being watched, and the
    // guided test needs a live watcher to notice the file.
    await waitFor(() => expect(mocks.saveCaptureSources).toHaveBeenCalled());
    const [saved] = mocks.saveCaptureSources.mock.calls.at(-1) as [Array<Record<string, unknown>>];
    expect(saved[0]).toMatchObject({
      kind: 'watched_folder',
      name: 'Scans',
      folderPath: 'D:\\Shared\\Scans',
      housekeeping: 'none',
    });
    expect(props.onSourcesChanged).toHaveBeenCalled();

    expect(
      await screen.findByText(
        'Now press Scan on your machine. We are watching this folder and will say when it arrives.',
      ),
    ).toBeInTheDocument();

    // The arrival of a real file is the confirmation.
    const arrivedHandler = mocks.onEvent.mock.calls.find(
      ([event]) => event === 'capture:document-arrived',
    )?.[1] as (payload: unknown) => void;
    expect(arrivedHandler).toBeTypeOf('function');
    fireEvent(window, new Event('noop'));
    arrivedHandler({ captureId: 'cap-1' });

    expect(await screen.findByText('It worked — your scan came through.')).toBeInTheDocument();
  });

  it('says so plainly when the folder picker will not open', async () => {
    mocks.openDialog.mockRejectedValue(new Error('no dialog'));
    renderModal();
    await screen.findByText('No scanner set up yet');

    fireEvent.click(screen.getByRole('button', { name: 'Watch a scan folder' }));

    expect(
      await screen.findByText('Could not open the folder picker. Try again.'),
    ).toBeInTheDocument();
    expect(mocks.saveCaptureSources).not.toHaveBeenCalled();
  });

  it('does nothing at all when the folder pick is cancelled', async () => {
    mocks.openDialog.mockResolvedValue(null);
    renderModal();
    await screen.findByText('No scanner set up yet');

    fireEvent.click(screen.getByRole('button', { name: 'Watch a scan folder' }));

    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled());
    expect(mocks.saveCaptureSources).not.toHaveBeenCalled();
  });

  it('confirms before forgetting a source and promises the captures are safe', async () => {
    mocks.loadCaptureSources.mockResolvedValue([SCANNER_SOURCE]);
    mocks.loadDefaultCaptureSourceId.mockResolvedValue('src-1');
    renderModal();
    await screen.findByText('Back office scanner');

    fireEvent.click(screen.getByLabelText('Remove'));

    expect(
      await screen.findByText(
        'Remove this from the till? Invoices you already scanned stay exactly where they are.',
      ),
    ).toBeInTheDocument();

    // Two controls answer to "Remove": the row's icon button (which only opens
    // the confirmation) and the confirmation's own button. Only the second one
    // carries visible text, and only it actually removes anything.
    const confirmRemove = screen
      .getAllByRole('button', { name: 'Remove' })
      .find((button) => button.textContent?.trim() === 'Remove');
    expect(confirmRemove).toBeDefined();
    fireEvent.click(confirmRemove!);

    await waitFor(() => expect(mocks.saveCaptureSources).toHaveBeenCalledWith([], null));
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'Removed. Your scanned invoices are untouched.',
      ),
    );
  });

  it('moves the default to another source without touching the source list', async () => {
    mocks.loadCaptureSources.mockResolvedValue([SCANNER_SOURCE, FOLDER_SOURCE]);
    mocks.loadDefaultCaptureSourceId.mockResolvedValue('src-1');
    renderModal();
    await screen.findByText('Scans');

    fireEvent.click(screen.getAllByLabelText('Use this one by default')[1]);

    await waitFor(() =>
      expect(mocks.saveCaptureSources).toHaveBeenCalledWith(
        [SCANNER_SOURCE, FOLDER_SOURCE],
        'src-2',
      ),
    );
  });

  it('reflects a live unavailable status from the watcher', async () => {
    mocks.loadCaptureSources.mockResolvedValue([FOLDER_SOURCE]);
    renderModal();
    await screen.findByText('Scans');

    const statusHandler = mocks.onEvent.mock.calls.find(
      ([event]) => event === 'capture:source-status',
    )?.[1] as (payload: unknown) => void;
    statusHandler({ sourceId: 'src-2', status: 'unavailable' });

    await waitFor(() =>
      expect(screen.getByTestId('capture-source-status-src-2')).toHaveTextContent('Not reachable'),
    );
  });

  it('renders nothing while closed', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });
});

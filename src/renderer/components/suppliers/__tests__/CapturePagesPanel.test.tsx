/**
 * invoice-scan-capture task 12.6 — the page accumulation view.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**.
 * Requirements R5.1, R5.2, R12.3, R15.6, R17.1.
 *
 * The contract this pins is a *shape* contract as much as a behaviour one:
 *
 * - "Add another page" and "Done" must be **equal** choices — same classes,
 *   same size, side by side. A test that only checked both exist would pass on
 *   a wizard that renders Done as a faint link under a giant Add button, which
 *   is exactly the thing R5.1 forbids.
 * - Remove / re-scan / reorder must all be present and none of them required:
 *   Done stays reachable without touching any of them (R5.2, R15.6).
 * - The ten-page cap must read as a sentence offering to finish and start
 *   another, never as a refusal (R12.3).
 *
 * Copy is resolved from the real `en.json`, so every assertion here is also an
 * assertion that the key shipped.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCaptureDocument: vi.fn(),
  getCapturePagePreview: vi.fn(async () => 'data:image/png;base64,AAA'),
  rotateCapturePage: vi.fn(async () => ({ success: true })),
  removeCapturePage: vi.fn(async () => ({ success: true })),
  reorderCapturePages: vi.fn(async () => ({ success: true })),
  acquireFromScanner: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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

vi.mock('../../../services/capture-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/capture-client')>();
  return {
    ...actual,
    getCaptureDocument: mocks.getCaptureDocument,
    getCapturePagePreview: mocks.getCapturePagePreview,
    removeCapturePage: mocks.removeCapturePage,
    rotateCapturePage: mocks.rotateCapturePage,
    reorderCapturePages: mocks.reorderCapturePages,
    acquireFromScanner: mocks.acquireFromScanner,
  };
});

import CapturePagesPanel, { movedOrder } from '../CapturePagesPanel';

function page(index: number) {
  return {
    pageIndex: index,
    filePath: `C:/captures/cap-1/page-00${index}.png`,
    contentHash: `hash-${index}`,
    byteSize: 2048,
    mime: 'image/png',
  };
}

function documentWith(pageCount: number) {
  return {
    document: {
      captureId: 'cap-1',
      status: 'capturing',
      sourceKind: 'connected_scanner',
      sourceName: 'Back office scanner',
      staffId: 'staff-1',
      capturedAt: '2026-08-06T09:00:00.000Z',
      pageCount,
      recognition: null,
      draft: null,
      storageKeys: [],
      reasonCode: null,
      attempts: 0,
      updatedAt: '2026-08-06T09:00:00.000Z',
      pages: Array.from({ length: pageCount }, (_unused, index) => page(index)),
    },
  };
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = {
    isOpen: true,
    captureId: 'cap-1',
    deviceId: 'device-1',
    sourceName: 'Back office scanner',
    onClose: vi.fn(),
    onDone: vi.fn(async () => undefined),
    onFinishAndStartAnother: vi.fn(async () => undefined),
    ...overrides,
  };
  return { props, ...render(<CapturePagesPanel {...(props as never)} />) };
}

beforeEach(() => {
  mocks.getCaptureDocument.mockResolvedValue(documentWith(2));
  mocks.acquireFromScanner.mockResolvedValue({
    ok: true,
    pages: [page(0), page(1), page(2)],
    feederUsed: false,
    reachedPageCap: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('movedOrder', () => {
  it('expresses a move as the desired sequence of current indexes', () => {
    expect(movedOrder(4, 2, 0)).toEqual([2, 0, 1, 3]);
    expect(movedOrder(4, 0, 3)).toEqual([1, 2, 3, 0]);
  });

  it('leaves the order untouched when either end is out of range', () => {
    expect(movedOrder(3, -1, 1)).toEqual([0, 1, 2]);
    expect(movedOrder(3, 1, 9)).toEqual([0, 1, 2]);
  });
});

describe('CapturePagesPanel', () => {
  it('renders every accumulated page with remove, re-scan and reorder controls', async () => {
    renderPanel();

    await screen.findByTestId('capture-page-0');
    expect(screen.getByTestId('capture-page-1')).toBeInTheDocument();

    const first = screen.getByTestId('capture-page-0');
    expect(within(first).getByLabelText('Remove this page')).toBeInTheDocument();
    expect(within(first).getByLabelText('Scan this page again')).toBeInTheDocument();
    expect(within(first).getByLabelText('Move later')).toBeInTheDocument();
    // The first page cannot move earlier — the control is present but inert.
    expect(within(first).getByLabelText('Move earlier')).toBeDisabled();
  });

  it('presents "Add another page" and "Done" as two equal choices', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-0');

    const add = screen.getByTestId('capture-add-page');
    const done = screen.getByTestId('capture-done');

    // Same parent, so they sit side by side rather than one above the other.
    expect(add.parentElement).toBe(done.parentElement);
    // Two columns, not a primary/secondary stack.
    expect(add.parentElement?.className).toContain('sm:grid-cols-2');
    // Identical chrome: neither is visually subordinate to the other.
    expect(add.className).toBe(done.className);
    expect(add).toHaveTextContent('Add another page');
    expect(done).toHaveTextContent('Done');
  });

  it('keeps Done reachable without using any of the secondary options', async () => {
    const { props } = renderPanel();
    await screen.findByTestId('capture-page-0');

    fireEvent.click(screen.getByTestId('capture-done'));

    await waitFor(() => expect(props.onDone).toHaveBeenCalledWith('cap-1'));
    expect(mocks.removeCapturePage).not.toHaveBeenCalled();
    expect(mocks.reorderCapturePages).not.toHaveBeenCalled();
  });

  it('removes a page through the store and re-reads the strip', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-1');

    fireEvent.click(
      within(screen.getByTestId('capture-page-1')).getByLabelText('Remove this page'),
    );

    await waitFor(() => expect(mocks.removeCapturePage).toHaveBeenCalledWith('cap-1', 1));
  });

  it('reorders by moving the chosen page into its new slot', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-1');

    fireEvent.click(within(screen.getByTestId('capture-page-1')).getByLabelText('Move earlier'));

    await waitFor(() => expect(mocks.reorderCapturePages).toHaveBeenCalledWith('cap-1', [1, 0]));
  });

  it('requests exactly one replacement and never deletes or reorders pages in the renderer', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-0');
    fireEvent.click(within(screen.getByTestId('capture-page-0')).getByLabelText('Scan this page again'));
    await waitFor(() => expect(mocks.acquireFromScanner).toHaveBeenCalledWith({
      captureId: 'cap-1', deviceId: 'device-1', replacePageIndex: 0,
    }));
    expect(mocks.removeCapturePage).not.toHaveBeenCalled();
    expect(mocks.reorderCapturePages).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Page replaced.'));
  });

  it('keeps the original page when the re-scan fails', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-0');

    mocks.acquireFromScanner.mockResolvedValue({ ok: false, code: 'device_busy' });

    fireEvent.click(
      within(screen.getByTestId('capture-page-0')).getByLabelText('Scan this page again'),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'The scanner is busy with another job. Try again in a moment.',
      ),
    );
    expect(mocks.removeCapturePage).not.toHaveBeenCalled();
  });

  it('maps an unknown scanner code to a sentence, never to the raw code', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-0');

    mocks.acquireFromScanner.mockResolvedValue({ ok: false, code: 'WIA_ERROR_0x80210015' });

    fireEvent.click(screen.getByTestId('capture-add-page'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    const message = String(mocks.toastError.mock.calls.at(-1)?.[0]);
    expect(message).toBe('The scanner did not answer. Check it is on and connected.');
    expect(message).not.toContain('WIA');
  });

  it('holds a page-capped invoice together and permits a one-page replacement at the cap', async () => {
    mocks.getCaptureDocument.mockResolvedValue(documentWith(10));
    const { props } = renderPanel();
    const message = await screen.findByTestId('capture-page-cap');
    expect(message).toHaveTextContent('Keep the complete invoice together');
    expect(screen.getByTestId('capture-add-page')).toBeDisabled();
    expect(screen.getByTestId('capture-done')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Finish this one and start another' })).toBeNull();
    fireEvent.click(within(screen.getByTestId('capture-page-4')).getByLabelText('Scan this page again'));
    await waitFor(() => expect(mocks.acquireFromScanner).toHaveBeenCalledWith({
      captureId: 'cap-1', deviceId: 'device-1', replacePageIndex: 4,
    }));
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('observes the first scan, blocks edits, then refreshes and enables Done without Add', async () => {
    mocks.getCaptureDocument.mockResolvedValue(documentWith(0));
    const { rerender, props } = renderPanel({ acquisitionBusy: true, refreshToken: 1 });
    expect(screen.getByTestId('capture-add-page')).toBeDisabled();
    expect(screen.getByTestId('capture-done')).toBeDisabled();
    mocks.getCaptureDocument.mockResolvedValue(documentWith(1));
    rerender(<CapturePagesPanel {...(props as never)} acquisitionBusy={false} refreshToken={2} />);
    await screen.findByTestId('capture-page-0');
    await waitFor(() => expect(screen.getByTestId('capture-done')).toBeEnabled());
    expect(mocks.acquireFromScanner).not.toHaveBeenCalled();
  });

  it('keeps a durable partial scan on hold instead of enabling Done', async () => {
    mocks.getCaptureDocument.mockResolvedValue({ document: { ...documentWith(2).document, reasonCode: 'scan_incomplete' } });
    renderPanel();
    await screen.findByTestId('capture-page-0');
    expect(screen.getByTestId('capture-done')).toBeDisabled();
    expect(screen.getByTestId('capture-add-page')).toBeEnabled();
    expect(screen.getByTestId('capture-pages-notice')).toHaveTextContent('The scanner stopped');
  });

  it('observes native acquisition after closing and reopening the panel', async () => {
    mocks.getCaptureDocument.mockResolvedValue({ document: { ...documentWith(1).document, acquiring: true } });
    renderPanel();
    await screen.findByTestId('capture-page-0');
    expect(screen.getByTestId('capture-add-page')).toBeDisabled();
    expect(within(screen.getByTestId('capture-page-0')).getByLabelText('Scan this page again')).toBeDisabled();
  });

  it('says the run was cut short instead of letting it look like a clean finish', async () => {
    // The other half of keeping the pages a busy device already delivered. On a
    // genuine feeder that break leaves sheets in the tray, and a success with
    // no notice is how somebody presses Done over half an invoice.
    renderPanel();
    await screen.findByTestId('capture-page-0');

    mocks.acquireFromScanner.mockResolvedValue({
      ok: true,
      pages: [page(0), page(1)],
      feederUsed: true,
      reachedPageCap: false,
      stoppedEarly: true,
    });

    fireEvent.click(screen.getByTestId('capture-add-page'));

    const notice = await screen.findByTestId('capture-pages-notice');
    expect(notice).toHaveTextContent(
      'The scanner stopped before the feeder was empty. If any pages are still in it, add them before you finish.',
    );
    // A sentence, not a wall: the way out is the button already on screen.
    expect(screen.getByTestId('capture-add-page')).toBeEnabled();
    expect(screen.getByTestId('capture-done')).toBeEnabled();
  });

  it('stays quiet when the feeder finished on its own', async () => {
    // A notice on every scan is a notice nobody reads. The default mock is a
    // complete run, so nothing may be said about it.
    renderPanel();
    await screen.findByTestId('capture-page-0');

    fireEvent.click(screen.getByTestId('capture-add-page'));

    await waitFor(() => expect(mocks.acquireFromScanner).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('capture-add-page')).toBeEnabled());
    expect(screen.queryByTestId('capture-pages-notice')).not.toBeInTheDocument();
  });

  it('hides the re-scan control for sources that cannot be re-driven from here', async () => {
    renderPanel({ deviceId: null });
    await screen.findByTestId('capture-page-0');

    expect(screen.queryByLabelText('Scan this page again')).not.toBeInTheDocument();
    // Removing and reordering a watched-folder document still works.
    expect(
      within(screen.getByTestId('capture-page-0')).getByLabelText('Remove this page'),
    ).toBeInTheDocument();
  });

  it('says so plainly when there is nothing scanned yet', async () => {
    mocks.getCaptureDocument.mockResolvedValue(documentWith(0));
    renderPanel();

    expect(await screen.findByText('No pages yet. Add the first one.')).toBeInTheDocument();
    // Nothing to finish, so Done is inert until a page exists.
    expect(screen.getByTestId('capture-done')).toBeDisabled();
  });
});

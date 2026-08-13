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

  it('re-scans a page in place: new bytes first, then the old page drops into its slot', async () => {
    renderPanel();
    await screen.findByTestId('capture-page-0');

    // The replacement lands on the end, so the store reports three pages.
    mocks.getCaptureDocument.mockResolvedValue(documentWith(3));

    fireEvent.click(
      within(screen.getByTestId('capture-page-0')).getByLabelText('Scan this page again'),
    );

    await waitFor(() => expect(mocks.acquireFromScanner).toHaveBeenCalled());
    // Acquire happens before the old page is dropped: a scanner that fails
    // must leave the original page untouched.
    expect(mocks.acquireFromScanner.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeCapturePage.mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(mocks.removeCapturePage).toHaveBeenCalledWith('cap-1', 0));
    // Last page moved back to index 0 — the user sees a page improve, not move.
    await waitFor(() =>
      expect(mocks.reorderCapturePages).toHaveBeenCalledWith('cap-1', [2, 0, 1]),
    );
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

  it('offers to finish and start another at the page cap instead of blocking', async () => {
    mocks.getCaptureDocument.mockResolvedValue(documentWith(10));
    const { props } = renderPanel();

    const capMessage = await screen.findByTestId('capture-page-cap');
    expect(capMessage).toHaveTextContent(
      'That is as many pages as one invoice can hold. Finish this one and start another for the rest.',
    );
    // A sentence, not a refusal: Done still works, and Add is simply spent.
    expect(screen.getByTestId('capture-add-page')).toBeDisabled();
    expect(screen.getByTestId('capture-done')).toBeEnabled();

    fireEvent.click(screen.getByTestId('capture-done'));
    await waitFor(() => expect(props.onDone).toHaveBeenCalledWith('cap-1'));
  });

  it('surfaces the finish-and-start-another action when the feeder hits the cap', async () => {
    const { props } = renderPanel();
    await screen.findByTestId('capture-page-0');

    mocks.getCaptureDocument.mockResolvedValue(documentWith(10));
    mocks.acquireFromScanner.mockResolvedValue({
      ok: true,
      pages: Array.from({ length: 10 }, (_unused, index) => page(index)),
      feederUsed: true,
      reachedPageCap: true,
    });

    fireEvent.click(screen.getByTestId('capture-add-page'));

    const notice = await screen.findByTestId('capture-pages-notice');
    expect(notice).toHaveTextContent('Finish this one and start another');

    fireEvent.click(screen.getByRole('button', { name: 'Finish this one and start another' }));
    await waitFor(() => expect(props.onFinishAndStartAnother).toHaveBeenCalledWith('cap-1'));
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

/**
 * invoice-scan-capture task 12.6 — the capture queue and its history.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**.
 * Requirements R3.4, R3.5, R10.5, R11.4, R11.5, R11.6, R12.1, R13.4.
 *
 * The queue exists to make three promises checkable:
 *
 * - **Nothing disappears.** Every uncommitted document is a row with a plain
 *   status and the time it was scanned (R11.4), and a failure moves sideways
 *   into "needs a look" with a stated reason rather than off the list (R11.6).
 * - **Every row leads somewhere.** Ready opens review, half-scanned carries on,
 *   failed offers trying again *or* typing it in — never a dead end (R11.4).
 * - **Skips are visible.** A file the watched folder declined is a history
 *   sentence saying which and why, because silently ignoring a scan the user
 *   just made is indistinguishable from losing it (R3.4, R3.5).
 *
 * Every status, reason and outcome is asserted through its shipped English
 * sentence — a raw code reaching a till is the failure mode R12.1 forbids.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCaptureDocuments: vi.fn(),
  getCaptureHistory: vi.fn(),
  advanceCapture: vi.fn(async () => ({ success: true })),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../../test/en-translate');
  return { useTranslation: useTranslationEn };
});

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('../../../utils/format', () => ({
  formatDate: (value: string) => `on ${value.slice(0, 10)}`,
}));

vi.mock('../../../services/capture-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/capture-client')>();
  return {
    ...actual,
    listCaptureDocuments: mocks.listCaptureDocuments,
    getCaptureHistory: mocks.getCaptureHistory,
    advanceCapture: mocks.advanceCapture,
  };
});

import CaptureQueuePanel from '../CaptureQueuePanel';

function doc(overrides: Record<string, unknown> = {}) {
  return {
    captureId: 'cap-1',
    status: 'ready_review',
    sourceKind: 'connected_scanner',
    sourceName: 'Back office scanner',
    staffId: 'staff-1',
    capturedAt: '2026-08-06T09:00:00.000Z',
    pageCount: 2,
    recognition: null,
    draft: null,
    storageKeys: [],
    reasonCode: null,
    attempts: 0,
    updatedAt: '2026-08-06T09:00:00.000Z',
    pages: [],
    ...overrides,
  };
}

function renderQueue(overrides: Record<string, unknown> = {}) {
  const props = {
    onReview: vi.fn(),
    onContinueCapture: vi.fn(),
    staffId: 'staff-1',
    onChanged: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CaptureQueuePanel {...(props as never)} />) };
}

beforeEach(() => {
  mocks.listCaptureDocuments.mockResolvedValue([doc()]);
  mocks.getCaptureHistory.mockResolvedValue({ events: [], ingest: [] });
});

afterEach(() => {
  cleanup();
});

describe('CaptureQueuePanel', () => {
  it('says plainly when there is nothing waiting', async () => {
    mocks.listCaptureDocuments.mockResolvedValue([]);
    renderQueue();

    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
    expect(
      screen.getByText('Scanned invoices show up here until they are saved.'),
    ).toBeInTheDocument();
  });

  it('shows a plain status, the capture time, the source and the page count', async () => {
    renderQueue();

    const row = await screen.findByTestId('capture-queue-row-cap-1');
    expect(within(row).getByText('Ready to check')).toBeInTheDocument();
    expect(row).toHaveTextContent('on 2026-08-06');
    expect(row).toHaveTextContent('Scanner at this till');
    expect(row).toHaveTextContent('Back office scanner');
    expect(row).toHaveTextContent('2 pages so far');
  });

  it('renders every lifecycle status as a sentence, never as a raw code', async () => {
    const statuses = [
      ['capturing', 'Still scanning'],
      ['waiting', 'Waiting to be read'],
      ['uploading', 'Sending the pages'],
      ['reading', 'Reading your invoice'],
      ['ready_review', 'Ready to check'],
      ['needs_attention', 'Needs a look'],
      ['parked', 'On hold — the suppliers feature is not active. Nothing is lost.'],
      ['committing', 'Saving'],
      ['committed', 'Saved'],
      ['discarded', 'Thrown away'],
    ] as const;

    mocks.listCaptureDocuments.mockResolvedValue(
      statuses.map(([status], index) =>
        doc({ captureId: `cap-${index}`, status, capturedAt: `2026-08-06T09:0${index}:00.000Z` }),
      ),
    );
    renderQueue();

    await screen.findByTestId('capture-queue-row-cap-0');
    for (const [status, sentence] of statuses) {
      expect(screen.getByText(sentence), `status ${status}`).toBeInTheDocument();
    }
  });

  it('leads a ready document into review', async () => {
    const { props } = renderQueue();
    await screen.findByTestId('capture-queue-row-cap-1');

    fireEvent.click(screen.getByRole('button', { name: /Check & Save/ }));

    expect(props.onReview).toHaveBeenCalledWith(expect.objectContaining({ captureId: 'cap-1' }));
  });

  it('lets a half-scanned document carry on', async () => {
    mocks.listCaptureDocuments.mockResolvedValue([doc({ status: 'capturing' })]);
    const { props } = renderQueue();
    await screen.findByTestId('capture-queue-row-cap-1');

    fireEvent.click(screen.getByRole('button', { name: /Carry on scanning/ }));

    expect(props.onContinueCapture).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: 'cap-1' }),
    );
  });

  it('keeps a failed document on the list with a stated reason and two ways out', async () => {
    mocks.listCaptureDocuments.mockResolvedValue([
      doc({ status: 'needs_attention', reasonCode: 'CAPTURE_UNREADABLE' }),
    ]);
    const { props } = renderQueue();

    const row = await screen.findByTestId('capture-queue-row-cap-1');
    expect(within(row).getByText('Needs a look')).toBeInTheDocument();
    expect(row).toHaveTextContent(
      'We could not read anything on these pages. Scan them again, or type the invoice in by hand.',
    );

    // Try again hands it back to the worker.
    fireEvent.click(within(row).getByRole('button', { name: /Try again/ }));
    await waitFor(() =>
      expect(mocks.advanceCapture).toHaveBeenCalledWith({
        captureId: 'cap-1',
        status: 'waiting',
        reason: null,
        staffId: 'staff-1',
      }),
    );

    // Filling it in by hand opens review on the same document — edits retained.
    fireEvent.click(within(row).getByRole('button', { name: /Fill in by hand/ }));
    await waitFor(() =>
      expect(mocks.advanceCapture).toHaveBeenCalledWith({
        captureId: 'cap-1',
        status: 'ready_review',
        reason: null,
        staffId: 'staff-1',
      }),
    );
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('falls back to a sentence when the reason code is one this build does not know', async () => {
    mocks.listCaptureDocuments.mockResolvedValue([
      doc({ status: 'needs_attention', reasonCode: 'WIA_0x80210015' }),
    ]);
    renderQueue();

    const row = await screen.findByTestId('capture-queue-row-cap-1');
    expect(row).toHaveTextContent('Something went wrong with this scan. Nothing is lost.');
    expect(row).not.toHaveTextContent('WIA_0x80210015');
  });

  it('asks before discarding and warns the pages do not come back', async () => {
    renderQueue();
    await screen.findByTestId('capture-queue-row-cap-1');

    fireEvent.click(screen.getByLabelText('Throw this scan away'));

    expect(
      await screen.findByText(
        'Throw this scan away? The pages are deleted from this till and cannot be brought back.',
      ),
    ).toBeInTheDocument();

    // The row's icon button only opens the confirmation; the confirmation's
    // own button (the one with visible text) is what actually discards.
    const confirmDiscard = screen
      .getAllByRole('button', { name: 'Throw this scan away' })
      .find((button) => button.textContent?.trim() === 'Throw this scan away');
    expect(confirmDiscard).toBeDefined();
    fireEvent.click(confirmDiscard!);
    await waitFor(() =>
      expect(mocks.advanceCapture).toHaveBeenCalledWith({
        captureId: 'cap-1',
        status: 'discarded',
        reason: null,
        staffId: 'staff-1',
      }),
    );
  });

  it('never offers to discard a document that is mid-commit', async () => {
    mocks.listCaptureDocuments.mockResolvedValue([doc({ status: 'committing' })]);
    renderQueue();

    await screen.findByTestId('capture-queue-row-cap-1');
    expect(screen.queryByLabelText('Throw this scan away')).not.toBeInTheDocument();
  });

  it('shows the watched-folder skips in history, each as its own sentence', async () => {
    mocks.getCaptureHistory.mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          captureId: 'cap-1',
          eventType: 'pages_reordered',
          staffId: 'staff-1',
          details: null,
          createdAt: '2026-08-06T09:05:00.000Z',
        },
        {
          id: 'evt-2',
          captureId: 'cap-1',
          eventType: 'some_future_event',
          staffId: null,
          details: null,
          createdAt: '2026-08-06T09:06:00.000Z',
        },
      ],
      ingest: [
        {
          contentHash: 'a',
          sourcePath: 'D:/Scans/a.pdf',
          captureId: null,
          outcome: 'skipped_duplicate',
          seenAt: '2026-08-06T09:01:00.000Z',
        },
        {
          contentHash: 'b',
          sourcePath: 'D:/Scans/b.zip',
          captureId: null,
          outcome: 'skipped_unsupported',
          seenAt: '2026-08-06T09:02:00.000Z',
        },
        {
          contentHash: 'c',
          sourcePath: 'D:/Scans/c.pdf',
          captureId: null,
          outcome: 'skipped_oversize',
          seenAt: '2026-08-06T09:03:00.000Z',
        },
      ],
    });
    renderQueue();
    await screen.findByTestId('capture-queue-row-cap-1');

    fireEvent.click(screen.getByTestId('capture-history-toggle'));

    const history = await screen.findByTestId('capture-history');
    expect(history).toHaveTextContent('A file was left alone — it is the same one we already have.');
    expect(history).toHaveTextContent('A file was left alone — we cannot read that kind of file.');
    expect(history).toHaveTextContent('A file was left alone — it is too big to take in.');
    expect(history).toHaveTextContent('The pages were put in a new order.');
    // An event type this build has no sentence for still reads as a sentence.
    expect(history).toHaveTextContent('Something happened with this scan.');
    expect(history).not.toHaveTextContent('some_future_event');
  });

  it('re-reads on worker events but writes state only on a real change', async () => {
    const { rerender } = renderQueue();
    await screen.findByTestId('capture-queue-row-cap-1');

    const handler = mocks.onEvent.mock.calls.find(
      ([event]) => event === 'capture:status-changed',
    )?.[1] as () => void;
    expect(handler).toBeTypeOf('function');

    const rowBefore = screen.getByTestId('capture-queue-row-cap-1');
    handler();
    await waitFor(() => expect(mocks.listCaptureDocuments.mock.calls.length).toBeGreaterThan(1));
    // Same data in, same node out: an unchanged re-announcement must not make
    // a queue the user is reading jump.
    expect(screen.getByTestId('capture-queue-row-cap-1')).toBe(rowBefore);

    mocks.listCaptureDocuments.mockResolvedValue([doc({ status: 'needs_attention' })]);
    handler();
    await waitFor(() => expect(screen.getByText('Needs a look')).toBeInTheDocument());
    rerender(<CaptureQueuePanel onReview={vi.fn()} onContinueCapture={vi.fn()} />);
  });
});

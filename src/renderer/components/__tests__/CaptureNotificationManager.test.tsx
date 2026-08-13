/**
 * invoice-scan-capture task 12.6 — the capture notification manager.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**.
 * Requirements R3.6, R11.9, R12.1, R12.4, R14.1.
 *
 * This component is mounted once near the app root and never renders anything,
 * so everything worth checking is a side effect:
 *
 * - A scan arriving from the watched folder, or a queued document finishing
 *   recognition after the connection came back, raises a toast carrying a
 *   "Check invoice" action that navigates straight to review (R3.6, R11.9).
 * - A failure is announced as its plain sentence, never its code (R12.1).
 * - `capture:needs-render` rasterizes a PDF **once** — the poll sweep can
 *   re-announce the same document, and re-rendering it would be expensive and
 *   pointless (D1).
 * - With the suppliers module off, it listens to nothing at all (R14.1).
 */

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(() => true),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  toastCustom: vi.fn(),
  toastDismiss: vi.fn(),
  renderCaptureDocument: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../test/en-translate');
  return { useTranslation: useTranslationEn };
});

vi.mock('react-hot-toast', () => ({
  toast: {
    custom: (...args: unknown[]) => mocks.toastCustom(...args),
    dismiss: (...args: unknown[]) => mocks.toastDismiss(...args),
  },
}));

vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({ isModuleEnabled: mocks.isModuleEnabled }),
}));

vi.mock('../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('../../services/capture-pdf-render', () => ({
  renderCaptureDocument: mocks.renderCaptureDocument,
}));

import CaptureNotificationManager, {
  CAPTURE_REVIEW_REQUEST_EVENT,
  requestCaptureReview,
} from '../CaptureNotificationManager';

/** The handler the component registered for one backend event. */
function handlerFor(event: string): ((payload: unknown) => void) | undefined {
  return mocks.onEvent.mock.calls.find(([name]) => name === event)?.[1] as
    | ((payload: unknown) => void)
    | undefined;
}

/** The message text of the most recent toast. */
function lastToastMessage(): string {
  const renderToast = mocks.toastCustom.mock.calls.at(-1)?.[0] as (instance: {
    id: string;
  }) => React.ReactElement;
  const { container } = render(renderToast({ id: 'toast-1' }));
  return container.textContent ?? '';
}

beforeEach(() => {
  mocks.isModuleEnabled.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe('CaptureNotificationManager', () => {
  it('renders nothing and subscribes to the three capture events', () => {
    const { container } = render(<CaptureNotificationManager />);

    expect(container).toBeEmptyDOMElement();
    expect(handlerFor('capture:document-arrived')).toBeTypeOf('function');
    expect(handlerFor('capture:status-changed')).toBeTypeOf('function');
    expect(handlerFor('capture:needs-render')).toBeTypeOf('function');
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<CaptureNotificationManager />);
    unmount();

    const removed = mocks.offEvent.mock.calls.map(([event]) => event);
    expect(removed).toContain('capture:document-arrived');
    expect(removed).toContain('capture:status-changed');
    expect(removed).toContain('capture:needs-render');
  });

  it('listens to nothing when the suppliers module is off', () => {
    mocks.isModuleEnabled.mockReturnValue(false);
    render(<CaptureNotificationManager />);

    expect(mocks.onEvent).not.toHaveBeenCalled();
  });

  it('announces an arriving scan with a Check invoice action', () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:document-arrived')?.({ captureId: 'cap-1', sourceName: 'Scans' });

    expect(mocks.toastCustom).toHaveBeenCalledTimes(1);
    expect(lastToastMessage()).toContain('A new invoice arrived.');
    expect(lastToastMessage()).toContain('Check invoice');
  });

  it('announces a document that finished reading', () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:status-changed')?.({ captureId: 'cap-1', status: 'ready_review' });

    expect(lastToastMessage()).toContain('An invoice is ready to check.');
  });

  it('announces a failure as its plain sentence, never as its code', () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:status-changed')?.({
      captureId: 'cap-1',
      status: 'needs_attention',
      reason: 'CAPTURE_TOO_MANY_PAGES',
    });

    const message = lastToastMessage();
    expect(message).toContain('That is more pages than one invoice can hold.');
    expect(message).not.toContain('CAPTURE_TOO_MANY_PAGES');
  });

  it('says a parked document is on hold and nothing is lost', () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:status-changed')?.({ captureId: 'cap-1', status: 'parked' });

    expect(lastToastMessage()).toContain(
      'On hold — the suppliers feature is not active. Nothing is lost.',
    );
  });

  it('stays quiet for the statuses the worker owns', () => {
    render(<CaptureNotificationManager />);

    for (const status of ['waiting', 'uploading', 'reading', 'committing', 'committed']) {
      handlerFor('capture:status-changed')?.({ captureId: 'cap-1', status });
    }

    expect(mocks.toastCustom).not.toHaveBeenCalled();
  });

  it('navigates to review when the toast action is pressed', () => {
    const navigations: unknown[] = [];
    const reviewRequests: unknown[] = [];
    const onNavigate = (event: Event) => navigations.push((event as CustomEvent).detail);
    const onReview = (event: Event) => reviewRequests.push((event as CustomEvent).detail);
    window.addEventListener('pos:navigate-view', onNavigate);
    window.addEventListener(CAPTURE_REVIEW_REQUEST_EVENT, onReview);

    try {
      requestCaptureReview('cap-9');
    } finally {
      window.removeEventListener('pos:navigate-view', onNavigate);
      window.removeEventListener(CAPTURE_REVIEW_REQUEST_EVENT, onReview);
    }

    expect(navigations).toEqual([{ view: 'suppliers' }]);
    expect(reviewRequests).toEqual([{ captureId: 'cap-9' }]);
  });

  it('rasterizes a PDF once, however often the sweep re-announces it', async () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:needs-render')?.({ captureId: 'cap-1' });
    handlerFor('capture:needs-render')?.({ captureId: 'cap-1' });

    await waitFor(() => expect(mocks.renderCaptureDocument).toHaveBeenCalledTimes(1));
    expect(mocks.renderCaptureDocument).toHaveBeenCalledWith('cap-1');
  });

  it('allows a retry after the rasterization transport fails outright', async () => {
    mocks.renderCaptureDocument.mockRejectedValueOnce(new Error('transport down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<CaptureNotificationManager />);

    handlerFor('capture:needs-render')?.({ captureId: 'cap-1' });
    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    handlerFor('capture:needs-render')?.({ captureId: 'cap-1' });
    await waitFor(() => expect(mocks.renderCaptureDocument).toHaveBeenCalledTimes(2));

    consoleError.mockRestore();
  });

  it('ignores a render request with no capture attached', () => {
    render(<CaptureNotificationManager />);

    handlerFor('capture:needs-render')?.({});

    expect(mocks.renderCaptureDocument).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportOnsiteSheet } from '../SupportOnsiteSheet';
import { SupportPhysicalCheck } from '../SupportPhysicalCheck';

vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
const request = { request_id: 'your-request', session_id: 'your-session', title: 'Shipped remedy', description: 'Shipped explanation', technical_details: '{"exact":true}', needs_staff_pin: true, remaining_ms: 300000 };
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe.each(['light', 'dark'])('Phase two support in %s', theme => {
  it('arms Run only after two visible seconds, permits immediate decline and contains no secret input', () => {
    vi.useFakeTimers(); document.documentElement.className = theme;
    const decide = vi.fn();
    render(<SupportOnsiteSheet request={request} deferred={false} canConfirm onDecision={decide} onShown={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'support.onsite.execute' })).toBeDisabled();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.getByText('support.onsite.storePinNotice')).toBeVisible();
    fireEvent.click(screen.getByText('support.onsite.technicalDetails'));
    expect(screen.getByText(request.technical_details)).toBeVisible();
    fireEvent.click(screen.getByText('support.onsite.decline'));
    expect(decide).toHaveBeenCalledWith('declined');
    act(() => vi.advanceTimersByTime(2000));
    const run = screen.getByRole('button', { name: 'support.onsite.execute' });
    expect(run).toBeEnabled(); expect(run.className).toContain('--pos-s-sel-bg');
    fireEvent.click(run); expect(decide).toHaveBeenLastCalledWith('confirmed');
  });
  it('shows only the chip during checkout and restarts the fence afterwards', () => {
    vi.useFakeTimers(); const decide = vi.fn();
    const props = { request, canConfirm: true, onDecision: decide, onShown: vi.fn() };
    const view = render(<SupportOnsiteSheet {...props} deferred />);
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('support-onsite-chip')).toBeVisible();
    view.rerender(<SupportOnsiteSheet {...props} deferred={false} />);
    expect(screen.getByText('support.onsite.execute')).toBeDisabled();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('support.onsite.execute')).toBeEnabled();
  });
  it('times out without an answer, even while deferred', () => {
    vi.useFakeTimers(); const decide = vi.fn();
    render(<SupportOnsiteSheet request={{ ...request, remaining_ms: 50 }} deferred canConfirm onDecision={decide} onShown={vi.fn()} />);
    act(() => vi.advanceTimersByTime(50)); expect(decide).toHaveBeenCalledWith('timeout');
  });
  it('renders catalogued physical checks with both answers fenced', () => {
    const answer = vi.fn();
    const view = render(<SupportPhysicalCheck checkId="check_printer_paper" armed={false} onAnswer={answer} />);
    expect(screen.getByText('support.physicalCheck.check_printer_paper')).toBeVisible();
    expect(screen.getByText('support.physicalCheck.notDone')).toBeDisabled();
    view.rerender(<SupportPhysicalCheck checkId="check_printer_paper" armed onAnswer={answer} />);
    fireEvent.click(screen.getByText('support.physicalCheck.done')); expect(answer).toHaveBeenCalledWith('done');
  });
});

import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CONFIRMED_COMMAND_STRING_KEYS, ConfirmedResultSchema } from '../../../../../../shared/pos/support/confirmed';
import { SupportBannerView } from '../SupportBanner';
import { SupportBannerSnapshotSchema } from '../../../hooks/useSupportSession';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const event = { command_id: 'your-command', session_id: 'your-session', explanation: 'Retry the row that is holding up work',
  reason: 'The earlier network request failed', at: '2026-11-13T12:00:00.000Z', state: 'waiting' };
describe('confirmed commands in the existing pill', () => {
  it.each(['waiting', 'started'])('shows the actual explanation for %s and End remains immediate', state => {
    const onEnd = vi.fn();
    const snapshot = SupportBannerSnapshotSchema.parse({ state: state === 'started' ? 'executing' : 'deferred', activity: 'till_confirmed_command', confirmed_history: [{ ...event, state }], remaining_ms: 60000 });
    render(<SupportBannerView snapshot={snapshot} onEnd={onEnd} onExtend={vi.fn()} />);
    expect(screen.getByTestId('support-confirmed-explanation')).toHaveTextContent(event.explanation);
    fireEvent.click(screen.getByRole('button', { name: 'support.confirmed.endSession' }));
    expect(onEnd).toHaveBeenCalledOnce();
  });
  it('keeps the completed command and truthful pending result in activity details', () => {
    const snapshot = SupportBannerSnapshotSchema.parse({ state: 'connected', confirmed_history: [{ ...event, state: 'finished', outcome: 'pending' }] });
    render(<SupportBannerView snapshot={snapshot} onEnd={vi.fn()} onExtend={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const history = screen.getByTestId('support-confirmed-history');
    expect(history).toHaveTextContent(event.explanation); expect(history).toHaveTextContent(event.reason);
    expect(history).toHaveTextContent('support.confirmed.outcomes.pending');
    // Time, state and outcome are joined by a middle dot; a lost character once showed staff a "?".
    expect(history.textContent).toContain(' · support.confirmed.finished · support.confirmed.outcomes.pending');
    expect(history.textContent).not.toMatch(/\s\?\s/);
  });
  it.each(['el', 'en', 'de', 'fr', 'it', 'sq'])('ships every command string and exact action placeholders in %s', lang => {
    const locale = JSON.parse(readFileSync(`src/locales/support/${lang}.json`, 'utf8'));
    for (const key of CONFIRMED_COMMAND_STRING_KEYS) {
      const value = key.replace(/^support\./, '').split('.').reduce((value, part) => value?.[part], locale);
      expect(typeof value, key).toBe('string'); expect(value.length, key).toBeGreaterThan(1); expect(value).not.toMatch(/\?\?\?|�/);
    }
    expect(locale.confirmed.shiftClose).toContain('{{shift_id}}');
    expect(locale.confirmed.queueRetry).toContain('{{queue_id}}');
    expect(locale.confirmed.undoSnapshot).toContain('{{snapshot_id}}');
  });
  it('pins the native output oracle to the current shared schema', () => {
    const native = JSON.parse(readFileSync('src-tauri/src/support/confirmed_result_schema.json', 'utf8'));
    expect(native).toEqual(z.toJSONSchema(ConfirmedResultSchema));
  });
});

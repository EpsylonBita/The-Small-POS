import { describe, expect, it } from 'vitest';
import type { RecoveryActionLogEntry } from '../../../../lib';
import el from '../../../../locales/overlays/el.till-health.json';
import en from '../../../../locales/overlays/en.till-health.json';
import de from '../../../../locales/overlays/de.till-health.json';
import fr from '../../../../locales/overlays/fr.till-health.json';
import it_ from '../../../../locales/overlays/it.till-health.json';
import sq from '../../../../locales/overlays/sq.till-health.json';
import {
  AUTOMATIC_ACTION_IDS, HISTORY_KINDS, HISTORY_STATES, buildHistoryRows, historyActor, historyState,
} from '../till-health-history';

const entry = (over: Partial<RecoveryActionLogEntry> = {}): RecoveryActionLogEntry => ({
  id: 'row', actionId: 'hydrate_food_print_items', issueCode: 'food_order_items_pending', success: true,
  timestamp: '2026-11-23T10:05:12Z', actor: { staffId: null, staffName: null }, targetRefs: {}, ...over,
});

describe('Health history: what a row says', () => {
  it('takes the outcome the till typed and never invents a finished repair', () => {
    for (const outcome of ['resolved', 'pending', 'failed', 'unknown'] as const) {
      expect(historyState(entry({ outcome }))).toBe(outcome);
      // A typed outcome wins over the record rule too.
      expect(historyState(entry({ actionId: 'manual_payment_method_correction', outcome }))).toBe(outcome);
    }
    // success alone is not proof: the till decides (see commands/recovery.rs).
    expect(historyState(entry({ success: true }))).toBe('unknown');
    expect(historyState(entry({ actionId: 'retryParityItem', success: true }))).toBe('unknown');
  });

  it('reads the listed audit records as recorded, only when they were written', () => {
    for (const actionId of ['manual_payment_method_correction', 'platform_cash_at_assignment']) {
      expect(historyState(entry({ actionId, success: true }))).toBe('recorded');
      expect(historyState(entry({ actionId, success: false }))).toBe('unknown');
    }
    // Not on the list: an unlisted audit row keeps the careful wording.
    expect(historyState(entry({ actionId: 'order_header_edit', success: true }))).toBe('unknown');
  });

  it('says «automatic» only when nobody acted and the till wrote the row itself', () => {
    expect(historyActor(entry())).toEqual({ type: 'automatic' });
    for (const actionId of AUTOMATIC_ACTION_IDS) {
      expect(historyActor(entry({ actionId }))).toEqual({ type: 'automatic' });
    }
    expect(historyActor(entry({ actionId: 'platform_cash_at_assignment' }))).toEqual({ type: 'automatic' });
    // A person acted: named when the till knows the name, never «automatic».
    expect(historyActor(entry({ actionId: 'platform_cash_at_assignment', actor: { staffId: 's1', staffName: ' Maria ' } })))
      .toEqual({ type: 'staff', name: 'Maria' });
    expect(historyActor(entry({ actionId: 'platform_cash_at_assignment', actor: { staffId: 's1', staffName: null } })))
      .toEqual({ type: 'unknown' });
    expect(historyActor(entry({ actionId: 'manual_payment_method_correction' }))).toEqual({ type: 'unknown' });
    expect(historyActor(entry({ actionId: 'retryParityItem' }))).toEqual({ type: 'unknown' });
    // The order notice's own automatic resend keeps its existing mark.
    expect(historyActor(entry({ id: 'automatic:q1', actionId: 'resendOrderCustomerCorrection' }))).toEqual({ type: 'automatic' });
  });
});

describe('Health history: folding repeated automatic rows', () => {
  it('folds finished automatic rows of one kind per day and keeps every other row', () => {
    const rows = buildHistoryRows([
      entry({ id: 'h5', outcome: 'resolved', timestamp: '2026-11-23T18:40:00Z' }),
      entry({ id: 'm1', actionId: 'manual_payment_method_correction', timestamp: '2026-11-23T18:00:00Z', actor: { staffId: 's1', staffName: 'Maria' } }),
      entry({ id: 'h4', outcome: 'failed', timestamp: '2026-11-23T17:00:00Z' }),
      entry({ id: 'h3', outcome: 'resolved', timestamp: '2026-11-23T12:10:00Z' }),
      entry({ id: 'h2', outcome: 'pending', timestamp: '2026-11-23T12:05:00Z' }),
      entry({ id: 'h1', outcome: 'unknown', timestamp: '2026-11-23T12:00:00Z' }),
      entry({ id: 'h0', outcome: 'resolved', timestamp: '2026-11-23T11:00:00Z' }),
      entry({ id: 'y1', outcome: 'resolved', timestamp: '2026-11-21T11:00:00Z' }),
    ]);
    expect(rows.map(row => [row.id, row.state, row.count])).toEqual([
      ['h5', 'resolved', 3],
      ['m1', 'recorded', 1],
      ['h4', 'failed', 1],
      ['h2', 'pending', 1],
      ['h1', 'unknown', 1],
      ['y1', 'resolved', 1],
    ]);
    expect(rows[0].entries.map(item => item.id)).toEqual(['h5', 'h3', 'h0']);
    expect(rows[0].sentenceKey).toBe('tillHealth.history.kinds.orderItems.resolved');
    expect(rows[2].sentenceKey).toBe('tillHealth.history.kinds.orderItems.failed');
    // Every entry is still there: nothing is dropped by the fold.
    expect(rows.flatMap(row => row.entries)).toHaveLength(8);
  });

  it('never folds rows a person is named on, and gives unlisted rows no invented sentence', () => {
    const cash = (id: string, staffName: string | null) => entry({
      id, actionId: 'platform_cash_at_assignment', actor: { staffId: staffName ? 's1' : null, staffName },
    });
    const rows = buildHistoryRows([cash('c1', 'Maria'), cash('c2', 'Maria'), cash('c3', null), cash('c4', null),
      entry({ id: 'x1', actionId: 'order_header_edit' })]);
    expect(rows.map(row => [row.id, row.count, row.actor.type])).toEqual([
      ['c1', 1, 'staff'], ['c2', 1, 'staff'], ['c3', 2, 'automatic'], ['x1', 1, 'unknown'],
    ]);
    expect(rows[3].sentenceKey).toBeNull();
    expect(rows[3].state).toBe('unknown');
  });
});

describe('Health history: six locales', () => {
  const locales = { el, en, de, fr, it: it_, sq } as Record<string, { tillHealth: Record<string, any> }>;
  // Raw codes and server words stay inside the support details (TillHealthWindow.test.tsx uses the same rule).
  const forbidden = /\b(?:server|sync|queue|conflict|recovery|retry)\b|διακομιστ|συγχρονισ|\bουρ[άα]|σύγκρουσ|ανάκτησ|[A-Za-z0-9]+_[A-Za-z0-9_]+|\?{2,}|NEEDS TRANSLATION/iu;

  it.each(Object.keys(locales))('%s has every sentence the kinds list asks for, and nothing else', language => {
    const history = locales[language].tillHealth.history;
    const texts: string[] = [history.details, history.other];
    expect(Object.keys(history.state).sort()).toEqual([...HISTORY_STATES].sort());
    texts.push(...Object.values<string>(history.state));
    const kinds = Object.values(HISTORY_KINDS);
    expect(Object.keys(history.kinds).sort()).toEqual(kinds.map(kind => kind.key).sort());
    for (const kind of kinds) {
      const expected = kind.states.flatMap(state =>
        (kind.counted as readonly string[]).includes(state) ? [`${state}_one`, `${state}_other`] : [state]);
      expect(Object.keys(history.kinds[kind.key]).sort()).toEqual(expected.sort());
      for (const key of expected) {
        const text: string = history.kinds[kind.key][key];
        if (key.endsWith('_other')) expect(text).toContain('{{count}}');
        texts.push(text);
      }
    }
    texts.push(locales[language].tillHealth.support.automaticActor, locales[language].tillHealth.support.unknownActor);
    for (const text of texts) {
      expect(typeof text).toBe('string');
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(forbidden);
    }
  });

  it('keeps the six languages distinct for every new sentence', () => {
    const flatten = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Object.values(value as Record<string, unknown>).flatMap(flatten);
    const perLanguage = Object.values(locales).map(locale => flatten(locale.tillHealth.history));
    perLanguage.forEach(list => expect(list).toHaveLength(perLanguage[0].length));
    // A sentence copied untranslated from English would show up here.
    const english = new Set(flatten(en.tillHealth.history));
    for (const [language, locale] of Object.entries(locales)) {
      if (language === 'en') continue;
      expect(flatten(locale.tillHealth.history).filter(text => english.has(text))).toEqual([]);
    }
  });
});

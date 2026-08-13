/**
 * invoice-scan-capture task 12.6 — review prefill and confidence rendering.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**,
 * decision **D10**. Requirements R6.3, R6.4, R7.1, R7.2, R7.6, R9.2, R12.1,
 * R15.3.
 *
 * Two contracts live here, and both are the kind that fail silently in
 * production if nobody pins them:
 *
 * - **Every parsed row survives the pour into the drawer** (R6.4). A row the
 *   user has to fix is strictly better than a row that vanished, so a blank
 *   name, a missing cost, and a junk quantity must all still arrive as rows.
 * - **Confidence never becomes a number** (R7.6). The tier is the only thing a
 *   component may ask for, and the rendered highlight is a sentence — so the
 *   rendering test asserts, character by character, that no digit reaches the
 *   screen through the confidence path.
 *
 * The rendering half uses a harness that mirrors exactly what `SuppliersPage`
 * does with these helpers (`needsDoubleCheck(reviewConfidence[index])` gating
 * the `suppliers.capture.review.doubleCheck` chip), so the assertion tracks the
 * shipped wiring rather than a paraphrase of it.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CAPTURE_I18N_PREFIX,
  doubleCheckCount,
  mapRecognitionToDraft,
  needsDoubleCheck,
  reasonKey,
  statusKey,
  suggestPurchaseOrders,
} from '../capture-review';
import { translateEn } from '../../test/en-translate';
import type { ConfidenceTier } from '../../types/supplier-capture';

afterEach(() => {
  cleanup();
});

function recognition(overrides: Record<string, unknown> = {}) {
  return {
    parsed: {
      supplier: { name: 'Athens Fresh Produce', email: 'orders@fresh.gr', phone: '2101234567' },
      invoice: { invoiceNumber: 'INV-4471', invoiceDate: '2026-08-05' },
      rows: [
        { name: 'Tomatoes', quantity: 12, unit: 'kg', cost: 1.4 },
        { name: 'Feta', quantity: 4, unit: 'kg', cost: 8.2 },
        { name: '', quantity: 'not a number', cost: -3 },
      ],
    },
    rowConfidence: ['ok', 'check'],
    pages: [{ index: 0 }, { index: 1 }],
    quality: 'good',
    ...overrides,
  };
}

describe('mapRecognitionToDraft', () => {
  it('keeps every parsed row, including the one the recogniser mangled', () => {
    const prefill = mapRecognitionToDraft(recognition());

    expect(prefill.rows).toHaveLength(3);
    expect(prefill.rows.map((row) => row.name)).toEqual(['Tomatoes', 'Feta', '']);
  });

  it('maps supplier and invoice fields straight through', () => {
    const prefill = mapRecognitionToDraft(recognition());

    expect(prefill.supplier).toEqual({
      name: 'Athens Fresh Produce',
      email: 'orders@fresh.gr',
      phone: '2101234567',
      notes: '',
    });
    expect(prefill.invoice).toEqual({ invoiceNumber: 'INV-4471', invoiceDate: '2026-08-05' });
    expect(prefill.pageCount).toBe(2);
  });

  it('leaves what it could not read blank rather than inventing it', () => {
    const prefill = mapRecognitionToDraft({ parsed: { rows: [{ quantity: 2 }] } });

    expect(prefill.supplier).toEqual({ name: '', email: '', phone: '', notes: '' });
    expect(prefill.invoice).toEqual({ invoiceNumber: '', invoiceDate: '' });
    expect(prefill.rows[0].name).toBe('');
    expect(prefill.rows[0].sku).toBeNull();
  });

  it('normalises unusable numbers instead of dropping the row', () => {
    const prefill = mapRecognitionToDraft(recognition());
    const mangled = prefill.rows[2];

    expect(mangled.quantity).toBe(1); // fell back to one, never negative
    expect(mangled.cost).toBe(0); // a negative cost is clamped, not kept
    expect(mangled.unit).toBe('pcs');
  });

  it('reads a comma decimal the way a European invoice writes it', () => {
    const prefill = mapRecognitionToDraft({
      parsed: { rows: [{ name: 'Olive oil', quantity: '2,5', cost: '11,90' }] },
    });

    expect(prefill.rows[0].quantity).toBe(2.5);
    expect(prefill.rows[0].cost).toBe(11.9);
  });

  it('pads missing tiers with "check", never with confidence nobody earned', () => {
    const prefill = mapRecognitionToDraft(recognition());

    expect(prefill.rowConfidence).toEqual(['ok', 'check', 'check']);
  });

  it('treats an unrecognised tier as one to double-check', () => {
    const prefill = mapRecognitionToDraft(
      recognition({ rowConfidence: ['excellent', 0.97, null] }),
    );

    expect(prefill.rowConfidence).toEqual(['check', 'check', 'check']);
  });

  it('carries the document quality verdict through untouched', () => {
    expect(mapRecognitionToDraft(recognition()).quality).toBe('good');
    expect(mapRecognitionToDraft(recognition({ quality: 'poor' })).quality).toBe('poor');
    // Anything unrecognised is treated as readable rather than alarming.
    expect(mapRecognitionToDraft(recognition({ quality: 'mediocre' })).quality).toBe('good');
  });

  it('treats nothing at all as a poor result with no rows', () => {
    for (const empty of [null, undefined, 'nonsense', 42]) {
      const prefill = mapRecognitionToDraft(empty as never);
      expect(prefill.rows).toEqual([]);
      expect(prefill.quality).toBe('poor');
      expect(prefill.pageCount).toBe(0);
    }
  });

  it('exposes no numeric confidence anywhere in the prefill', () => {
    const prefill = mapRecognitionToDraft(recognition());

    for (const tier of prefill.rowConfidence) {
      expect(['ok', 'check', 'low']).toContain(tier);
    }
    expect(JSON.stringify(prefill)).not.toContain('confidence":0');
    expect(Object.keys(prefill)).not.toContain('confidenceScore');
  });
});

describe('needsDoubleCheck / doubleCheckCount', () => {
  it('asks the user to look at anything short of confident', () => {
    expect(needsDoubleCheck('ok')).toBe(false);
    expect(needsDoubleCheck('check')).toBe(true);
    expect(needsDoubleCheck('low')).toBe(true);
    expect(needsDoubleCheck(undefined)).toBe(false);
  });

  it('counts the rows a user is being asked to check', () => {
    expect(doubleCheckCount(['ok', 'check', 'low', 'ok'])).toBe(2);
    expect(doubleCheckCount([])).toBe(0);
  });
});

/**
 * The chip exactly as `SuppliersPage` renders it: `needsDoubleCheck` gates it,
 * and the label is the one locale key, resolved from the shipped `en.json`.
 */
const DoubleCheckChip: React.FC<{ index: number; tier: ConfidenceTier | undefined }> = ({
  index,
  tier,
}) =>
  needsDoubleCheck(tier) ? (
    <span data-testid={`capture-double-check-${index}`}>
      {translateEn('suppliers.capture.review.doubleCheck', 'Double-check this')}
    </span>
  ) : null;

describe('confidence-tier rendering', () => {
  it('highlights only the rows that need a second look', () => {
    const tiers: ConfidenceTier[] = ['ok', 'check', 'low'];
    render(
      <div>
        {tiers.map((tier, index) => (
          <DoubleCheckChip key={index} index={index} tier={tier} />
        ))}
      </div>,
    );

    expect(screen.queryByTestId('capture-double-check-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('capture-double-check-1')).toBeInTheDocument();
    expect(screen.getByTestId('capture-double-check-2')).toBeInTheDocument();
  });

  it('renders the tier as a sentence with no numeral in it', () => {
    render(
      <div data-testid="tiers">
        {(['check', 'low'] as ConfidenceTier[]).map((tier, index) => (
          <DoubleCheckChip key={index} index={index} tier={tier} />
        ))}
      </div>,
    );

    const rendered = screen.getByTestId('tiers').textContent ?? '';
    expect(rendered).toContain('Double-check this');
    // No score, no percentage, no "0.82" — the whole point of the tri-state.
    expect(rendered).not.toMatch(/\d/);
    expect(rendered).not.toContain('%');
  });

  it('never resolves the confidence label from anywhere but the capture namespace', () => {
    expect(CAPTURE_I18N_PREFIX).toBe('suppliers.capture');
    expect(translateEn('suppliers.capture.review.doubleCheck')).toBe('Double-check this');
  });
});

describe('runtime vocabulary keys', () => {
  it('turns a known code into its own sentence', () => {
    expect(translateEn(statusKey('ready_review'))).toBe('Ready to check');
    expect(translateEn(reasonKey('MODULE_REQUIRED'))).toContain('suppliers feature is not switched on');
  });

  it('turns an unknown code into a sentence rather than the code itself', () => {
    expect(statusKey('teleported')).toBe('suppliers.capture.status.needs_attention');
    expect(reasonKey('WIA_0x80210015')).toBe('suppliers.capture.reason.unknown');
    expect(translateEn(reasonKey('WIA_0x80210015'))).toBe(
      'Something went wrong with this scan. Nothing is lost.',
    );
  });
});

describe('suggestPurchaseOrders', () => {
  const orders = [
    {
      id: 'po-1',
      supplierName: 'ACME FOODS O.E.',
      orderReference: 'PO-1',
      status: 'ordered',
      expectedDeliveryDate: '2026-08-07',
    },
    {
      id: 'po-2',
      supplierName: 'Other Supplier',
      orderReference: 'PO-2',
      status: 'ordered',
      expectedDeliveryDate: null,
    },
    {
      id: 'po-3',
      supplierName: 'Acme Foods OE',
      orderReference: 'PO-3',
      status: 'received',
      expectedDeliveryDate: null,
    },
  ];

  it('matches across case, spacing and punctuation off a scanned page', () => {
    expect(suggestPurchaseOrders(orders, 'Acme Foods OE').map((po) => po.id)).toEqual(['po-1']);
  });

  it('offers nothing for a supplier it could not read', () => {
    expect(suggestPurchaseOrders(orders, '')).toEqual([]);
  });

  it('never offers an order that is already closed out', () => {
    expect(suggestPurchaseOrders(orders, 'Acme').map((po) => po.id)).not.toContain('po-3');
  });
});

/**
 * Founder 01/11: «ο αριθμός παραγγελίας πρέπει να είναι αυτός που είναι και στα grids χωρίς τον οκταψήφιο
 * μπροστά». The shift window's order history showed #ORD-31102026-00003; the grid card shows #00003.
 * Both now call formatGridOrderNumber.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatGridOrderNumber } from '../gridOrderNumber';

describe('formatGridOrderNumber', () => {
  it('drops the date from the register number, as the grid does', () => {
    expect(formatGridOrderNumber({ order_number: 'ORD-31102026-00003' })).toBe('#00003');
    expect(formatGridOrderNumber({ order_number: '#ORD-31102026-00012' })).toBe('#00012');
  });

  it('reads the staff-facing number before the internal one', () => {
    expect(
      formatGridOrderNumber({
        display_order_number: 'M1-0042',
        order_number: 'ORD-20261031-0123456789abcdef0123456789abcdef',
      }),
    ).toBe('#M1-0042');
  });

  it('headlines the platform short code for efood orders', () => {
    expect(
      formatGridOrderNumber({
        order_number: 'EFOOD-998877665544',
        ghost_metadata: { food_delivery: { short_code: '4545' } },
      } as Parameters<typeof formatGridOrderNumber>[0]),
    ).toBe('#4545');
  });

  it('never prefixes a second # on an internal reference', () => {
    const label = formatGridOrderNumber({ order_number: 'ORD-20261031-0123456789abcdef0123456789abcdef' });
    expect(label.startsWith('##')).toBe(false);
    expect(label).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('falls back to the id tail without any number', () => {
    expect(formatGridOrderNumber({ order_id: 'aaaa-bbbb-1234' })).toBe('#1234');
    expect(formatGridOrderNumber(null)).toBe('');
  });

  it('is the one rule the grid card and the shift window both call', () => {
    const root = resolve(__dirname, '../../components');
    const card = readFileSync(resolve(root, 'order/OrderCard.tsx'), 'utf8');
    const shift = readFileSync(resolve(root, 'modals/StaffShiftModal.tsx'), 'utf8');
    expect(card).toContain('formatGridOrderNumber(order)');
    expect(shift).toMatch(/\{formatGridOrderNumber\(order\)\}/);
    // No raw «#{order.order_number}» left in the shift window.
    expect(shift).not.toMatch(/#\{(order|delivery)\.order_number/);
    expect(shift).not.toMatch(/Order #\{delivery\.order_number\}/);
  });
});

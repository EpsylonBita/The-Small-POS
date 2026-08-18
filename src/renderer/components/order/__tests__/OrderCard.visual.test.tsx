/**
 * OrderCard de-glass treatment (founder-approved visual/perf change).
 *
 * Every order card used to be its own `backdrop-filter` compositor surface
 * (`backdrop-blur-sm` over a translucent bg), and overdue (>40 min) delivery
 * cards ran an infinite `animate-pulse` over four stacked inset box-shadows.
 * With 38 visible cards that meant 38 live blur layers continuously
 * repainting. These tests pin the replacement:
 *
 * - no `backdrop-blur` on the card surface, in either theme;
 * - the surface is the sampled solid/near-opaque equivalent (dark
 *   `bg-[#26231e]/95`, light `bg-[#fef8ee]`), not the old translucent glass;
 * - the overdue delivery treatment keeps its attention signal via a FINITE
 *   pulse (`order-card-overdue-pulse`, 4 cycles then steady) and exactly ONE
 *   inset shadow — never `animate-pulse`, never the four-shadow stack;
 * - terminal (completed/cancelled) and fresh orders get no overdue treatment.
 */

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvedTheme: 'dark' as 'dark' | 'light',
}));

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../../test/en-translate');
  return {
    useTranslation: useTranslationEn,
    // `src/lib/i18n.ts` (pulled in via utils/format) registers this plugin at
    // import time; a no-op 3rd-party plugin keeps that side effect harmless.
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({
    theme: mocks.resolvedTheme,
    resolvedTheme: mocks.resolvedTheme,
    setTheme: () => {},
  }),
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    customers: { lookupByPhone: vi.fn(async () => null) },
  }),
}));

vi.mock('../../../utils/plugin-icons', () => ({
  PluginIcon: () => null,
  isExternalPlatform: () => false,
}));

vi.mock('../OrderStatusControls', () => ({
  OrderStatusControls: () => null,
}));

import OrderCard from '../OrderCard';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    order_number: 'POS-20260818-0042',
    status: 'pending',
    order_type: 'delivery',
    customer_name: 'Maria',
    customer_phone: '',
    delivery_address: 'Iliados 10, Athens',
    total_amount_cents: 1250,
    created_at: minutesAgo(5),
    ...overrides,
  };
}

/** Render one card and hand back the root element's class string. */
function renderCardClasses(order: Record<string, unknown>): string {
  const { container } = render(
    <OrderCard order={order} isSelected={false} onSelect={() => {}} />,
  );
  const card = container.firstElementChild as HTMLElement | null;
  expect(card).not.toBeNull();
  return card!.className;
}

// RTL auto-cleanup is OFF in this repo's vitest setup (no `globals: true`) —
// clean up explicitly so cards don't pile up across tests.
afterEach(() => {
  cleanup();
  mocks.resolvedTheme = 'dark';
});

describe('OrderCard surface (de-glassed)', () => {
  it('carries no backdrop-blur in dark theme and uses the sampled near-opaque surface', () => {
    const classes = renderCardClasses(makeOrder());
    expect(classes).not.toMatch(/backdrop-blur/);
    expect(classes).toContain('bg-[#26231e]/95');
    expect(classes).not.toContain('bg-white/10');
  });

  it('carries no backdrop-blur in light theme and uses the sampled solid surface', () => {
    mocks.resolvedTheme = 'light';
    const classes = renderCardClasses(makeOrder());
    expect(classes).not.toMatch(/backdrop-blur/);
    expect(classes).toContain('bg-[#fef8ee]');
    expect(classes).not.toContain('bg-[#fffaf1]/90');
  });
});

describe('OrderCard overdue delivery treatment', () => {
  it('pulses finitely with exactly one inset shadow when a delivery is >40 minutes old', () => {
    const classes = renderCardClasses(
      makeOrder({ created_at: minutesAgo(45) }),
    );
    expect(classes).toContain('order-card-overdue-pulse');
    expect(classes).not.toContain('animate-pulse');
    // Exactly ONE inset shadow — the four-layer stack must not come back.
    expect(classes.match(/inset_/g)).toHaveLength(1);
    expect(classes).toContain('border-l-red-500');
  });

  it('gives a fresh delivery no overdue treatment', () => {
    const classes = renderCardClasses(
      makeOrder({ created_at: minutesAgo(10) }),
    );
    expect(classes).not.toContain('order-card-overdue-pulse');
    expect(classes).not.toMatch(/inset_/);
  });

  it('never pulses a terminal (completed) delivery, however old', () => {
    const classes = renderCardClasses(
      makeOrder({ status: 'completed', created_at: minutesAgo(120) }),
    );
    expect(classes).not.toContain('order-card-overdue-pulse');
    expect(classes).not.toMatch(/inset_/);
  });
});

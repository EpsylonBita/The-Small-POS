import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VarianceBadge } from '../VarianceBadge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib/i18n', () => ({ default: { language: 'el' } }));

describe('VarianceBadge currency', () => {
  afterEach(cleanup);
  it('keeps an explicitly unknown historical unit unknown', () => {
    render(<VarianceBadge variance={4} currency={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('+4,00 —');
    expect(screen.getByRole('status').textContent).not.toContain('€');
  });
  it.each([0, 4, -4])('formats %s in euros with the active Greek locale', (variance) => {
    render(<VarianceBadge variance={variance} currency="EUR" />);
    expect(screen.getByRole('status')).toHaveTextContent(`${variance < 0 ? '-' : variance > 0 ? '+' : ''}${Math.abs(variance)},00 €`);
    expect(screen.getByRole('status').textContent).not.toContain('$');
  });
});

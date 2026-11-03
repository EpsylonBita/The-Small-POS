/**
 * Founder 01/11 («τα αναδυόμενα που δείχνουν επιλογή ημερομηνίας είναι τα παλιά στυλ Windows XP, θέλω να τα
 * κάνεις μοντέρνα όλα»): the kit date / time field replaces every native date, time and datetime-local input.
 * jsdom has no Popover API, so these run the plain-panel fallback; the popover path is checked in the harness.
 */
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitDateField } from '../KitDateField';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: 'el' } }),
}));

const Harness: React.FC<{ type: 'date' | 'time' | 'datetime-local'; initial: string; min?: string; required?: boolean; onValue: (v: string) => void }> = ({
  type,
  initial,
  min,
  required,
  onValue,
}) => {
  const [value, setValue] = React.useState(initial);
  return (
    <KitDateField
      type={type}
      value={value}
      min={min}
      required={required}
      aria-label="field"
      onChange={(event) => {
        setValue(event.target.value);
        onValue(event.target.value);
      }}
    />
  );
};

describe('KitDateField', () => {
  afterEach(cleanup);

  it('shows the date in the till language and picks a day in the native format', () => {
    const onValue = vi.fn();
    render(<Harness type="date" initial="2026-11-01" onValue={onValue} />);
    const field = screen.getByRole('button', { name: 'field' });
    expect(field).toHaveTextContent('01/11/2026');
    fireEvent.click(field);
    const picker = screen.getByTestId('kit-date-picker');
    fireEvent.click(Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === '15')!);
    expect(onValue).toHaveBeenLastCalledWith('2026-11-15');
    expect(screen.queryByTestId('kit-date-picker')).toBeNull();
  });

  it('marks the chosen day in the kit selection yellow', () => {
    render(<Harness type="date" initial="2026-11-01" onValue={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    const chosen = screen.getByTestId('kit-date-picker').querySelector('[data-kit-date-selected="true"]')!;
    expect(chosen.textContent).toBe('1');
    expect(chosen.className).toContain('bg-(--pos-s-sel-bg)');
  });

  it('disables days before min', () => {
    render(<Harness type="date" initial="2026-11-10" min="2026-11-05" onValue={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    const days = Array.from(screen.getByTestId('kit-date-picker').querySelectorAll('button'));
    expect(days.find((b) => b.textContent === '4' && !b.className.includes('opacity-60'))).toBeDisabled();
    expect(days.find((b) => b.textContent === '5' && !b.className.includes('opacity-60'))).not.toBeDisabled();
  });

  it('picks a time as HH:mm: the hour keeps the panel open, the minute closes it', () => {
    const onValue = vi.fn();
    render(<Harness type="time" initial="19:30" onValue={onValue} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    const buttons = () => Array.from(screen.getByTestId('kit-date-picker').querySelectorAll('button'));
    fireEvent.click(buttons().find((b) => b.textContent === '20')!);
    expect(onValue).toHaveBeenLastCalledWith('20:30');
    expect(screen.getByTestId('kit-date-picker')).toBeInTheDocument();
    fireEvent.click(buttons().filter((b) => b.textContent === '45').pop()!);
    expect(onValue).toHaveBeenLastCalledWith('20:45');
    expect(screen.queryByTestId('kit-date-picker')).toBeNull();
  });

  it('builds a datetime-local value from the day and the time', () => {
    const onValue = vi.fn();
    render(<Harness type="datetime-local" initial="2026-11-01T09:00" onValue={onValue} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    const buttons = () => Array.from(screen.getByTestId('kit-date-picker').querySelectorAll('button'));
    fireEvent.click(buttons().find((b) => b.textContent === '3')!);
    expect(onValue).toHaveBeenLastCalledWith('2026-11-03T09:00');
    fireEvent.click(buttons().find((b) => b.textContent === '14' && b.getAttribute('aria-label') === null)!);
    expect(onValue).toHaveBeenLastCalledWith('2026-11-03T14:00');
  });

  it('offers Clear only on optional fields', () => {
    const onValue = vi.fn();
    const { unmount } = render(<Harness type="date" initial="2026-11-01" required onValue={onValue} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    unmount();
    render(<Harness type="date" initial="2026-11-01" onValue={onValue} />);
    fireEvent.click(screen.getByRole('button', { name: 'field' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it('leaves no native date, time or datetime-local input in the till', () => {
    const root = resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (/\.tsx$/.test(name)) {
          const source = readFileSync(path, 'utf8');
          if (/<input[^>]*type=["'](?:date|time|datetime-local)["']/s.test(source)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

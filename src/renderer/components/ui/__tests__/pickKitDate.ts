import { fireEvent, screen } from '@testing-library/react';

/**
 * Test helper for KitDateField (jsdom runs its plain-panel fallback): opens the field, walks the months
 * to the wanted day and returns that day's button. `pickKitDate` presses it.
 */
export function kitDayButton(field: HTMLElement, date: string): HTMLButtonElement {
  let panel = screen.queryByTestId('kit-date-picker');
  if (!panel) {
    fireEvent.click(field);
    panel = screen.getByTestId('kit-date-picker');
  }
  for (let step = 0; step < 600; step += 1) {
    const day = panel.querySelector<HTMLButtonElement>(`[data-kit-date-day="${date}"]`);
    if (day) return day;
    const days = panel.querySelectorAll<HTMLButtonElement>('[data-kit-date-day]');
    const middle = days[20]?.dataset.kitDateDay ?? '';
    fireEvent.click(panel.querySelector<HTMLButtonElement>(`[data-kit-date-nav="${date < middle ? 'prev' : 'next'}"]`)!);
    panel = screen.getByTestId('kit-date-picker');
  }
  throw new Error(`KitDateField: no day ${date}`);
}

export function pickKitDate(field: HTMLElement, date: string): void {
  fireEvent.click(kitDayButton(field, date));
}

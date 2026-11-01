import { describe, expect, it, vi } from 'vitest';
import {
  loginPinAutoSubmitLength,
  loginPinEnterKeyAfterPause,
  loginPinEnterKeyAtOnce,
  loginPinLengths,
  loginPinSlotForRole,
  readLoginPinLength,
  rememberLoginPinLength,
  type LoginPinSlots,
} from '../loginPinLength';

const slots = (overrides: Partial<LoginPinSlots> = {}): LoginPinSlots => ({
  adminConfigured: true,
  staffConfigured: true,
  adminLength: null,
  staffLength: null,
  ...overrides,
});

describe('login PIN length', () => {
  it('takes an unknown slot as six digits: signs in by itself at six, no enter key while typing', () => {
    const s = slots();
    expect(loginPinLengths(s)).toEqual([6]);
    expect(loginPinAutoSubmitLength(s)).toBe(6);
    for (const typed of [1, 2, 3, 4, 5]) expect(loginPinEnterKeyAtOnce(typed, s)).toBe(false);
  });

  it('signs in by itself at four when every configured PIN has four digits', () => {
    const s = slots({ adminLength: 4, staffLength: 4 });
    expect(loginPinAutoSubmitLength(s)).toBe(4);
    expect(loginPinEnterKeyAtOnce(4, s)).toBe(false);
  });

  it('a four-digit staff PIN beside a six-digit admin PIN gets the enter key at four, never a guess', () => {
    const s = slots({ adminLength: 6, staffLength: 4 });
    expect(loginPinAutoSubmitLength(s)).toBe(6);
    expect(loginPinEnterKeyAtOnce(4, s)).toBe(true);
    expect(loginPinEnterKeyAtOnce(5, s)).toBe(false);
    expect(loginPinEnterKeyAfterPause(5, s)).toBe(true);
  });

  it('offers the enter key after a pause for a shorter PIN the till does not know', () => {
    const s = slots();
    expect(loginPinEnterKeyAfterPause(3, s)).toBe(false);
    expect(loginPinEnterKeyAfterPause(4, s)).toBe(true);
    expect(loginPinEnterKeyAfterPause(5, s)).toBe(true);
    expect(loginPinEnterKeyAfterPause(6, s)).toBe(false);
  });

  it('a known longer PIN raises the keypad limit', () => {
    expect(loginPinAutoSubmitLength(slots({ adminConfigured: false, staffLength: 8 }))).toBe(8);
  });

  it('reads only plausible digit counts and maps the session role to a slot', () => {
    expect(readLoginPinLength('6')).toBe(6);
    expect(readLoginPinLength(4)).toBe(4);
    expect(readLoginPinLength(3)).toBeNull();
    expect(readLoginPinLength(9)).toBeNull();
    expect(readLoginPinLength('x')).toBeNull();
    expect(loginPinSlotForRole('admin')).toBe('admin');
    expect(loginPinSlotForRole({ name: 'admin' })).toBe('admin');
    expect(loginPinSlotForRole({ name: 'staff' })).toBe('staff');
    expect(loginPinSlotForRole(undefined)).toBe('staff');
  });

  it('keeps only the digit count, in local terminal settings', async () => {
    const updateLocal = vi.fn().mockResolvedValue({ success: true });
    await rememberLoginPinLength({ settings: { updateLocal } }, ['admin', 'staff'], 6);
    expect(updateLocal).toHaveBeenCalledWith({
      settingType: 'terminal',
      settings: { login_pin_length_admin: 6, login_pin_length_staff: 6 },
    });
    await rememberLoginPinLength({ settings: { updateLocal } }, ['staff'], 3);
    expect(updateLocal).toHaveBeenCalledTimes(1);
  });
});

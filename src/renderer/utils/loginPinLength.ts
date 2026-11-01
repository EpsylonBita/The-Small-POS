/**
 * How many digits the PIN screen waits for before it signs in by itself.
 *
 * Founder 31/10 («με το που βάλεις το σωστό PIN κάνει login μόνο του ... μήπως έβγαζα τελείως το κουμπί»):
 * the screen has no sign-in button, so it must know each configured PIN's length. The till keeps only the
 * digit count, never the PIN, one per slot (admin, staff), in local terminal settings. It is written when a
 * PIN is set (first setup, connection settings, legacy migration) and after every successful sign-in.
 *
 * A slot whose count is unknown (a PIN set before the till kept counts) is taken as six digits, the length
 * the first setup requires. The screen signs in by itself at the longest known length. A shorter known PIN
 * (a four-digit staff PIN beside a six-digit admin PIN) gets a small enter key as soon as it is typed, and
 * any other shorter PIN gets it after a short pause, so no PIN is ever unreachable and the screen never
 * spends a lockout attempt on a guess.
 */
export const LOGIN_PIN_MIN_LENGTH = 4;
/** The longest PIN the keypad takes once its length is known (settings accept longer PINs). */
export const LOGIN_PIN_MAX_KNOWN_LENGTH = 8;
/** The first PIN setup takes exactly six digits, so an unknown slot is taken as six. */
export const LOGIN_PIN_DEFAULT_LENGTH = 6;
/** The pause after which a PIN shorter than expected may still be sent with the enter key. */
export const LOGIN_PIN_ENTER_KEY_PAUSE_MS = 2000;

export const LOGIN_PIN_LENGTH_SETTING = {
  admin: 'login_pin_length_admin',
  staff: 'login_pin_length_staff',
} as const;

export type LoginPinSlot = keyof typeof LOGIN_PIN_LENGTH_SETTING;

export interface LoginPinSlots {
  adminConfigured: boolean;
  staffConfigured: boolean;
  adminLength: number | null;
  staffLength: number | null;
}

/** A stored digit count, or null when it is missing or out of range. */
export function readLoginPinLength(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= LOGIN_PIN_MIN_LENGTH && n <= LOGIN_PIN_MAX_KNOWN_LENGTH ? n : null;
}

/** The lengths a configured PIN has, shortest first (six when nothing is configured or known). */
export function loginPinLengths(slots: LoginPinSlots): number[] {
  const lengths = new Set<number>();
  if (slots.adminConfigured) lengths.add(slots.adminLength ?? LOGIN_PIN_DEFAULT_LENGTH);
  if (slots.staffConfigured) lengths.add(slots.staffLength ?? LOGIN_PIN_DEFAULT_LENGTH);
  if (lengths.size === 0) lengths.add(LOGIN_PIN_DEFAULT_LENGTH);
  return [...lengths].sort((a, b) => a - b);
}

/** The screen signs in by itself at this many digits, and the keypad takes no more. */
export function loginPinAutoSubmitLength(slots: LoginPinSlots): number {
  const lengths = loginPinLengths(slots);
  return lengths[lengths.length - 1];
}

/** A shorter known PIN is complete: show the enter key at once (signing in by itself could be a guess). */
export function loginPinEnterKeyAtOnce(typedLength: number, slots: LoginPinSlots): boolean {
  return typedLength < loginPinAutoSubmitLength(slots) && loginPinLengths(slots).includes(typedLength);
}

/** A PIN of an unexpected length may still be complete: offer the enter key after a pause. */
export function loginPinEnterKeyAfterPause(typedLength: number, slots: LoginPinSlots): boolean {
  return (
    typedLength >= LOGIN_PIN_MIN_LENGTH &&
    typedLength < loginPinAutoSubmitLength(slots) &&
    !loginPinLengths(slots).includes(typedLength)
  );
}

/** The slot a successful sign-in matched, from the session's role ('admin' or anything else = staff). */
export function loginPinSlotForRole(role: unknown): LoginPinSlot {
  const name = typeof role === 'object' && role !== null ? (role as { name?: unknown }).name : role;
  return name === 'admin' ? 'admin' : 'staff';
}

type LocalSettingsBridge = {
  settings: {
    updateLocal: (payload: { settingType: string; settings: Record<string, unknown> }) => Promise<unknown>;
  };
};

/** Keep a slot's digit count (never the PIN). Best effort: a failed write only brings the pause back. */
export async function rememberLoginPinLength(
  bridge: LocalSettingsBridge,
  slots: LoginPinSlot[],
  length: number,
): Promise<void> {
  if (readLoginPinLength(length) === null || slots.length === 0) return;
  const settings = Object.fromEntries(slots.map((slot) => [LOGIN_PIN_LENGTH_SETTING[slot], length]));
  try {
    await bridge.settings.updateLocal({ settingType: 'terminal', settings });
  } catch (error) {
    console.warn('[loginPinLength] Failed to remember the PIN length:', error);
  }
}

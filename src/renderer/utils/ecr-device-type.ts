import type { TFunction } from 'i18next';

/**
 * ECR device type and plugin admission (founder rule 08/10/2026: a plugin that
 * is not activated, configured and finished has no effect on the running till).
 *
 * The type of a device is never guessed silently:
 * - an RBS or ELIO brand, manufacturer, model or name is a fiscal cash register;
 * - otherwise an explicit stored `payment_terminal` / `cash_register` is kept;
 * - otherwise fiscal-only fields (print mode, tax rates) mean a cash register;
 * - anything else is unknown (`null`) and the user must choose the type.
 *
 * Native admits a device by its STORED type: a card terminal needs a licensed,
 * configured payment plugin for the branch; a cash register needs the MyData
 * plugin in `fiscal_device` mode with status `connected`. A device that is not
 * admitted is inert, so settings show it with its "needs its plugin" state and
 * refuse to add or enable it.
 */
export type EcrDeviceType = 'payment_terminal' | 'cash_register';

export interface EcrDeviceAdmission {
  cardTerminal: { admitted: boolean; fetchedAt: string | null };
  cashRegister: { admitted: boolean; fetchedAt: string | null; mode: string | null; status: string | null };
}

export type EcrAdmissionRefusalCode = 'DEVICE_NOT_ADMITTED' | 'DEVICE_TYPE_REQUIRED';

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** RBS or ELIO as a whole word; `_`, `-`, spaces and punctuation separate words. */
const FISCAL_IDENTITY = /(^|[^a-z0-9])(rbs|elio)(?=[^a-z0-9]|$)/i;
const IDENTITY_FIELDS = ['brand', 'manufacturer', 'model', 'name'] as const;

export function isEcrDeviceType(value: unknown): value is EcrDeviceType {
  return value === 'payment_terminal' || value === 'cash_register';
}

/** The type stored on (or sent for) this device, or null when it has none. */
export function storedEcrDeviceType(payload: unknown): EcrDeviceType | null {
  const row = record(payload);
  const raw = String(row.deviceType ?? row.device_type ?? '').trim().toLowerCase();
  return isEcrDeviceType(raw) ? raw : null;
}

/** True when the brand, manufacturer, model or name identifies an RBS / ELIO fiscal cash register. */
export function hasFiscalCashRegisterIdentity(payload: unknown): boolean {
  const row = record(payload);
  return IDENTITY_FIELDS.some((field) => {
    const value = text(row[field]);
    return value !== null && FISCAL_IDENTITY.test(value);
  });
}

function hasFiscalOnlyFields(payload: unknown): boolean {
  const row = record(payload);
  const printMode = text(row.print_mode ?? row.printMode);
  const taxRates = row.tax_rates ?? row.taxRates;
  return Boolean(printMode && printMode.trim()) || (Array.isArray(taxRates) && taxRates.length > 0);
}

/** The device type, or null when only the user can tell. Never defaults silently. */
export function resolveEcrDeviceType(payload: unknown): EcrDeviceType | null {
  if (hasFiscalCashRegisterIdentity(payload)) return 'cash_register';
  const stored = storedEcrDeviceType(payload);
  if (stored) return stored;
  if (hasFiscalOnlyFields(payload)) return 'cash_register';
  return null;
}

/**
 * The settings section that lists a stored device. Native uses (and admits) a
 * device by its stored type, so the stored type wins; a device without one is
 * listed by its resolved type, and an unknown one under payment terminals with
 * its "type not set" state. Every stored device is listed exactly once.
 */
export function ecrDeviceSettingsSection(payload: unknown): EcrDeviceType {
  return storedEcrDeviceType(payload) ?? resolveEcrDeviceType(payload) ?? 'payment_terminal';
}

/** A stored type that contradicts the device identity (e.g. an RBS / ELIO register saved as a card terminal). */
export function ecrDeviceTypeMismatch(payload: unknown): boolean {
  const stored = storedEcrDeviceType(payload);
  const resolved = resolveEcrDeviceType(payload);
  return stored !== null && resolved !== null && stored !== resolved;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** Reads the native `ecr_get_device_admission` answer; anything malformed is null (never admitted). */
export function parseEcrDeviceAdmission(raw: unknown): EcrDeviceAdmission | null {
  const row = record(raw);
  if (row.success !== true) return null;
  const card = record(row.cardTerminal);
  const cash = record(row.cashRegister);
  if (typeof card.admitted !== 'boolean' || typeof cash.admitted !== 'boolean') return null;
  return {
    cardTerminal: { admitted: card.admitted, fetchedAt: text(card.fetchedAt) },
    cashRegister: {
      admitted: cash.admitted,
      fetchedAt: text(cash.fetchedAt),
      mode: text(cash.mode),
      status: text(cash.status),
    },
  };
}

type AdmissionBridge = { getDeviceAdmission?: (options?: { refresh?: boolean }) => Promise<unknown> };

/**
 * Re-fetches the admission (native keeps the last known answer when offline),
 * falling back to the last known answer if the refresh fails. Never throws;
 * null means it could not be read, which admits nothing.
 */
export async function loadEcrDeviceAdmission(ecr: AdmissionBridge | null | undefined): Promise<EcrDeviceAdmission | null> {
  if (typeof ecr?.getDeviceAdmission !== 'function') return null;
  try {
    const fresh = parseEcrDeviceAdmission(await ecr.getDeviceAdmission({ refresh: true }));
    if (fresh) return fresh;
  } catch {
    // fall back to the last known answer below
  }
  try {
    return parseEcrDeviceAdmission(await ecr.getDeviceAdmission());
  } catch {
    return null;
  }
}

export function isEcrTypeAdmitted(admission: EcrDeviceAdmission | null | undefined, type: EcrDeviceType | null): boolean {
  if (!admission || !type) return false;
  return type === 'payment_terminal' ? admission.cardTerminal.admitted : admission.cashRegister.admitted;
}

/** Whether a stored device is admitted: by the loaded admission for its stored type, else native's own flag. */
export function isEcrDeviceAdmitted(payload: unknown, admission: EcrDeviceAdmission | null | undefined): boolean {
  if (admission) return isEcrTypeAdmitted(admission, storedEcrDeviceType(payload));
  return record(payload).admitted === true;
}

/**
 * Whether saving needs the type to be admitted (mirrors native): adding an
 * enabled device, enabling a disabled one, or changing the type of an enabled
 * one. Disabling, renaming and other edits never do.
 */
export function ecrSaveNeedsAdmission(
  next: { enabled: boolean; deviceType: EcrDeviceType },
  previous?: { enabled: boolean; deviceType: string | null } | null,
): boolean {
  if (!next.enabled) return false;
  if (!previous) return true;
  return !previous.enabled || previous.deviceType !== next.deviceType;
}

/**
 * The update to send for an edited device: an unchanged `enabled` or device
 * type is left out. Native refuses an update that carries `enabled: true` or a
 * device type for an enabled device of a type that is not admitted, so a rename
 * or other edit of such a device must not re-send them.
 */
export function ecrDeviceUpdatePatch<T extends Record<string, unknown>>(
  next: T,
  previous: { enabled: boolean; deviceType: string | null },
): Partial<T> {
  const patch: Partial<T> = { ...next };
  if (next.enabled === previous.enabled) delete patch.enabled;
  const nextType = storedEcrDeviceType(next);
  if (nextType !== null && nextType === storedEcrDeviceType({ deviceType: previous.deviceType })) {
    delete patch.deviceType;
    delete patch.device_type;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Localized texts
// ---------------------------------------------------------------------------

/** "Needs its plugin" state shown on a non-admitted device. */
export function ecrNeedsPluginMessage(t: TFunction, type: EcrDeviceType): string {
  return type === 'payment_terminal'
    ? t('ecr.admission.cardTerminalNeedsPlugin', {
        defaultValue:
          'Needs its plugin: card terminals stay inactive until a payment plugin is active and configured for this store.',
      })
    : t('ecr.admission.cashRegisterNeedsPlugin', {
        defaultValue:
          "Needs its plugin: fiscal cash registers stay inactive until the store's MyData plugin is in fiscal device mode and its setup is finished.",
      });
}

/** Refusal shown before (or instead of) a native add/enable of a non-admitted type. */
export function ecrNotAdmittedMessage(t: TFunction, type: EcrDeviceType): string {
  return type === 'payment_terminal'
    ? t('ecr.admission.cardTerminalRefused', {
        defaultValue:
          'This card terminal cannot be enabled: it needs an active, configured payment plugin for this store. You can save it disabled.',
      })
    : t('ecr.admission.cashRegisterRefused', {
        defaultValue:
          "This cash register cannot be enabled: it needs the store's MyData plugin in fiscal device mode with its setup finished. You can save it disabled.",
      });
}

export function ecrTypeRequiredMessage(t: TFunction): string {
  return t('ecr.admission.typeRequired', {
    defaultValue: 'Choose the device type: payment terminal or fiscal cash register.',
  });
}

/** Maps a native DEVICE_NOT_ADMITTED / DEVICE_TYPE_REQUIRED refusal to its localized text; null otherwise. */
export function ecrAdmissionErrorMessage(t: TFunction, result: unknown, fallbackType?: EcrDeviceType | null): string | null {
  const row = record(result);
  const failure = row.success === false ? row : record(row.data).success === false ? record(row.data) : null;
  if (!failure) return null;
  const code = failure.code ?? failure.errorCode;
  if (code === 'DEVICE_TYPE_REQUIRED') return ecrTypeRequiredMessage(t);
  if (code !== 'DEVICE_NOT_ADMITTED') return null;
  const type = storedEcrDeviceType(failure) ?? fallbackType ?? null;
  return type
    ? ecrNotAdmittedMessage(t, type)
    : t('ecr.admission.deviceRefused', {
        defaultValue: 'This device cannot be enabled until its plugin is active, configured and finished for this store.',
      });
}

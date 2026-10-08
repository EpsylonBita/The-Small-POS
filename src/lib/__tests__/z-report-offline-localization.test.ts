import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import el from '../../locales/el.json';
import de from '../../locales/de.json';
import fr from '../../locales/fr.json';
import it_ from '../../locales/it.json';
import sq from '../../locales/sq.json';
import {
  formatOperatorFacingError,
  formatZReportOfflineMessage,
  Z_REPORT_OFFLINE_ERROR_CODE,
} from '../payment-integrity';

// Offline audit 07/10/2026: with no internet the Z showed a Greek cashier
// «Αποτυχία: Cannot close day: pre-Z-report sync failed: reconcile remote
// orders: Cannot reach admin dashboard at …». The native Z now answers the
// typed Z_REPORT_OFFLINE, said in the store's language with what to do.

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const translatorFor = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: false,
    resources: { [lng]: { translation: LOCALES[lng] } },
    interpolation: { escapeValue: false },
  });
  return instance.t;
};

const offlineRefusal = {
  success: false,
  errorCode: Z_REPORT_OFFLINE_ERROR_CODE,
  stage: 'pre_z_sync',
  error: 'No connection to the server: the day cannot be closed now. Keep selling; close the day once the connection is back.',
};

describe('the offline Z refusal', () => {
  it.each(Object.keys(LOCALES) as Lng[])('is translated in %s, never the native English', async (lng) => {
    const t = await translatorFor(lng);
    const message = formatOperatorFacingError(offlineRefusal, 'fallback', t);
    expect(message).toBe(LOCALES[lng].zReportOffline.refusal);
    expect(message).not.toContain('pre-Z-report sync failed');
    if (lng !== 'en') expect(message).not.toBe(en.zReportOffline.refusal);
  });

  it.each(Object.keys(LOCALES) as Lng[])('has its status and checklist lines in %s', (lng) => {
    const block = LOCALES[lng].zReportOffline;
    for (const key of ['refusal', 'status', 'checklist'] as const) {
      expect(typeof block[key]).toBe('string');
      expect(block[key].trim().length).toBeGreaterThan(10);
    }
  });

  it('is found inside a thrown native error too', async () => {
    const t = await translatorFor('el');
    expect(formatZReportOfflineMessage({ data: offlineRefusal }, t)).toBe(el.zReportOffline.refusal);
  });

  it('leaves every other answer to its own formatter', async () => {
    const t = await translatorFor('en');
    expect(formatZReportOfflineMessage({ success: false, errorCode: 'SYNC_CLOSEOUT_BLOCKED' }, t)).toBeNull();
    expect(formatZReportOfflineMessage(new Error('Cannot close day: pre-Z-report sync failed: HTTP 500'), t)).toBeNull();
  });
});

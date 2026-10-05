import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

import { formatTableDisplayNumber } from '../../src/renderer/utils/table-display.ts';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableActionModal.tsx'),
  'utf8',
);
const dashboardSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);
const localesDir = path.join(process.cwd(), 'src', 'locales');

const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const createT = async (lng: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
      de: { translation: loadLocale('de') },
      fr: { translation: loadLocale('fr') },
      it: { translation: loadLocale('it') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(lng);
};

const untranslatedTableActionKeys = [
  'decreaseCovers',
  'increaseCovers',
  'unpaidBalance',
  'newOrderCleaningDisabled',
  'newOrderMaintenanceDisabled',
  'newOrderUnavailableDisabled',
  'markCleaned',
  'markAvailable',
  'markBackInService',
  'markAvailableDescription',
  'markBackInServiceDescription',
  'editReservation',
  'editReservationDescription',
  'noShowReservation',
  'noShowReservationDescription',
  'cancelReservation',
  'cancelReservationDescription',
  'newReservationUnavailableDescription',
  'cleaningHint',
  'maintenanceHint',
  'reservedHint',
  'unavailableHint',
  'reservationNotFound',
  'reservationLoadFailed',
  'noShowSuccess',
  'noShowFailed',
  'cancelReason',
  'cancelSuccess',
  'cancelFailed',
  'setAvailableSuccess',
  'setAvailableFailed',
];

test('table actions and floor plan use the shared accessible modal lifecycle', () => {
  for (const source of [modalSource, readFileSync(path.join(process.cwd(), 'src/renderer/components/tables/TableFloorPlanModal.tsx'), 'utf8')]) {
    assert.match(source, /<LiquidGlassModal/);
    assert.match(source, /closeMode="request"/);
    assert.doesNotMatch(source, /document.addEventListener\('keydown'/);
  }
});
test('TableActionModal header uses the shared table display helper, not the raw table number', () => {
  // The modal header showed "#B01" while the grid card showed "#TB01"; both must use
  // the same display convention so the identifier matches the clicked card.
  assert.match(modalSource, /import \{ formatTableDisplayNumber \} from ['"]\.\.\/\.\.\/utils\/table-display['"];/);
  assert.match(modalSource, /formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.doesNotMatch(modalSource, /#\{table\.tableNumber\}/);

  // The embedded dashboard table card uses the same shared helper (no local duplicate).
  assert.match(dashboardSource, /import \{ formatTableDisplayNumber \} from ['"]\.\.\/utils\/table-display['"];/);
  assert.match(dashboardSource, /formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.doesNotMatch(dashboardSource, /const formatTableCardNumber =/);
});
test('formatTableDisplayNumber matches the dashboard card convention', () => {
  assert.equal(formatTableDisplayNumber('B01'), '#TB01');
  assert.equal(formatTableDisplayNumber('T05'), '#T05');
  assert.equal(formatTableDisplayNumber('t9'), '#t9');
  assert.equal(formatTableDisplayNumber('#T05'), '#T05');
  assert.equal(formatTableDisplayNumber('05'), '#T05');
  assert.equal(formatTableDisplayNumber(''), '#T');
  assert.equal(formatTableDisplayNumber(null), '#T');
});

test('TableActionModal renders capacity guests through i18next plurals', async () => {
  assert.match(
    modalSource,
    /t\('tableActionModal\.guests',\s*\{\s*count:\s*table\.capacity/,
    'TableActionModal must pass count when rendering the capacity guest noun',
  );

  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const modal = loadLocale(lng).tableActionModal;
    assert.equal(typeof modal.guests_one, 'string', `${lng}.tableActionModal.guests_one missing`);
    assert.equal(typeof modal.guests_other, 'string', `${lng}.tableActionModal.guests_other missing`);
    assert.equal(modal.guests, undefined, `${lng}.tableActionModal.guests should not remain as a flat fallback`);
  }

  const t = await createT('el');
  assert.equal(t('tableActionModal.guests', { count: 1 }), 'επισκέπτης');
  assert.equal(t('tableActionModal.guests', { count: 2 }), 'επισκέπτες');
});

test('de/fr/it TableActionModal action copy no longer leaks English source strings', () => {
  const en = loadLocale('en').tableActionModal;

  for (const lng of ['de', 'fr', 'it', 'sq']) {
    const modal = loadLocale(lng).tableActionModal;
    for (const key of untranslatedTableActionKeys) {
      assert.notEqual(
        modal[key],
        en[key],
        `${lng}.tableActionModal.${key} still equals the English source string`,
      );
    }
  }
});

test('liquid-glass-modal-title uses non-negative letter-spacing (no negative tracking anywhere in the glass CSS)', () => {
  const glassCss = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'),
    'utf8',
  );
  // No negative letter-spacing anywhere in the shared glass stylesheet.
  assert.doesNotMatch(glassCss, /letter-spacing:\s*-/);
  // Every `.liquid-glass-modal-title` block that sets tracking sets it to 0.
  const titleBlocks = glassCss.match(/\.liquid-glass-modal-title\s*\{[^}]*\}/g) || [];
  assert.ok(titleBlocks.length >= 1, 'liquid-glass-modal-title selector must exist');
  for (const block of titleBlocks) {
    if (block.includes('letter-spacing')) {
      assert.match(block, /letter-spacing:\s*0\b/, 'liquid-glass-modal-title letter-spacing must be 0');
    }
  }
});

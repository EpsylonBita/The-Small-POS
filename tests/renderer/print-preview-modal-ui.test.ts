import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'PrintPreviewModal.tsx'),
  'utf8',
);

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${language}.json`), 'utf8'));

test('PrintPreviewModal zoom controls are touch-first, labelled, and hover-free', () => {
  assert.match(source, /const zoomOutLabel = t\('modals\.printPreview\.zoomOut'/);
  assert.match(source, /const zoomInLabel = t\('modals\.printPreview\.zoomIn'/);
  assert.match(source, /aria-label=\{zoomOutLabel\}/);
  assert.match(source, /aria-label=\{zoomInLabel\}/);
  assert.match(source, /inline-flex h-11 w-11 items-center justify-center rounded-2xl/);
  assert.match(source, /active:scale-95/);

  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /title="Zoom (In|Out)"/);
});

test('PrintPreviewModal owns visible strings through i18n', () => {
  assert.match(source, /t\('modals\.printPreview\.receiptFrame'/);
  assert.match(source, /title=\{receiptPreviewLabel\}/);
  assert.match(source, /t\('modals\.printPreview\.previewUnavailable'/);
  assert.match(source, /t\('modals\.printPreview\.defaultPrinter'/);
  assert.match(source, /aria-label=\{t\('common\.actions\.downloadPdf'/);

  assert.doesNotMatch(source, />Preview unavailable</);
  assert.doesNotMatch(source, /Default Stylus Printer/);
  assert.doesNotMatch(source, /title="Receipt Preview"/);
});

test('print preview labels exist in every supported locale', () => {
  const keys = ['zoomOut', 'zoomIn', 'receiptFrame', 'previewUnavailable', 'defaultPrinter'];

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const printPreview = locale(language).modals?.printPreview;
    assert.ok(printPreview, `${language} is missing modals.printPreview`);
    for (const key of keys) {
      assert.equal(typeof printPreview[key], 'string', `${language}.modals.printPreview.${key} missing`);
      assert.ok(printPreview[key].length > 0, `${language}.modals.printPreview.${key} should be non-empty`);
    }
  }
});

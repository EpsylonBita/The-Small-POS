import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

const viewSource = read('src/renderer/pages/verticals/salon/ServiceCatalogView.tsx');
const serviceSource = read('src/renderer/services/ServicesService.ts');

test('ServiceCatalogView management controls are wired to real handlers', () => {
  assert.match(viewSource, /onClick=\{openCreateService\}/);
  assert.match(viewSource, /onClick=\{\(event\) => openEditService\(service, event\)\}/);
  assert.match(viewSource, /onClick=\{\(event\) => openDeleteService\(service, event\)\}/);
  assert.match(viewSource, /event\?\.stopPropagation\(\)/);
});

test('ServiceCatalogView add/edit and delete modals portal outside the page with a blurred backdrop', () => {
  assert.match(viewSource, /import \{ renderModalPortal \} from '\.\.\/\.\.\/\.\.\/utils\/render-modal-portal';/);
  const portalUsages = viewSource.match(/renderModalPortal\(/g);
  assert.ok(portalUsages && portalUsages.length >= 2, 'add/edit and delete modals should portal');
  assert.match(viewSource, /fixed inset-0 z-\[1200\]/);
  assert.match(viewSource, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
});

test('ServiceCatalogView submit is validated before saving', () => {
  assert.match(viewSource, /const canSubmitService =[\s\S]*serviceDraft\.name\.trim\(\)\.length > 0[\s\S]*servicePrice >= 0[\s\S]*serviceDuration >= 1/);
  assert.match(viewSource, /disabled=\{!canSubmitService \|\| isSaving\}/);
  assert.match(viewSource, /serviceCatalog\.validation\.nameRequired/);
  assert.match(viewSource, /serviceCatalog\.validation\.priceInvalid/);
  assert.match(viewSource, /serviceCatalog\.validation\.durationInvalid/);
});

test('ServicesService exposes POS API mutations for service catalog management', () => {
  assert.match(serviceSource, /posApiPost<ServiceSingleResponse>\('\/api\/pos\/services'/);
  assert.match(serviceSource, /posApiPatch<ServiceSingleResponse>\(\s*`\/api\/pos\/services\/\$\{encodeURIComponent\(serviceId\)\}`/);
  assert.match(serviceSource, /posApiDelete<\{ success\?: boolean; error\?: string; message\?: string \}>\(\s*`\/api\/pos\/services\/\$\{encodeURIComponent\(serviceId\)\}`/);
  assert.match(serviceSource, /duration_minutes/);
  assert.match(serviceSource, /category_id/);
  assert.match(serviceSource, /is_active/);
});

// Regression contract for the card duration unit (2026-06-20 review): service cards
// rendered "{durationMinutes}min" - an English "min" leak in the Greek UI while the
// add/edit modal label was localized. The card unit must be localized too.
test('ServiceCatalogView service cards render a localized duration unit, not hardcoded English "min"', () => {
  // The hardcoded English "min" suffix is gone.
  assert.doesNotMatch(viewSource, /\{service\.durationMinutes\}min/);
  // Duration renders the value plus the shared localized minutes unit.
  assert.match(
    viewSource,
    /\{service\.durationMinutes\} \{t\('common\.minutes', \{ defaultValue: 'min' \}\)\}/,
  );
});

test('Round 393: ServiceCatalogView uses the shared page title and touch-first rounded chrome', () => {
  assert.match(
    viewSource,
    /<h1 className=\{`truncate text-3xl font-bold tracking-tight \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>\s*\{t\('navigation\.menu\.service_catalog', \{ defaultValue: 'Services' \}\)\}\s*<\/h1>/,
  );

  const refreshButton = viewSource.slice(
    viewSource.lastIndexOf('<button', viewSource.indexOf('onClick={() => refetch()}')),
    viewSource.indexOf('</button>', viewSource.indexOf('onClick={() => refetch()}')) + '</button>'.length,
  );
  assert.ok(refreshButton.length > 0, 'refresh button must be found');
  assert.match(refreshButton, /type="button"/);
  assert.match(refreshButton, /aria-label=\{t\('common\.refresh', \{ defaultValue: 'Refresh' \}\)\}/);
  assert.match(refreshButton, /h-11 w-11 items-center justify-center rounded-xl/);

  // Category tabs follow the yellow selected accent and hide native horizontal scrollbars.
  assert.match(viewSource, /overflow-x-auto scrollbar-hide border/);
  assert.match(viewSource, /activeTab === tab\.id\s*\?\s*'bg-yellow-400 text-black shadow-sm'/);
  assert.doesNotMatch(viewSource, /bg-zinc-100 text-black shadow-sm/);
  assert.doesNotMatch(viewSource, /bg-black text-white shadow-sm/);

  // The scrollable service grid hides native scrollbars, and old small-radius controls are gone.
  assert.match(viewSource, /className="flex-1 overflow-y-auto scrollbar-hide"/);
  assert.doesNotMatch(viewSource, /rounded-lg/);

  // Touch POS invariants: no hover-only utilities and no native title tooltips.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

test('common.minutes is a real translation in every POS locale (Greek prevents "45min" leaks)', () => {
  const loadLocale = (lng: string) => JSON.parse(read(`src/locales/${lng}.json`));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadLocale(lng).common?.minutes;
    assert.equal(typeof value, 'string', `${lng} missing common.minutes`);
    assert.ok(value.length > 0, `${lng} empty common.minutes`);
  }
  // Greek must be a real translation, not the English "min".
  assert.notEqual(loadLocale('el').common.minutes, loadLocale('en').common.minutes);
  assert.match(loadLocale('el').common.minutes, new RegExp('[\u0370-\u03FF]'));
});

// Regression contract for the unlabelled Services modals (2026-06-21 live QA): the
// add/edit form modal and the delete confirmation looked modal (portaled + blurred) but
// exposed no role="dialog"/aria-modal/aria-labelledby, and Escape did not close them.
test('ServiceCatalogView add/edit modal exposes labelled dialog semantics with a blurred portal backdrop', () => {
  // Stable title id from useId at the top level.
  assert.match(viewSource, /import React, \{[^}]*\buseId\b[^}]*\} from 'react';/);
  assert.match(viewSource, /const serviceTitleId = useId\(\);/);

  // The add/edit panel is the <form> itself, declared as a labelled dialog.
  assert.match(
    viewSource,
    /ref=\{serviceDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{serviceTitleId\}/,
    'the add/edit form must be a labelled dialog',
  );
  // The title heading carries the referenced id (it switches between add/edit copy).
  assert.match(viewSource, /<h2 id=\{serviceTitleId\} className="text-lg font-semibold">/);
  assert.match(viewSource, /serviceCatalog\.editTitle/);
  assert.match(viewSource, /serviceCatalog\.addTitle/);

  // Still portaled outside the page container with the blurred app backdrop.
  assert.match(viewSource, /\{serviceModalMode && renderModalPortal\(/);
  assert.match(viewSource, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
});

test('ServiceCatalogView delete confirmation exposes labelled dialog semantics with a blurred portal backdrop', () => {
  assert.match(viewSource, /const deleteTitleId = useId\(\);/);
  assert.match(
    viewSource,
    /ref=\{deleteDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{deleteTitleId\}/,
    'the delete confirmation must be a labelled dialog',
  );
  assert.match(viewSource, /<div className="mb-2 flex items-center gap-2">/);
  assert.match(viewSource, /<Trash2 className="h-5 w-5 shrink-0 text-red-500" \/>/);
  assert.match(viewSource, /<h2 id=\{deleteTitleId\} className="text-lg font-semibold">/);
  assert.match(viewSource, /\{deleteTarget && renderModalPortal\(/);
});

// Regression contract for the non-dismissable Services modals (2026-06-21 live QA): Escape
// did nothing; only Cancel closed them. Escape must close the topmost modal through the
// close-only paths and never submit the form or delete a service.
test('ServiceCatalogView Escape closes via close-only paths, never submit/delete', () => {
  // Close-only callbacks (stable via useCallback) gate on isSaving so a save is never
  // interrupted, and only flip the relevant modal state.
  assert.match(
    viewSource,
    /const closeServiceModal = useCallback\(\(\) => \{\s*if \(isSaving\) return;\s*setServiceModalMode\(null\);\s*setServiceDraft\(EMPTY_SERVICE_DRAFT\);\s*\}, \[isSaving\]\);/,
  );
  assert.match(
    viewSource,
    /const closeDeleteModal = useCallback\(\(\) => \{\s*if \(isSaving\) return;\s*setDeleteTarget\(null\);\s*\}, \[isSaving\]\);/,
  );

  // Add/edit Escape effect: gated on serviceModalMode, topmost-[role="dialog"] gated,
  // routed to closeServiceModal.
  assert.match(viewSource, /if \(!serviceModalMode\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== serviceDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*closeServiceModal\(\);/);

  // Delete Escape effect: gated on deleteTarget, topmost gated, routed to closeDeleteModal.
  assert.match(viewSource, /if \(!deleteTarget\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== deleteDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*closeDeleteModal\(\);/);

  // Both effects register + clean up a keydown listener.
  const adds = viewSource.match(/document\.addEventListener\('keydown', handleEscape\)/g) ?? [];
  const removes = viewSource.match(/document\.removeEventListener\('keydown', handleEscape\)/g) ?? [];
  assert.ok(adds.length >= 2, 'both modals should register an Escape keydown listener');
  assert.ok(removes.length >= 2, 'both Escape listeners should be cleaned up');

  // No Escape handler routes to the side-effecting submit/delete handlers.
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleSubmitService/);
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleDeleteService/);

  // Structural guarantee: handleSubmitService is referenced only at its definition and
  // the form onSubmit; handleDeleteService only at its definition and the Delete button.
  // (2 occurrences each => no close/Escape path can reach them.)
  assert.equal((viewSource.match(/handleSubmitService/g) ?? []).length, 2);
  assert.equal((viewSource.match(/handleDeleteService/g) ?? []).length, 2);
  assert.match(viewSource, /onSubmit=\{handleSubmitService\}/);
  assert.match(viewSource, /onClick=\{handleDeleteService\}/);

  // Existing Cancel + backdrop close affordances still route through the close-only paths.
  assert.match(viewSource, /onClick=\{closeServiceModal\}/);
  assert.match(viewSource, /onClick=\{closeDeleteModal\}/);
});

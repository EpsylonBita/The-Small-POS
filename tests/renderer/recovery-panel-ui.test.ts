import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const panelPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'recovery',
  'RecoveryPanel.tsx',
);
const source = readFileSync(panelPath, 'utf8');

// Round 198 (Settings → Data → Local Recovery accessible selection state, live QA): the recovery
// snapshot cards are a single-select list driving the right-side detail panel. The selected card had
// the yellow border/background visually, but the accessibility tree exposed each snapshot only as a
// plain button with no selected/pressed state, so assistive-tech users could not tell which recovery
// point was selected. Fix: aria-pressed={isSelected} on each recovery-point button (the programmatic
// state mirrors the existing selected styling), plus a data-recovery-point-list marker for tests.
// Behaviour, layout, colours, copy, and the export/restore/create/open handlers are unchanged.
function recoveryPointList(text: string): string {
  const start = text.indexOf('data-recovery-point-list');
  assert.notEqual(start, -1, 'recovery point list must carry the data-recovery-point-list marker');
  // Scope to the list region, up to the detail panel that renders the selected point.
  const end = text.indexOf('{selectedPoint ?', start);
  assert.notEqual(end, -1, 'the detail panel must follow the recovery point list');
  return text.slice(start, end);
}

test('Round 198: recovery-point cards expose selected state via aria-pressed and keep their handler', () => {
  const list = recoveryPointList(source);

  // Selection is still derived from the current selectedPointId.
  assert.match(source, /const isSelected = point\.id === selectedPointId;/);

  // Each recovery-point button keeps its single-select onClick and now exposes aria-pressed, so the
  // accessibility tree announces which snapshot is selected.
  assert.match(list, /onClick=\{\(\) => setSelectedPointId\(point\.id\)\}/);
  assert.match(list, /aria-pressed=\{isSelected\}/);

  // aria-pressed sits on the same selection button as the onClick (right before the className), so the
  // programmatic pressed state and the yellow selected styling are driven by the same isSelected.
  assert.match(
    list,
    /onClick=\{\(\) => setSelectedPointId\(point\.id\)\}\s*aria-pressed=\{isSelected\}/,
  );
  assert.match(list, /isSelected\s*\?\s*'border-yellow-400\/60 bg-yellow-400\/10'/);

  // Stable list marker present for live QA / future guards.
  assert.match(source, /data-recovery-point-list/);
});

test('RecoveryPanel introduces no native title tooltips or hover utilities (touchscreen)', () => {
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
});

// Round 327 (supervisor correction, live QA Greek/dark): the previous "collapse behind a disclosure" still
// RENDERED the raw IDs in the DOM (the screenshot was the expanded state). For a cashier-facing card the
// identifiers must not be in the rendered detail at all. The selected detail now shows NO raw snapshot id,
// terminal id, or branch UUID anywhere -- the disclosure is replaced by a static, non-interactive support
// note. selectedPoint.id stays ONLY inside the export/restore handlers (a function argument, never text).
test('Round 327: the selected detail renders no raw IDs anywhere; a non-interactive support note replaces the disclosure', () => {
  const detail = source.slice(
    source.indexOf('{selectedPoint ?'),
    source.indexOf("t('settings.recovery.selectPoint'"),
  );
  assert.ok(detail.length > 0, 'selected detail region must exist');

  // No identifier is rendered in the selected detail JSX -- not the snapshot id, terminal id, or branch id,
  // and not behind any disclosure (the old <details> is gone).
  assert.doesNotMatch(detail, /selectedPoint\.id/, 'the snapshot id must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /selectedPoint\.terminalId/, 'the terminal id must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /selectedPoint\.branchId/, 'the branch UUID must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /data-recovery-technical-details/, 'the raw-ID technical-details disclosure must be gone');
  assert.doesNotMatch(detail, /<details/, 'no disclosure should remain in the selected detail');
  assert.doesNotMatch(detail, /<summary/, 'no summary should remain in the selected detail');

  // Hardening (supervisor correction): the rendered detail must ALSO be free of the old technical-details
  // locale KEYS and ID LABELS, so no future "Technical details" / "Recovery point ID" / "Terminal" /
  // "Branch" render path can reappear even if it reads the id via a helper/variable and so dodges the
  // selectedPoint.* literals above. (These keys may still exist in locale files; they must not be RENDERED.)
  assert.doesNotMatch(detail, /technicalDetailsHelper/, 'the technicalDetailsHelper key must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /technicalDetails\b/, 'the technicalDetails key must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /recoveryPointId/, 'the recovery point ID label must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /terminalLabel/, 'the terminal-id label must not be rendered in the selected detail');
  assert.doesNotMatch(detail, /branchLabel/, 'the branch-id label must not be rendered in the selected detail');

  // Round 347 hardening: the user's "Τεχνικές λεπτομέρειες" screenshot was actually the device-setup overview
  // disclosure (now removed), but its strings/markers must never reappear in the recovery selected detail
  // either -- guard the deviceSetup overview keys, the disclosure marker, and the literal EN/EL "Technical
  // details" labels so a shared-string regression can't leak raw IDs back into this card.
  assert.doesNotMatch(detail, /data-register-technical-details/, 'the register technical-details disclosure must not appear in the recovery detail');
  assert.doesNotMatch(detail, /settings\.deviceSetup\.overview\.technicalDetails/, 'no deviceSetup overview technicalDetails key may render in the recovery detail');
  assert.doesNotMatch(detail, /technicalDetailsHelper/, 'no technicalDetailsHelper key may render in the recovery detail');
  assert.doesNotMatch(detail, /Technical details/i, 'the literal "Technical details" label must not render in the recovery detail');
  assert.doesNotMatch(detail, /Τεχνικές λεπτομέρειες/, 'the Greek "Technical details" label must not render in the recovery detail');

  // Round 337 hardening (now that the parity suite runs this guard): sweep the WHOLE RecoveryPoint id/path
  // surface, not just id/terminal/branch. None of these raw identifiers or filesystem paths may render in the
  // cashier-facing detail -- the type also carries path/snapshotPath/walPath/shmPath/fingerprint/organizationId
  // and latestZReportId. They stay internal to the export/restore/open-folder handlers.
  for (const field of [
    'id',
    'path',
    'snapshotPath',
    'walPath',
    'shmPath',
    'fingerprint',
    'terminalId',
    'branchId',
    'organizationId',
    'latestZReportId',
  ]) {
    assert.doesNotMatch(
      detail,
      new RegExp(`selectedPoint\\.${field}\\b`),
      `selectedPoint.${field} must not render in the selected detail`,
    );
  }

  // No generated/scheduled snapshot id literal may leak either -- not a UUID-shaped id, and not a datestamped
  // scheduled/snapshot/recovery/pre_* id literal (those are produced by the snapshot pipeline, never shown).
  assert.doesNotMatch(detail, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'no UUID id literal in the selected detail');
  assert.doesNotMatch(detail, /(?:scheduled|snapshot|recovery|pre)[-_]\d/i, 'no datestamped scheduled/snapshot id literal in the selected detail');

  // selectedPoint.id may still be used by the non-UI export/restore handlers (defined OUTSIDE the rendered
  // detail region), so the export/restore behaviour is preserved.
  assert.match(source, /bridge\.recovery\.exportPoint\(selectedPoint\.id\)/);
  assert.match(source, /bridge\.recovery\.restorePoint\(selectedPoint\.id\)/);

  // A calm, NON-interactive support note replaces the disclosure: a marked card with title + help, no IDs,
  // not clickable (no onClick), no chevron.
  assert.match(detail, /data-recovery-support-note/);
  const noteStart = detail.indexOf('data-recovery-support-note');
  const note = detail.slice(noteStart, detail.indexOf('</div>', detail.indexOf('supportNoteHelp')) + 6);
  assert.match(note, /t\('settings\.recovery\.supportNoteTitle'/);
  assert.match(note, /t\('settings\.recovery\.supportNoteHelp'/);
  assert.doesNotMatch(note, /onClick=/, 'the support note must not be interactive');
  assert.doesNotMatch(note, /ChevronDown/, 'the support note has no expanding chevron');
  assert.doesNotMatch(note, /selectedPoint\.(id|terminalId|branchId)/, 'the support note shows no identifiers');
  // The disclosure-only chevron import is removed.
  assert.doesNotMatch(source, /ChevronDown/);

  // The normal visible detail keeps human info + handlers (kind/date/counts/size/business day/restore note/
  // export+restore buttons).
  assert.match(detail, /t\('settings\.recovery\.businessDay'/);
  assert.match(detail, /selectedPoint\.tableCounts\.orders/);
  assert.match(detail, /formatBytes\(selectedPoint\.snapshotSizeBytes\)/);
  assert.match(detail, /onClick=\{handleExportPoint\}/);
  assert.match(detail, /onClick=\{handleRestorePoint\}/);
  assert.match(detail, /t\('settings\.recovery\.restoreNote'/);

  // Touch-first: no hover/title in the selected detail.
  assert.doesNotMatch(detail, /hover:/);
  assert.doesNotMatch(detail, /\btitle=/);

  // The new support-note copy is localized in every POS locale (Greek not English, no raw-key leak).
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const load = (lng: string): unknown =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  const get = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
  const keys = ['settings.recovery.supportNoteTitle', 'settings.recovery.supportNoteHelp'];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    for (const key of keys) {
      const value = get(load(lng), key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).length > 0, `${lng} empty ${key}`);
      assert.notEqual(value, key, `${lng} ${key} leaks the dotted key`);
    }
  }
  for (const key of keys) {
    assert.notEqual(get(load('el'), key), get(load('en'), key), `el ${key} must be a Greek translation`);
  }
});

// Round 328 (live QA, Greek/dark, 1282x802): after the raw-ID fix the selected recovery detail card still
// leaked a slim native vertical scrollbar rail in the nested Tauri/WebView glass card. It is now hidden via
// a dedicated, SCOPED marker/class (so other panes are untouched), with scrolling kept functional.
test('Round 328: the selected detail pane hides its native scrollbar via a scoped marker/class; scrolling intact', () => {
  // The right-side selected detail scroll container carries the dedicated marker + class AND keeps the
  // bounded scroll behaviour (overflow-y-auto + the viewport-aware max height).
  const container = source.slice(
    source.indexOf('data-recovery-detail-scroll'),
    source.indexOf('{selectedPoint ?'),
  );
  assert.ok(container.length > 0, 'the selected detail scroll container must exist');
  assert.match(container, /recovery-detail-scrollbar-hidden/);
  assert.match(container, /overflow-y-auto/);
  assert.match(container, /style=\{\{ maxHeight: RECOVERY_PANEL_MAX_HEIGHT_STYLE \}\}/);

  // The scoped CSS lives in globals.css and hides every WebKit/Chromium scrollbar part robustly while
  // keeping touch/wheel scrolling.
  const globalsCss = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'globals.css'),
    'utf8',
  );
  assert.match(globalsCss, /\[data-recovery-detail-scroll\]/);

  // Base hide flags on the scoped selector.
  const baseStart = globalsCss.indexOf('.recovery-detail-scrollbar-hidden,');
  assert.notEqual(baseStart, -1, 'the scoped base rule must exist in globals.css');
  const baseBlock = globalsCss.slice(baseStart, globalsCss.indexOf('}', baseStart) + 1);
  assert.match(baseBlock, /scrollbar-width:\s*none/);
  assert.match(baseBlock, /-ms-overflow-style:\s*none/);
  assert.match(baseBlock, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(baseBlock, /overscroll-behavior:\s*contain/);

  // Every WebKit scrollbar part is targeted (rail, button, track, corner, thumb).
  for (const part of ['scrollbar', 'scrollbar-button', 'scrollbar-track', 'scrollbar-corner', 'scrollbar-thumb']) {
    assert.match(
      globalsCss,
      new RegExp(`recovery-detail-scrollbar-hidden::-webkit-${part}\\b`),
      `globals.css must hide ::-webkit-${part}`,
    );
  }
  // The WebKit hide-rule body zeroes size, removes display, and clears background.
  const webkitStart = globalsCss.indexOf('.recovery-detail-scrollbar-hidden::-webkit-scrollbar');
  assert.notEqual(webkitStart, -1, 'the scoped ::-webkit-scrollbar rule must exist');
  const webkitBlock = globalsCss.slice(webkitStart, globalsCss.indexOf('}', webkitStart) + 1);
  assert.match(webkitBlock, /width:\s*0\s*!important/);
  assert.match(webkitBlock, /height:\s*0\s*!important/);
  assert.match(webkitBlock, /display:\s*none\s*!important/);
  assert.match(webkitBlock, /background:\s*transparent\s*!important/);
});

// Round 339 (supervisor correction, live QA): the running Tauri app kept showing the old "Technical details /
// Recovery point ID / Terminal / Branch" recovery card because those settings.recovery locale keys were still
// bundled into dist -- i18n JSON ships whole, used or not -- even though no component renders them. So the
// component-render guard above is necessary but not sufficient: a dead key still travels into the bundle. The
// keys are now removed from every POS locale; this guard keeps them gone (so a rebuilt bundle cannot resurrect
// the raw-ID copy), keeps the still-used recovery keys, and proves the prune did NOT touch the unrelated
// settings.deviceSetup.overview disclosure or the modals.expense terminal/branch labels.
test('Round 339: obsolete settings.recovery technical-detail keys are removed from every POS locale', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const load = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  const removed = ['technicalDetails', 'technicalDetailsHelper', 'recoveryPointId', 'terminalLabel', 'branchLabel'];
  const kept = ['businessDay', 'supportNoteTitle', 'supportNoteHelp'];

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const j = load(lng);
    const recovery = (j.settings?.recovery ?? {}) as Record<string, unknown>;

    for (const key of removed) {
      assert.ok(
        !(key in recovery),
        `${lng}: settings.recovery.${key} must be removed -- it re-bundled the raw-ID recovery UI`,
      );
    }
    for (const key of kept) {
      assert.equal(typeof recovery[key], 'string', `${lng}: settings.recovery.${key} must still exist`);
    }

    // Scope guard: the round-339 settings.recovery prune left the expense modal's terminal/branch labels
    // intact (those legitimately remain in use). The device-setup overview technicalDetails keys were later
    // removed in Round 347 (raw-ID leak hardening), so they must now be ABSENT here too.
    assert.ok(
      !('technicalDetails' in (j.settings?.deviceSetup?.overview ?? {})),
      `${lng}: settings.deviceSetup.overview.technicalDetails must be removed (Round 347)`,
    );
    assert.ok(
      !('technicalDetailsHelper' in (j.settings?.deviceSetup?.overview ?? {})),
      `${lng}: settings.deviceSetup.overview.technicalDetailsHelper must be removed (Round 347)`,
    );
    assert.equal(typeof j.modals?.expense?.terminalLabel, 'string', `${lng}: modals.expense.terminalLabel must be preserved`);
    assert.equal(typeof j.modals?.expense?.branchLabel, 'string', `${lng}: modals.expense.branchLabel must be preserved`);
  }
});

// Round 344 (supervisor escalation, live QA): the running Tauri app STILL showed the old "Technical details /
// Recovery point identifier / Terminal / Branch" recovery disclosure even though source, locales, and the
// freshly-built dist were all clean. Root cause: the running app was a pre-fix `tauri build` binary whose
// EMBEDDED frontend predated the raw-ID removal -- rebuilding dist never updates an already-built binary. The
// source/locale guards above can't catch that. This guard inspects the SHIPPED dist bundle (the artifact a
// build embeds): if dist is present it must not contain any obsolete recovery raw-ID UI, and it must carry the
// current calm support note -- so a stale renderer can never be shipped/embedded again unnoticed.
test('Round 344: the shipped dist bundle contains no obsolete recovery raw-ID UI', () => {
  const assetsDir = path.join(process.cwd(), 'dist', 'assets');
  let jsFiles: string[] = [];
  try {
    jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch {
    // dist not built in this environment (e.g. fresh CI before `npm run build`). The source + locale guards
    // above still apply; there is no shipped bundle to inspect, so nothing to assert here.
    return;
  }
  if (jsFiles.length === 0) return;

  // Obsolete recovery raw-ID UI strings that must never appear in a shipped bundle. The Greek "Recovery point
  // ID" label is the strongest live-QA signal; the disclosure marker + EN label + key cover the rest.
  const forbidden = [
    'data-recovery-technical-details',
    '\u0391\u03bd\u03b1\u03b3\u03bd\u03c9\u03c1\u03b9\u03c3\u03c4\u03b9\u03ba\u03cc \u03c3\u03b7\u03bc\u03b5\u03af\u03bf\u03c5 \u03b1\u03bd\u03ac\u03ba\u03c4\u03b7\u03c3\u03b7\u03c2',
    'Recovery point ID',
    'recoveryPointId',
  ];
  let sawSupportNote = false;
  for (const file of jsFiles) {
    const content = readFileSync(path.join(assetsDir, file), 'utf8');
    for (const needle of forbidden) {
      assert.ok(
        !content.includes(needle),
        `dist/assets/${file} still ships obsolete recovery UI ("${needle}") -- rebuild the renderer (npm run build) and the Tauri binary (tauri build) so the embedded frontend is current`,
      );
    }
    if (content.includes('data-recovery-support-note')) sawSupportNote = true;
  }
  assert.ok(
    sawSupportNote,
    'no shipped dist bundle contains the calm support-note marker -- the dist may be stale; rebuild with npm run build',
  );
});

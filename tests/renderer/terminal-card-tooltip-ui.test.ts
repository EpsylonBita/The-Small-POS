import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 172 (touch-first): native DOM `title` tooltips on the terminal card action controls are
// hover behaviour on a touchscreen POS and must be removed; accessible names move to aria-label
// (and role="img" + aria-label for the non-interactive default-star badge). ECR modal `title`
// PROPS (visible headings) are NOT tooltips and must be preserved.

const ecrDir = path.join(process.cwd(), 'src', 'renderer', 'components', 'ecr');
const read = (name: string) => readFileSync(path.join(ecrDir, name), 'utf8');

test('TerminalCard action controls use aria-label and no native title tooltip', () => {
  const source = read('TerminalCard.tsx');

  // No native browser tooltip anywhere on the card.
  assert.doesNotMatch(source, /\btitle=/);

  // Connect/disconnect expose a useful accessible name: the disabled reason when blocked, else the
  // action label. The disabled behaviour itself is unchanged.
  assert.match(source, /aria-label=\{connectionActionsDisabledReason \|\| t\('ecr\.disconnect', 'Disconnect'\)\}/);
  assert.match(source, /aria-label=\{connectionActionsDisabledReason \|\| t\('ecr\.connect', 'Connect'\)\}/);
  assert.match(source, /disabled=\{connectionActionsDisabled\}/);

  // Icon-only edit / set-default / delete controls carry localized aria-labels.
  assert.match(source, /aria-label=\{t\('common\.edit', 'Edit'\)\}/);
  assert.match(source, /aria-label=\{t\('ecr\.setDefault', 'Set as default'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.delete', 'Delete'\)\}/);
});

test('TerminalCardCompact controls + default-star badge use aria-label, no native title tooltip', () => {
  const source = read('TerminalCardCompact.tsx');

  // No native browser tooltip anywhere on the compact card.
  assert.doesNotMatch(source, /\btitle=/);

  // Non-interactive default-star badge: accessible image pattern (role="img" + aria-label), not a
  // hover tooltip.
  assert.match(source, /<span role="img" aria-label=\{t\('ecr\.defaultTerminal', 'Default Terminal'\)\}>/);

  // Icon-only action buttons carry localized aria-labels.
  assert.match(source, /aria-label=\{t\('ecr\.actions\.disconnect', 'Disconnect'\)\}/);
  assert.match(source, /aria-label=\{t\('ecr\.actions\.connect', 'Connect'\)\}/);
  assert.match(source, /aria-label=\{t\('ecr\.actions\.setDefault', 'Set as Default'\)\}/);
  assert.match(source, /aria-label=\{t\('ecr\.actions\.edit', 'Edit'\)\}/);
  assert.match(source, /aria-label=\{t\('ecr\.actions\.delete', 'Delete'\)\}/);
});

test('ECR modal title heading props are preserved (title= not globally forbidden)', () => {
  // These `title` props are visible modal headings, not browser tooltips, and must remain.
  const config = read('TerminalConfigModal.tsx');
  const discovery = read('TerminalDiscoveryModal.tsx');
  assert.match(config, /\btitle=\{/);
  assert.match(discovery, /title=\{t\('ecr\.discovery\.title', 'Discover Payment Terminals'\)\}/);
});

// Round 228 (live QA): the Add/Edit Payment Terminal modal clipped its lower Settings section behind the
// footer at 1282x802, used neutral-grey Cancel + amber Add footer buttons, and kept an old yellow-on ECR
// switch. It now clears the footer (form bottom padding inside the glass scroll content), uses a red Cancel
// + green primary Add/Save, and the round-227 neutral-off / green-on premium glass switch. Behaviour
// (save payload, validation, setters, ids, labels, title prop) is unchanged.
test('Round 228: TerminalConfigModal has red-cancel/green-add footer, a green glass switch, and footer clearance', () => {
  const config = read('TerminalConfigModal.tsx');

  // Footer: the old neutral-grey Cancel + amber Add/Save styling is gone.
  assert.doesNotMatch(config, /bg-amber-500\/20 active:bg-amber-500\/30/);
  assert.doesNotMatch(config, /bg-gray-500\/10 active:bg-gray-500\/20/);

  // Cancel = red semantic; Add/Save = green semantic primary (centered, active feedback, disabled kept).
  assert.match(config, /onClick=\{onClose\}[\s\S]*?bg-red-500\/10 active:bg-red-500\/20[\s\S]*?text-red-600/);
  assert.match(config, /type="submit"[\s\S]*?bg-green-600 active:bg-green-700 text-white[\s\S]*?disabled:opacity-50/);
  assert.match(config, /inline-flex items-center justify-center/);

  // Touch-first: no hover utilities anywhere in the modal.
  assert.doesNotMatch(config, /hover:/);

  // Switch (Round 295): the local peer/pseudo-element switch track is gone; the three switches
  // (print-on-terminal / default / enabled) now render the shared POSGlassSwitch (geometry pinned in
  // settings-modal-ui Round 295). No local class, no peer, no yellow.
  assert.doesNotMatch(config, /SWITCH_TRACK_CLASS/);
  assert.doesNotMatch(config, /sr-only peer/);
  assert.doesNotMatch(config, /peer-checked:/);
  assert.doesNotMatch(config, /from-yellow|to-yellow|shadow-yellow/);
  assert.match(config, /import \{ LiquidGlassModal, POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);
  const ecrSwitches = config.match(/<POSGlassSwitch\b/g) || [];
  assert.ok(ecrSwitches.length >= 3, `expected >=3 shared switches in the config modal, found ${ecrSwitches.length}`);

  // Switch ids + setters preserved (the boolean is passed straight through to setX).
  assert.match(config, /id="printOnTerminal"[\s\S]*?checked=\{printOnTerminal\}[\s\S]*?onChange=\{setPrintOnTerminal\}/);
  assert.match(config, /id="isDefault"[\s\S]*?checked=\{isDefault\}[\s\S]*?onChange=\{setIsDefault\}/);
  assert.match(config, /id="enabled"[\s\S]*?checked=\{enabled\}[\s\S]*?onChange=\{setEnabled\}/);

  // Scroll/padding guard: the form has bottom-padding clearance so the last rows are not hidden under the
  // pinned footer (LiquidGlassModal keeps the footer flex-shrink-0 below the scrollable glass content).
  // Round 294 increased this clearance from pb-6 (too small -- the last label was cut at 1282x802) to pb-28
  // and compacted the stack to space-y-4 so the first field clears the footer on first open.
  assert.match(config, /<form id="terminal-config-form"[\s\S]*?className="space-y-4 pb-28"/);

  // Round 228 correction (live QA): the footer must read as an intentional glass SHELF that masks the
  // scrolling body behind it (so first-open content does not bleed through the translucent footer), not
  // just a bordered strip. Theme-safe neutral glass: semi-opaque white/black bg + backdrop blur + top
  // border + an upward separating shadow. No blue/purple.
  // Round 352: the shelf wrapper holds the glass treatment; the Cancel/Add buttons sit in an inner
  // `flex justify-end gap-3` row (the missing-required hint can render above them when fields are incomplete).
  const footerShelf = config.match(/className="px-8 py-4 border-t[^"]*"/);
  assert.ok(footerShelf, 'footer shelf wrapper not found');
  assert.match(footerShelf[0], /\bborder-t\b/);
  assert.match(footerShelf[0], /bg-white\/85/);
  assert.match(footerShelf[0], /dark:bg-black\/55/);
  assert.match(footerShelf[0], /backdrop-blur-xl/);
  assert.match(footerShelf[0], /shadow-\[0_-8px_24px_/);
  assert.doesNotMatch(footerShelf[0], /blue|purple|hover:/);
  assert.match(config, /<div className="flex justify-end gap-3">/, 'Cancel/Add live in an inner justify-end row');

  // Still the shared glass shell with its visible title heading prop (also covered by the title test above).
  assert.match(config, /<LiquidGlassModal/);
});

// Round 229 (live QA): the payment-terminals refresh icon button was exposed in accessibility as an empty
// unnamed button, and the bottom "Add Terminal" CTA was still yellow. The refresh button is now a 44x44
// centred glass icon button with a localized aria-label (ecr.refreshStatus in all five POS locales), and
// the Add CTA is semantic green (Discover stays neutral/secondary). No title tooltips, no hover; the
// refresh behaviour (handleRefresh) is unchanged.
test('Round 229: PaymentTerminalsSection refresh button is named + 44px, and Add Terminal CTA is green', () => {
  const section = read('PaymentTerminalsSection.tsx');

  // No native title tooltip / hover utilities anywhere in this settings surface.
  assert.doesNotMatch(section, /\btitle=/);
  assert.doesNotMatch(section, /hover:/);

  // Refresh button: sliced precisely via the handleRefresh anchor -- a localized accessible name, 44x44
  // centred glass sizing, preserved handler + spinner icon. No longer an unnamed icon-only button.
  const rIdx = section.indexOf('onClick={handleRefresh}');
  assert.notEqual(rIdx, -1, 'refresh button must wire handleRefresh');
  const refreshBtn = section.slice(section.lastIndexOf('<button', rIdx), section.indexOf('</button>', rIdx) + '</button>'.length);
  assert.match(refreshBtn, /aria-label=\{t\('ecr\.refreshStatus', 'Refresh connection status'\)\}/);
  assert.match(refreshBtn, /h-11 w-11 items-center justify-center/);
  assert.match(refreshBtn, /<RefreshCw/);
  assert.match(refreshBtn, /active:scale-95/);

  // Add Terminal CTA: semantic green (not yellow/amber), centred icon+text, touch-safe min height.
  const aIdx = section.indexOf("t('ecr.addManual'");
  assert.notEqual(aIdx, -1, 'Add Terminal CTA must exist');
  const addBtn = section.slice(section.lastIndexOf('<button', aIdx), section.indexOf('</button>', aIdx) + '</button>'.length);
  assert.match(addBtn, /bg-green-600/);
  assert.match(addBtn, /active:bg-green-700/);
  assert.match(addBtn, /min-h-\[44px\] items-center justify-center/);
  assert.match(addBtn, /<Plus size=\{16\} \/>/);
  assert.doesNotMatch(addBtn, /bg-yellow|border-yellow|bg-amber/);

  // The localized refresh-status accessible name exists in every POS locale (Greek a real translation).
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): any => JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const val = loadLocale(lng).ecr.refreshStatus;
    assert.equal(typeof val, 'string', `${lng} ecr.refreshStatus missing`);
    assert.ok(val.trim().length > 0, `${lng} ecr.refreshStatus empty`);
  }
  assert.notEqual(
    loadLocale('el').ecr.refreshStatus,
    loadLocale('en').ecr.refreshStatus,
    'el ecr.refreshStatus must be a Greek translation, not English',
  );
  assert.match(loadLocale('el').ecr.refreshStatus, new RegExp('[\\u0370-\\u03FF]'), 'el ecr.refreshStatus must be Greek');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const formPath = path.join(projectRoot, 'src', 'renderer', 'components', 'CustomerInfoForm.tsx');

test('CustomerInfoForm uses the shared rounded yellow-focus input recipe', () => {
  const source = readFileSync(formPath, 'utf8');

  assert.match(source, /const inputClass =/);
  assert.match(source, /w-full rounded-2xl border px-3 py-3/);
  assert.match(source, /focus:border-\(--pos-s-yellow\)/);
  assert.match(source, /focus:border-yellow-500/);
  assert.match(source, /focus:ring-\(--pos-s-fg\)/);
  assert.equal((source.match(/className=\{inputClass\}/g) || []).length, 7);
  assert.match(source, /className=\{`\$\{inputClass\} resize-none`\}/);
});

test('CustomerInfoForm order-type and address validation controls are touch-first', () => {
  const source = readFileSync(formPath, 'utf8');

  assert.match(source, /const orderTypeCardClass =/);
  assert.match(source, /rounded-2xl border p-4 text-center backdrop-blur-sm transition-transform/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /border-yellow-400 bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-200/);
  assert.match(source, /border-yellow-500 bg-\(--pos-s-surface-2\) text-yellow-800/);
  assert.match(source, /type="button"[\s\S]*?onClick=\{\(\) => setOrderType\(type\)\}[\s\S]*?className=\{orderTypeCardClass\(type\)\}/);
  assert.match(source, /type="button"[\s\S]*?onClick=\{handleValidateAddress\}[\s\S]*?rounded-2xl px-4 py-3/);
  assert.match(source, /bg-yellow-400 text-black active:bg-yellow-500/);
});

test('CustomerInfoForm keeps the requested order icons and has no legacy hover or blue chrome', () => {
  const source = readFileSync(formPath, 'utf8');

  assert.match(source, /import TableOrderIcon from "\.\/icons\/TableOrderIcon"/);
  // Founder 31/10 («Ναι, παντού»): delivery and pickup are his scooter rider and hand-held bag.
  assert.match(source, /import \{ DeliveryScooterIcon, PickupHandBagIcon \} from "\.\/icons\/OrderTypeGlyphs"/);
  assert.match(source, /<TableOrderIcon className="w-6 h-6" \/>/);
  assert.match(source, /<PickupHandBagIcon className="h-7 w-7" \/>/);
  assert.match(source, /<DeliveryScooterIcon className="h-7 w-7" \/>/);
  assert.doesNotMatch(source, /Package|Utensils/);
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});

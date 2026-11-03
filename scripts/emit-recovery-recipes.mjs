import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

export function catalogue() {
  const body = read('src/renderer/components/recovery/sync-recovery-issues.ts')
    .split('export const RECOVERY_RECIPES = {')[1]?.split('} as const satisfies')[0];
  if (!body) { throw new Error('Recovery recipe source changed'); }
  const pattern = /recipeId: '([^']+)',\s+version: (\d+),\s+actionId: '([^']+)',\s+labelKey: '([^']+)',\s+explanationKey: '([^']+)',\s+verificationKey: '([^']+)',\s+requiresSnapshot: (true|false)/g;
  const recipes = [...body.matchAll(pattern)].map(([, id, version, action, title, explanation, verification, snapshot]) => ({
    id, version: Number(version), source: 'recipe', action_id: action,
    title_key: title, explanation_key: explanation, verification_key: verification,
    mutates_data: action !== 'openOrderPaymentFix', needs_onsite: action !== 'openOrderPaymentFix',
    needs_staff_pin: action !== 'openOrderPaymentFix', requires_snapshot: snapshot === 'true',
    snapshot_level: snapshot === 'true' ? 'full' : 'none',
    attempt_cap: Number.MAX_SAFE_INTEGER, cooldown_ms: 0,
  }));
  if (recipes.length !== 11) { throw new Error('Review new or changed renderer recipes'); }
  const printerRecipe = recipes.find(recipe => recipe.id === 'printer.restore_last_known_brand');
  if (!printerRecipe) { throw new Error('Missing printer recipe'); }
  Object.assign(printerRecipe, { needs_staff_pin: false, attempt_cap: 3, cooldown_ms: 300_000 });
  const native = read('src-tauri/src/sync_queue.rs');
  const capture = name => {
    const value = native.match(new RegExp(`const ${name}:[^=]+=[ \n]*([^;]+);`))?.[1];
    if (!value) { throw new Error(`Missing native recipe ${name}`); }
    return value.trim();
  };
  const factors = capture('CUSTOMER_ADDRESS_DEFAULT_RECOVERY_COOLDOWN_SECS').split('*').map(value => Number(value.trim()));
  if (factors.some(value => !Number.isSafeInteger(value) || value < 1)) { throw new Error('Review native cooldown expression'); }
  recipes.push({
    id: JSON.parse(capture('CUSTOMER_ADDRESS_DEFAULT_RECOVERY_RECIPE_ID')),
    version: Number(capture('CUSTOMER_ADDRESS_DEFAULT_RECOVERY_RECIPE_VERSION')), source: 'recipe',
    action_id: 'nativeCustomerAddressDefaultRetry',
    title_key: 'recovery.recipes.customerAddressDefaultConflictRepair.label',
    explanation_key: 'recovery.recipes.customerAddressDefaultConflictRepair.explanation',
    verification_key: 'recovery.recipes.customerAddressDefaultConflictRepair.verification',
    mutates_data: true, needs_onsite: true, needs_staff_pin: true, requires_snapshot: true, snapshot_level: 'metadata',
    attempt_cap: Number(capture('CUSTOMER_ADDRESS_DEFAULT_RECOVERY_MAX_PROBES')),
    cooldown_ms: factors.reduce((seconds, value) => seconds * value, 1) * 1000,
  });
  const actions = read('src/renderer/services/support/SupportMatcherBridge.ts')
    .split('export const SUPPORT_HEALTH_ACTIONS = [')[1]?.split('] as const;')[0];
  if (!actions) { throw new Error('Health action source changed'); }
  const actionPattern = /id: '([^']+)', actionId: '([^']+)', titleKey: '([^']+)', explanationKey: '([^']+)'/g;
  const manual = [...actions.matchAll(actionPattern)];
  if (manual.length !== 3 || manual.some(([, id]) => id === 'reconnect')) { throw new Error('Review changed remote Health actions'); }
  for (const [, id, action, title, explanation] of manual) {
    recipes.push({ id, version: 1, source: 'health_action', action_id: action,
      title_key: title, explanation_key: explanation, verification_key: '',
      mutates_data: true, needs_onsite: true, needs_staff_pin: true, requires_snapshot: false, snapshot_level: 'none',
      attempt_cap: Number.MAX_SAFE_INTEGER, cooldown_ms: 0 });
  }
  return { version: 1, recipes };
}

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) { throw new Error('Missing output path'); }
const target = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(root, 'src-tauri/generated/recovery-recipes.json');
const emitted = `${JSON.stringify(catalogue(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== emitted) { throw new Error('recovery-recipes.json drift'); }
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, emitted);
}

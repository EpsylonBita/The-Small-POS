import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'utils', 'fiscal-integration-entitlement.ts'),
  'utf8',
);

test('fiscal entitlement is limited to purchased order-reporting plugins', () => {
  assert.match(source, /new Set\(\['mydata'\]\)/);
  assert.match(source, /pluginId\.startsWith\('fiscalization_'\)/);
  assert.match(source, /row\.is_purchased === true/);
  assert.match(source, /row\.is_enabled !== false/);
  assert.doesNotMatch(source, /ergani_digital_schedule/);
  assert.doesNotMatch(source, /row\.is_active === true/);
});

test('fiscal entitlement fails closed when POS integrations cannot be loaded', () => {
  assert.match(source, /posApiGet<\{ integrations\?: PosIntegrationEntitlementPayload\[\] \}>\('\/pos\/integrations'\)/);
  assert.match(source, /if \(!response\.success\) \{\s*return false;\s*\}/);
});

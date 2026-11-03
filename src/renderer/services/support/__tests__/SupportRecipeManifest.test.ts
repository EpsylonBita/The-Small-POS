// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHIPPED_RECIPE_MANIFEST_ENTRIES } from '../../../../../../shared/pos/support/recipe-manifest.entries';
import { RECOVERY_RECIPES } from '../../../components/recovery/sync-recovery-issues';

const read = (file: string) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8');
interface GeneratedRecipe {
  id: string; version: number; attempt_cap: number; cooldown_ms: number; requires_snapshot: boolean; snapshot_level: 'none' | 'metadata' | 'full';
}
const generated: { recipes: GeneratedRecipe[] } = JSON.parse(read('src-tauri/generated/recovery-recipes.json'));
const manifest = SHIPPED_RECIPE_MANIFEST_ENTRIES.filter(entry => entry.platforms.includes('windows'));

describe('desktop shipped recipe contract', () => {
  it('pins every generated identity, version, budget and snapshot level to the shared manifest', () => {
    expect(generated.recipes.map(entry => entry.id).sort()).toEqual(manifest.map(entry => entry.id).sort());
    for (const entry of generated.recipes) {
      const shared = manifest.find(recipe => recipe.id === entry.id);
      expect(shared).toMatchObject({ version: entry.version, attempt_cap: entry.attempt_cap, cooldown_ms: entry.cooldown_ms,
        snapshot_level: entry.snapshot_level });
    }
  });
  it('uses the same exact matcher codes as Android when fingerprinting the shipped Windows observations', () => {
    const codes = read('src-tauri/src/incident_reporting/recipe_telemetry.rs').split('const RECIPE_ISSUES:')[1]?.split('];')[0] ?? '';
    const pairs = [...codes.matchAll(/\(\s*"([^"]+)",\s*"([^"]+)"\s*,?\s*\)/g)].map(match => [match[1], match[2]]);
    expect(pairs).toHaveLength(manifest.length);
    const byRecipe = new Map(pairs.map(([id, code]) => [id, code]));
    for (const entry of manifest) { expect([byRecipe.get(entry.id)]).toEqual(entry.matchers.windows?.issue_codes); }
  });
  it('pins renderer recipes and the native automatic recipe without changing legacy matchers', () => {
    for (const recipe of Object.values(RECOVERY_RECIPES)) {
      const shared = manifest.find(entry => entry.id === recipe.recipeId);
      expect(shared).toMatchObject({ version: recipe.version, snapshot_level: recipe.requiresSnapshot ? 'full' : 'none' });
      const budget = { cooldownMs: 0, attemptCap: Number.MAX_SAFE_INTEGER, ...recipe };
      expect(shared?.cooldown_ms).toBe(budget.cooldownMs ?? 0);
      expect(shared?.attempt_cap).toBe(budget.attemptCap ?? Number.MAX_SAFE_INTEGER);
    }
    const native = read('src-tauri/src/sync_queue.rs');
    expect(native).toContain('const CUSTOMER_ADDRESS_DEFAULT_RECOVERY_RECIPE_ID: &str = "customer-address-default.retry"');
    expect(native).toMatch(/CUSTOMER_ADDRESS_DEFAULT_RECOVERY_RECIPE_VERSION: [^=]+ = 1;/);
    expect(native).toMatch(/CUSTOMER_ADDRESS_DEFAULT_RECOVERY_MAX_PROBES: [^=]+ = 3;/);
    expect(native).toMatch(/CUSTOMER_ADDRESS_DEFAULT_RECOVERY_COOLDOWN_SECS: [^=]+ = 5 \* 60;/);
    expect(manifest.find(entry => entry.id === 'customer-address-default.retry')).toMatchObject({ version: 1, attempt_cap: 3,
      cooldown_ms: 300_000, snapshot_level: 'metadata' });
    expect(native).toContain('"snapshotKind": "retry_bookkeeping"');
  });
  it('ships the desktop-only incident template with exact observation codes and provenance', () => {
    expect(manifest.find(entry => entry.id === 'printer.restore_last_known_brand')).toMatchObject({ mode: 'one_tap', platforms: ['windows'],
      source_incidents: ['incident-template:2026-10-31:tomikro-star-mc-print3', 'commit:2a057bfa7'],
      matchers: { windows: { issue_codes: ['printer.brand_probe_unanswered'], structured_fields: { status: 'no_answer' } } },
      attempt_cap: 3, cooldown_ms: 300_000, snapshot_level: 'full' });
    const owner = read('src-tauri/src/printers/restore_brand.rs');
    expect(owner).toContain('const RECIPE_ID: &str = "printer.restore_last_known_brand"');
    expect(owner).toContain('const RECIPE_VERSION: u32 = 1;');
    expect(owner).toContain('const COOLDOWN_MS: i64 = 300_000;');
    expect(owner).toContain('const ATTEMPT_CAP: u64 = 3;');
    expect(owner).toContain('VACUUM INTO ?1');
  });
});

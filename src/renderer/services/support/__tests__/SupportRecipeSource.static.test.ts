// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps recipe logic in shipped sources, never server or incident scripts', () => {
  const read = (file: string) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8');
  for (const file of ['src/renderer/components/recovery/sync-recovery-issues.ts', 'src-tauri/src/printers/restore_brand.rs',
    'src/renderer/services/support/SupportRemedyRunner.ts', 'src-tauri/src/support/remedies.rs', 'src-tauri/src/sync_queue.rs']) {
    const raw = read(file);
    const source = file.endsWith('sync_queue.rs')
      ? raw.slice(raw.indexOf('fn customer_address_default_recovery_guard_key'), raw.indexOf('/// True when an admin replay failed')) : raw.split('#[cfg(test)]')[0];
    expect(source.length).toBeGreaterThan(100);
    expect(source, file).not.toMatch(/\beval\s*\(|new Function\s*\(|Command::new|child_process|\.execute(?:_batch)?\s*\(\s*(?:request|incident|payload|input)\b/);
    expect(source, file).not.toMatch(/(?:fetch|admin_fetch|axios|import)\s*\([^\n]*(?:recipe|matcher|\.sql|script)/);
    expect(source, file).not.toMatch(/(?:request|incident|payload|input)\s*(?:\[\s*['"](?:sql|command|matcher)['"]\s*\]|\.(?:sql|command|matcher)\b)/);
  }
});

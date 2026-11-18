#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'node_modules', '.cache', 'support-tests');
const outFile = path.join(outDir, 'support-layer.test.mjs');

await fs.mkdir(outDir, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, 'tests', 'support', 'support-layer.test.tsx')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'silent',
  external: ['node:test', 'node:assert/strict'],
});

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', outFile], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`Support tests failed with exit code ${code}`));
  });

  child.on('error', reject);
});

// Incident 17/11/2026: order notices and guided correction recovery are part
// of the blocking support check, including every shipped translation.
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    'src/renderer/components/recovery/__tests__/OrderSyncNotice.test.tsx',
    'src/renderer/components/recovery/__tests__/OrderNoticeHost.test.tsx',
    'src/renderer/components/order/__tests__/OrderCard.notice.test.tsx',
    'src/renderer/services/__tests__/OrderSyncNoticeStore.test.ts',
    'src/renderer/services/support/__tests__/OrderNoticeCopy.test.ts'], { cwd: projectRoot, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Order notice regression tests failed: ${code}`)));
});

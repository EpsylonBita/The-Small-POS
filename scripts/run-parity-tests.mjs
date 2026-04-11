#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(projectRoot, 'tests');
const outDir = path.join(projectRoot, 'node_modules', '.cache', 'parity-tests');

const entryPoints = [
  path.join(testsRoot, 'services', 'RealtimeManager.test.ts'),
  path.join(testsRoot, 'services', 'SyncQueueBridge.test.ts'),
  path.join(testsRoot, 'services', 'ParitySyncCoordinator.test.ts'),
  path.join(testsRoot, 'services', 'offline-page-capabilities.test.ts'),
  path.join(testsRoot, 'services', 'VerticalOfflineFlows.test.ts'),
  path.join(testsRoot, 'pages', 'SettingsPage.test.tsx'),
];

await fs.mkdir(outDir, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints,
  outdir: outDir,
  outbase: testsRoot,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'silent',
  external: ['node:test', 'node:assert/strict'],
});

const outFiles = entryPoints.map((entryPoint) =>
  path.join(
    outDir,
    path.relative(testsRoot, entryPoint).replace(/\.(ts|tsx)$/, '.js'),
  ),
);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', ...outFiles], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`Parity tests failed with exit code ${code}`));
  });

  child.on('error', reject);
});

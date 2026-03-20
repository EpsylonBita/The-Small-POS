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

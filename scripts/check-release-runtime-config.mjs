#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workflowPath = path.resolve(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'pos-tauri-auto-release.yml',
);

// The public POS source mirror intentionally does not contain the private
// monorepo release workflow. Enforce this contract whenever the workflow is
// present (local monorepo and CI release builds).
if (!fs.existsSync(workflowPath)) {
  console.log('POS release runtime config contract skipped: release workflow is not present.');
  process.exit(0);
}

const workflow = fs.readFileSync(workflowPath, 'utf8');
const buildStepMarker = '      - name: Build NSIS bundle';
const buildStepStart = workflow.indexOf(buildStepMarker);
const nextStepStart = workflow.indexOf('\n      - name:', buildStepStart + buildStepMarker.length);

if (buildStepStart < 0) {
  console.error('POS release runtime config contract failed: Build NSIS bundle step is missing.');
  process.exit(1);
}

const buildStep = workflow.slice(
  buildStepStart,
  nextStepStart < 0 ? workflow.length : nextStepStart,
);

const requiredTokens = [
  'VITE_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}',
  'VITE_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}',
  'Missing required secret: NEXT_PUBLIC_SUPABASE_URL',
  'Missing required secret: NEXT_PUBLIC_SUPABASE_ANON_KEY',
];
const violations = requiredTokens
  .filter((token) => !buildStep.includes(token))
  .map((token) => `missing ${token}`);

if (buildStep.includes('SUPABASE_SERVICE_ROLE_KEY')) {
  violations.push('service-role credentials must never be injected into the renderer build');
}

if (violations.length > 0) {
  console.error('POS release runtime config contract failed.');
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log('POS release runtime config contract passed.');

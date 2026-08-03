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
const verificationStepMarker = '      - name: Verify POS Tauri contracts and runtime';
const verificationStepStart = workflow.indexOf(verificationStepMarker);
const verificationNextStepStart = workflow.indexOf(
  '\n      - name:',
  verificationStepStart + verificationStepMarker.length,
);
const buildStepMarker = '      - name: Build NSIS bundle';
const buildStepStart = workflow.indexOf(buildStepMarker);
const nextStepStart = workflow.indexOf('\n      - name:', buildStepStart + buildStepMarker.length);
const concurrencyStart = workflow.indexOf('\nconcurrency:');
const envStart = workflow.indexOf('\nenv:');
const staleGuardMarker = '      - name: Refuse stale POS publication';
const staleGuardStart = workflow.indexOf(staleGuardMarker);
const syncStepStart = workflow.indexOf('      - name: Sync pos-tauri source to public repo');

if (buildStepStart < 0) {
  console.error('POS release runtime config contract failed: Build NSIS bundle step is missing.');
  process.exit(1);
}

if (verificationStepStart < 0) {
  console.error('POS release runtime config contract failed: verification step is missing.');
  process.exit(1);
}

if (concurrencyStart < 0 || envStart < concurrencyStart) {
  console.error('POS release runtime config contract failed: release concurrency policy is missing.');
  process.exit(1);
}

if (staleGuardStart < 0 || syncStepStart < staleGuardStart) {
  console.error('POS release runtime config contract failed: stale-publication guard is missing before public sync.');
  process.exit(1);
}

const verificationStep = workflow.slice(
  verificationStepStart,
  verificationNextStepStart < 0 ? workflow.length : verificationNextStepStart,
);

const buildStep = workflow.slice(
  buildStepStart,
  nextStepStart < 0 ? workflow.length : nextStepStart,
);

const concurrencyBlock = workflow.slice(concurrencyStart, envStart);
const staleGuardNextStepStart = workflow.indexOf(
  '\n      - name:',
  staleGuardStart + staleGuardMarker.length,
);
const staleGuardStep = workflow.slice(
  staleGuardStart,
  staleGuardNextStepStart < 0 ? workflow.length : staleGuardNextStepStart,
);
const staleGuardRunStart = staleGuardStep.indexOf('\n        run: |');
const staleGuardRun =
  staleGuardRunStart < 0 ? '' : staleGuardStep.slice(staleGuardRunStart);

const requiredTokens = [
  'VITE_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}',
  'VITE_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}',
  'Missing required secret: NEXT_PUBLIC_SUPABASE_URL',
  'Missing required secret: NEXT_PUBLIC_SUPABASE_ANON_KEY',
];
const violations = requiredTokens
  .filter((token) => !buildStep.includes(token))
  .map((token) => `missing ${token}`);

if (!verificationStep.includes('npm run test:unit')) {
  violations.push('release verification must run the POS unit regression suite');
}

if (buildStep.includes('SUPABASE_SERVICE_ROLE_KEY')) {
  violations.push('service-role credentials must never be injected into the renderer build');
}

if (!concurrencyBlock.includes('group: pos-tauri-public-release')) {
  violations.push('all POS release refs must share one public-release concurrency group');
}

if (!concurrencyBlock.includes('cancel-in-progress: true')) {
  violations.push('a newer POS release must cancel an older in-progress release');
}

for (const token of [
  'SOURCE_REF: ${{ github.ref_name }}',
  'SOURCE_SHA: ${{ github.sha }}',
  'git fetch origin "$env:SOURCE_REF"',
  '$releaseSha = "$env:SOURCE_SHA"',
  '$remoteRef = "origin/$env:SOURCE_REF"',
  'git merge-base --is-ancestor',
  'git diff --quiet',
  'pos-tauri',
  'branding/pos-desktop',
  '.github/workflows/pos-tauri-auto-release.yml',
]) {
  if (!staleGuardStep.includes(token)) {
    violations.push(`stale-publication guard is missing ${token}`);
  }
}

if (staleGuardRun.includes('${{ github.')) {
  violations.push('stale-publication run script must not interpolate untrusted github context directly');
}

if (violations.length > 0) {
  console.error('POS release runtime config contract failed.');
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log('POS release runtime config contract passed.');

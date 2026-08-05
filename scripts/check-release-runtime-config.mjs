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
const repositoryRoot = path.resolve(__dirname, '..', '..');
const callerIdPinsPath = path.join(
  repositoryRoot,
  'pos-tauri',
  'config',
  'caller-id-offline-lease-verifier.properties',
);
const tauriBuildScriptPath = path.join(
  repositoryRoot,
  'pos-tauri',
  'src-tauri',
  'build.rs',
);
const androidBuildScriptPath = path.join(
  repositoryRoot,
  'POSSystemMobile',
  'android',
  'app',
  'build.gradle',
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
const callerIdPinsMarker = '      - name: Validate Caller ID offline lease build pins';
const callerIdPinsStart = workflow.indexOf(callerIdPinsMarker);

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

if (callerIdPinsStart < 0 || callerIdPinsStart > buildStepStart) {
  console.error('POS release runtime config contract failed: Caller ID build-pin validation is missing before packaging.');
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
const callerIdPinsNextStepStart = workflow.indexOf(
  '\n      - name:',
  callerIdPinsStart + callerIdPinsMarker.length,
);
const callerIdPinsStep = workflow.slice(
  callerIdPinsStart,
  callerIdPinsNextStepStart < 0 ? workflow.length : callerIdPinsNextStepStart,
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

const publicMirrorRoot = path.join(repositoryRoot, 'pos-tauri');
const callerIdPinsMirrorPath = path.relative(publicMirrorRoot, callerIdPinsPath);
if (callerIdPinsMirrorPath.startsWith('..') || path.isAbsolute(callerIdPinsMirrorPath)) {
  violations.push('Caller ID verifier pins must remain inside the public POS mirror root');
}

if (!fs.existsSync(callerIdPinsPath)) {
  violations.push('shared Caller ID verifier pins are missing for dev/debug builds');
} else {
  const sharedPins = Object.fromEntries(
    fs.readFileSync(callerIdPinsPath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 1
          ? [line, '']
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (!/^[A-Za-z0-9_-]{43}$/u.test(sharedPins.CALLER_ID_OFFLINE_LEASE_PUBLIC_KEY ?? '')) {
    violations.push('shared Caller ID dev public key must be canonical 32-byte base64url');
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(sharedPins.CALLER_ID_OFFLINE_LEASE_KEY_ID ?? '')) {
    violations.push('shared Caller ID dev key ID is invalid');
  }
}

const tauriBuildScript = fs.readFileSync(tauriBuildScriptPath, 'utf8');
for (const token of [
  'include_str!("../config/caller-id-offline-lease-verifier.properties")',
  'cargo:rustc-env={PUBLIC_KEY_ENV}',
  'cargo:rustc-env={KEY_ID_ENV}',
]) {
  if (!tauriBuildScript.includes(token)) {
    violations.push(`Tauri dev verifier fallback is missing ${token}`);
  }
}

const androidBuildScript = fs.readFileSync(androidBuildScriptPath, 'utf8');
for (const token of [
  'caller-id-offline-lease-verifier.properties',
  'callerIdOfflineLeasePublicKeyEnv',
  'callerIdOfflineLeaseKeyIdEnv',
  'callerIdOfflineLeasePublicKeyEnv ?: callerIdDevPins',
  'callerIdOfflineLeaseKeyIdEnv ?: callerIdDevPins',
]) {
  if (!androidBuildScript.includes(token)) {
    violations.push(`Android debug verifier fallback is missing ${token}`);
  }
}

if (!verificationStep.includes('npm run test:unit')) {
  violations.push('release verification must run the POS unit regression suite');
}

if (buildStep.includes('SUPABASE_SERVICE_ROLE_KEY')) {
  violations.push('service-role credentials must never be injected into the renderer build');
}

for (const token of [
  'CALLER_ID_OFFLINE_LEASE_PUBLIC_KEY',
  'CALLER_ID_OFFLINE_LEASE_KEY_ID',
  '[Convert]::FromBase64String',
  '[Convert]::ToBase64String',
  '$canonicalPublicKey -cne $publicKey',
]) {
  if (!callerIdPinsStep.includes(token)) {
    violations.push(`Caller ID build-pin validation is missing ${token}`);
  }
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

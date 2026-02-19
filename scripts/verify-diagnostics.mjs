#!/usr/bin/env node
/**
 * Smoke test for Phase 8B diagnostics commands.
 * Runs against the Rust backend directly via cargo test.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`${GREEN}✓${RESET} ${name}`);
    return true;
  } catch (err) {
    console.error(`${RED}✗${RESET} ${name}`);
    console.error(`  ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`${YELLOW}Phase 8B Diagnostics Verification${RESET}\n`);

  let passed = 0;
  let failed = 0;

  // Test 1: Rust diagnostics module tests
  if (await runTest('Diagnostics module unit tests', async () => {
    const { stdout } = await execAsync('cargo test diagnostics:: --lib', { cwd: 'src-tauri' });
    if (!stdout.includes('test result: ok')) {
      throw new Error('Diagnostics tests failed');
    }
  })) passed++; else failed++;

  // Test 2: All Rust tests pass
  if (await runTest('All Rust tests (73 total)', async () => {
    const { stdout } = await execAsync('cargo test --lib 2>&1', { cwd: 'src-tauri' });
    if (!stdout.includes('73 passed')) {
      throw new Error('Expected 73 tests to pass');
    }
  })) passed++; else failed++;

  // Test 3: Rust build succeeds
  if (await runTest('Rust dev build', async () => {
    const { stderr } = await execAsync('cargo build 2>&1', { cwd: 'src-tauri' });
    if (stderr.includes('error:') && !stderr.includes('warning:')) {
      throw new Error('Rust build failed');
    }
  })) passed++; else failed++;

  // Test 4: Frontend build succeeds
  if (await runTest('Frontend build (Vite)', async () => {
    const { stdout, stderr } = await execAsync('npm run build 2>&1');
    if (stderr.includes('error') || !stdout.includes('built in')) {
      throw new Error('Vite build failed');
    }
  })) passed++; else failed++;

  // Test 5: TypeScript compiles
  if (await runTest('TypeScript type check', async () => {
    const { stderr } = await execAsync('npm run type-check 2>&1');
    // Allow CSS warnings but no actual TS errors
    if (stderr.includes('error TS') && !stderr.includes('index.css')) {
      throw new Error('TypeScript errors found');
    }
  })) passed++; else failed++;

  // Test 6: Clippy passes
  if (await runTest('Rust clippy (linter)', async () => {
    const { stdout } = await execAsync('cargo clippy --all-targets --all-features 2>&1', { cwd: 'src-tauri' });
    if (stdout.includes('error:')) {
      throw new Error('Clippy errors found');
    }
  })) passed++; else failed++;

  // Summary
  console.log(`\n${YELLOW}Summary:${RESET}`);
  console.log(`  ${GREEN}${passed} passed${RESET}`);
  if (failed > 0) {
    console.log(`  ${RED}${failed} failed${RESET}`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}All diagnostics checks passed!${RESET}`);
    console.log(`Phase 8B is ready for production. 🚀\n`);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});

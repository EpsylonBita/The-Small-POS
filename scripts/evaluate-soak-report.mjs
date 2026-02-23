#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const defaultReportPath = path.join(
  rootDir,
  'docs',
  'security-native-migration',
  'reports',
  'staging-soak-report.json'
);

function getReportPathArg() {
  const idx = process.argv.indexOf('--report');
  if (idx === -1) return defaultReportPath;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) {
    console.error('Missing value for --report <path>');
    process.exit(1);
  }
  return path.resolve(process.cwd(), value);
}

function computeSummaryStatus({ failed, skipped }) {
  if (failed > 0) return 'FAIL';
  if (skipped > 0) return 'INCOMPLETE';
  return 'PASS';
}

function main() {
  const reportPath = getReportPathArg();
  if (!fs.existsSync(reportPath)) {
    console.error(`Soak report not found: ${reportPath}`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(`Invalid JSON in soak report: ${reportPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!Array.isArray(report.results)) {
    console.error('Invalid soak report: "results" must be an array.');
    process.exit(1);
  }

  const results = report.results;
  const passed = results.filter((r) => r?.result === 'PASS').length;
  const failed = results.filter((r) => r?.result === 'FAIL').length;
  const skipped = results.filter((r) => r?.result === 'SKIP').length;

  const critical = results.filter((r) => Boolean(r?.critical));
  const criticalFailed = critical.filter((r) => r?.result === 'FAIL');
  const criticalSkipped = critical.filter((r) => r?.result === 'SKIP');
  const status = computeSummaryStatus({ failed, skipped });

  console.log('\n=== Staging Soak Report Evaluation ===\n');
  console.log(`Report: ${reportPath}`);
  console.log(`Total gates: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Critical failed: ${criticalFailed.length}`);
  console.log(`Critical skipped: ${criticalSkipped.length}`);
  console.log(`Computed status: ${status}`);

  if (criticalFailed.length > 0) {
    console.log('\nCritical failures:');
    for (const gate of criticalFailed) {
      console.log(` - ${gate.id}: ${gate.name}`);
    }
  }

  if (criticalSkipped.length > 0) {
    console.log('\nCritical skipped gates:');
    for (const gate of criticalSkipped) {
      console.log(` - ${gate.id}: ${gate.name}`);
    }
  }

  const declaredStatus = report?.summary?.status;
  if (declaredStatus && declaredStatus !== status) {
    console.log(`\nWarning: declared summary status "${declaredStatus}" differs from computed "${status}".`);
  }

  if (status !== 'PASS' || criticalFailed.length > 0 || criticalSkipped.length > 0) {
    console.log('\nSoak gate is NOT approved.');
    process.exit(1);
  }

  console.log('\nSoak gate approved.');
}

main();

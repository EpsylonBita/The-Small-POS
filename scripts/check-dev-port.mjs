#!/usr/bin/env node

import { execSync } from 'node:child_process';

const PORT = 1420;

function run(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? '';
    return stdout.trim();
  }
}

function getWindowsListeners(port) {
  const netstat = run('netstat -ano -p tcp');
  if (!netstat) return [];

  const lines = netstat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(`:${port}`) && /LISTENING/i.test(line));

  const pids = [...new Set(lines
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts[parts.length - 1];
    })
    .filter((pid) => /^\d+$/.test(pid)))];

  return pids.map((pid) => {
    const tasklist = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    let processName = 'unknown';
    if (tasklist && !/No tasks are running/i.test(tasklist)) {
      const match = tasklist.match(/^"([^"]+)"/m);
      if (match?.[1]) processName = match[1];
    }
    return { pid, processName };
  });
}

function getUnixListeners(port) {
  const lsofOutput = run(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  if (!lsofOutput) return [];

  return lsofOutput
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        processName: parts[0] || 'unknown',
        pid: parts[1] || '?',
      };
    });
}

const listeners = process.platform === 'win32'
  ? getWindowsListeners(PORT)
  : getUnixListeners(PORT);

if (listeners.length === 0) {
  console.log(`[dev-precheck] Port ${PORT} is available.`);
  process.exit(0);
}

console.error(`[dev-precheck] Port ${PORT} is already in use.`);
for (const listener of listeners) {
  console.error(`  - PID ${listener.pid} (${listener.processName})`);
}

if (process.platform === 'win32') {
  console.error('\nResolve manually, then rerun `npm run pos:tauri:dev`.');
  console.error('PowerShell examples:');
  console.error(`  Get-NetTCPConnection -LocalPort ${PORT} | Format-Table -AutoSize`);
  console.error('  Get-Process -Id <PID> | Stop-Process -Force');
} else {
  console.error('\nResolve manually, then rerun `npm run pos:tauri:dev`.');
  console.error('Shell examples:');
  console.error(`  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  console.error('  kill <PID>');
}

process.exit(1);

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Optional legacy invoke channels still referenced behind UI/runtime fallbacks.
// Keep these visible in reports, but do not fail the parity gate on them.
const OPTIONAL_LEGACY_RENDERER_CHANNELS = new Set([
  'diagnostic:check-delivered-orders',
  'diagnostic:fix-missing-driver-ids',
  'report:get-hourly-sales',
  'report:get-order-type-breakdown',
  'report:get-payment-method-breakdown',
  'report:print-z-report',
  'shift:print-checkout',
]);

function readFile(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
      continue;
    }
    if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function parseObjectMap(body) {
  const map = new Map();
  for (const m of body.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

function parseChannelMap() {
  const adapter = readFile('src/lib/ipc-adapter.ts');
  const match = adapter.match(/export const CHANNEL_MAP[\s\S]*?=\s*{([\s\S]*?)^\};/m);
  if (!match) throw new Error('Failed to parse CHANNEL_MAP from src/lib/ipc-adapter.ts');
  return parseObjectMap(match[1]);
}

function parseCommandOverrides() {
  const adapter = readFile('src/lib/ipc-adapter.ts');
  const match = adapter.match(/COMMAND_OVERRIDES[\s\S]*?=\s*{([\s\S]*?)^\s*};/m);
  if (!match) {
    return new Map();
  }
  return parseObjectMap(match[1]);
}

function parseEventMap() {
  const bridge = readFile('src/lib/event-bridge.ts');
  const match = bridge.match(/const EVENT_MAP[\s\S]*?=\s*{([\s\S]*?)^\};/m);
  if (!match) throw new Error('Failed to parse EVENT_MAP from src/lib/event-bridge.ts');
  return parseObjectMap(match[1]);
}

function parseRustRegisteredCommands() {
  const lib = readFile('src-tauri/src/lib.rs');
  const match = lib.match(/generate_handler!\[([\s\S]*?)\]\)/m);
  if (!match) throw new Error('Failed to parse generate_handler! from src-tauri/src/lib.rs');
  const cleaned = match[1]
    .replace(/\/\/.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const commands = new Set();
  for (const token of cleaned.split(',')) {
    const name = token.trim().replace(/\s+/g, '');
    if (!name) continue;
    const fnName = name.split('::').pop();
    if (fnName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fnName)) {
      commands.add(fnName);
    }
  }
  return commands;
}

function parseRustCommandDefinitions() {
  const defs = new Set();
  const rustRoot = path.join(rootDir, 'src-tauri', 'src');
  const files = walk(rustRoot, ['.rs']);

  // Accept both async and sync command signatures, but only when the function
  // immediately follows a real line-level attribute. A cross-file `\s\S*?`
  // scan also matched `#[tauri::command]` text in comments/include_str audit
  // helpers and then mislabeled the next ordinary or test function as IPC.
  const regex = /^[ \t]*#\[tauri::command(?:\([^\r\n]*\))?\][ \t]*\r?\n[ \t]*(?:(?:pub(?:\s*\([^\r\n)]*\))?)\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(regex)) {
      defs.add(m[1]);
    }
  }
  return defs;
}

function parseRendererInvokedChannels() {
  const rendererRoot = path.join(rootDir, 'src', 'renderer');
  const files = walk(rendererRoot, ['.ts', '.tsx']);
  const channels = new Set();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const regex = /invoke\s*\(\s*['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(regex)) {
      channels.add(m[1]);
    }
  }
  return channels;
}

// Event names are commonly held in a `const` so the emit site, the workers that
// reuse it, and the tests asserting on it cannot drift apart (the capture
// workers do this). Collect those constants so such an emit resolves to the
// same name a literal one would.
function parseRustStrConstants(files) {
  const constants = new Map();
  const regex = /\bconst\s+([A-Z_][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"\s*;/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(regex)) {
      constants.set(m[1], m[2]);
    }
  }
  return constants;
}

function parseRustEmittedEvents() {
  const rustRoot = path.join(rootDir, 'src-tauri', 'src');
  const files = walk(rustRoot, ['.rs']);
  const constants = parseRustStrConstants(files);
  const events = new Set();
  // Either a string literal or an identifier resolved through the constant
  // table above. Declaring a constant is deliberately NOT enough: the name only
  // counts as emitted when it is passed to an actual `emit(` call, so this
  // stays as strict as the literal-only form it replaces.
  // TerminalEventSink deliberately abstracts Tauri's `emit` behind
  // `emit_json` so auth-reset behavior can be exercised without an AppHandle.
  // Both calls are real runtime emission sites and must satisfy event parity.
  const regex = /\bemit(?:_json)?\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*))/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(regex)) {
      if (m[1] !== undefined) {
        events.add(m[1]);
        continue;
      }
      // `module::EVENT_NAME` resolves on its final path segment.
      const value = constants.get(m[2].split('::').pop());
      if (value !== undefined) {
        events.add(value);
      }
    }
  }
  return events;
}

function toRustCommand(channel, commandOverrides) {
  return commandOverrides.get(channel) || channel.replace(/[:\-]/g, '_');
}

function printList(title, values) {
  console.log(`\n${title} (${values.length})`);
  if (!values.length) {
    console.log('  - none');
    return;
  }
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function main() {
  const channelMap = parseChannelMap();
  const commandOverrides = parseCommandOverrides();
  const eventMap = parseEventMap();
  const registeredCommands = parseRustRegisteredCommands();
  const commandDefinitions = parseRustCommandDefinitions();
  const usedChannels = parseRendererInvokedChannels();
  const emittedEvents = parseRustEmittedEvents();

  const mappedChannels = [...channelMap.keys()].sort();
  const mappedMissing = mappedChannels
    .filter((channel) => !registeredCommands.has(toRustCommand(channel, commandOverrides)))
    .sort();

  const used = [...usedChannels].sort();
  const usedUnmapped = used.filter((channel) => !channelMap.has(channel)).sort();
  const usedUnmappedWithRustCommand = usedUnmapped
    .filter((channel) => registeredCommands.has(toRustCommand(channel, commandOverrides)))
    .sort();
  const usedUnmappedWithoutRustCommand = usedUnmapped
    .filter((channel) => !registeredCommands.has(toRustCommand(channel, commandOverrides)))
    .sort();
  const usedUnmappedWithoutRustCommandRequired = usedUnmappedWithoutRustCommand
    .filter((channel) => !OPTIONAL_LEGACY_RENDERER_CHANNELS.has(channel))
    .sort();
  const usedMissing = used
    .filter((channel) => channelMap.has(channel))
    .filter((channel) => !registeredCommands.has(toRustCommand(channel, commandOverrides)))
    .sort();

  const requiredEvents = [...eventMap.keys()].sort();
  const missingEvents = requiredEvents
    .filter((eventName) => !emittedEvents.has(eventName))
    .sort();

  const unregisteredCommands = [...commandDefinitions]
    .filter((cmd) => !registeredCommands.has(cmd))
    .sort();

  console.log('POS Tauri Parity Contract Report');
  console.log('================================');
  console.log(`Mapped invoke channels      : ${mappedChannels.length}`);
  console.log(`Registered Rust commands    : ${registeredCommands.size}`);
  console.log(`Tauri command definitions   : ${commandDefinitions.size}`);
  console.log(`Renderer-invoked channels   : ${used.length}`);
  console.log(`Mapped events (bridge)      : ${requiredEvents.length}`);
  console.log(`Rust emitted events         : ${emittedEvents.size}`);

  printList('Mapped channels missing Rust registration', mappedMissing);
  printList('Renderer channels used but unmapped', usedUnmapped);
  printList('Renderer unmapped channels with Rust command fallback', usedUnmappedWithRustCommand);
  printList('Renderer unmapped channels without Rust command', usedUnmappedWithoutRustCommand);
  printList('Renderer unmapped channels without Rust command (required)', usedUnmappedWithoutRustCommandRequired);
  printList('Renderer channels used but missing Rust registration', usedMissing);
  printList('Mapped events missing Rust emit points', missingEvents);
  printList('Rust command functions not in generate_handler!', unregisteredCommands);

  const shouldFail =
    usedUnmappedWithoutRustCommandRequired.length > 0 ||
    usedMissing.length > 0 ||
    missingEvents.length > 0;

  if (shouldFail) {
    console.error('\nParity gate failed.');
    process.exitCode = 1;
    return;
  }

  console.log('\nParity gate passed.');
}

main();

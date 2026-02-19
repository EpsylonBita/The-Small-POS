#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

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
    const name = token.trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      commands.add(name);
    }
  }
  return commands;
}

function parseRustCommandDefinitions() {
  const lib = readFile('src-tauri/src/lib.rs');
  const defs = new Set();
  const regex = /#\[tauri::command\][\s\S]*?async fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  for (const m of lib.matchAll(regex)) {
    defs.add(m[1]);
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

function parseRustEmittedEvents() {
  const rustRoot = path.join(rootDir, 'src-tauri', 'src');
  const files = walk(rustRoot, ['.rs']);
  const events = new Set();
  const regex = /\bemit\(\s*"([^"]+)"/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(regex)) {
      events.add(m[1]);
    }
  }
  return events;
}

function toRustCommand(channel) {
  return channel.replace(/[:\-]/g, '_');
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
  const eventMap = parseEventMap();
  const registeredCommands = parseRustRegisteredCommands();
  const commandDefinitions = parseRustCommandDefinitions();
  const usedChannels = parseRendererInvokedChannels();
  const emittedEvents = parseRustEmittedEvents();

  const mappedChannels = [...channelMap.keys()].sort();
  const mappedMissing = mappedChannels
    .filter((channel) => !registeredCommands.has(toRustCommand(channel)))
    .sort();

  const used = [...usedChannels].sort();
  const usedUnmapped = used.filter((channel) => !channelMap.has(channel)).sort();
  const usedMissing = used
    .filter((channel) => channelMap.has(channel))
    .filter((channel) => !registeredCommands.has(toRustCommand(channel)))
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
  printList('Renderer channels used but missing Rust registration', usedMissing);
  printList('Mapped events missing Rust emit points', missingEvents);
  printList('Rust command functions not in generate_handler!', unregisteredCommands);

  const shouldFail =
    usedUnmapped.length > 0 ||
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

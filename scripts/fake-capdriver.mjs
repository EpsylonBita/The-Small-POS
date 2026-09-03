#!/usr/bin/env node
/**
 * Fake RBS/MAT CAP Driver service.
 *
 * Rehearses the pos-tauri fiscal-cashier flow without a cashier. It behaves
 * like `CapDriverSVC` from the outside: it watches the capture folder, reads
 * each `*.txt` command file, answers with an `Output/<same name>` file and a
 * line in `CapDriverSVC_log.txt`, then deletes the command file. It never
 * talks to hardware.
 *
 * Point the POS cash-register device at the same folders, choose the
 * "CAP Driver" protocol, turn OFF "Require the Windows service", and run:
 *
 *   node scripts/fake-capdriver.mjs --capture C:\Capture
 *
 * Rehearsal switches:
 *   --encoding windows-1253      the service expects ANSI 1253 files (Greek)
 *   --eft-delay-ms 8000          how long the "terminal" takes on an LR line
 *   --fail LR=0x42               decline every card payment (EFTPOS failed)
 *   --fail SL=0x11               reject items (wrong department VAT, etc.)
 *   --consume-delay-ms 130000    consume only after the POS gave up (timeout)
 *   --hang                       never consume: rehearse the ambiguous outcome
 *   --once                       process what is pending, then exit (tests)
 *
 * The output and log wording mirrors what the POS adapter classifies:
 * `Error 0x00` is success, any other code is a device error, and
 * `Receipt is canceled` marks an aborted receipt.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const LOG_FILE_NAME = 'CapDriverSVC_log.txt';
export const KNOWN_COMMANDS = new Set(['SL', 'DE', 'CM', 'CR', 'LR', 'CL', 'XX', 'ZZ']);

// ---------------------------------------------------------------------------
// Windows-1253 (mirrors src-tauri/src/ecr/codepage.rs)
// ---------------------------------------------------------------------------

const CP1253_HIGH = (() => {
  const table = new Array(128).fill(null);
  const set = (byte, codePoint) => {
    table[byte - 0x80] = codePoint;
  };
  const punctuation = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
    0x87: 0x2021, 0x89: 0x2030, 0x8b: 0x2039, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
    0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x99: 0x2122, 0x9b: 0x203a,
    0xa0: 0x00a0, 0xa1: 0x0385, 0xa2: 0x0386, 0xa3: 0x00a3, 0xa4: 0x00a4, 0xa5: 0x00a5,
    0xa6: 0x00a6, 0xa7: 0x00a7, 0xa8: 0x00a8, 0xa9: 0x00a9, 0xab: 0x00ab, 0xac: 0x00ac,
    0xad: 0x00ad, 0xae: 0x00ae, 0xaf: 0x2015, 0xb0: 0x00b0, 0xb1: 0x00b1, 0xb2: 0x00b2,
    0xb3: 0x00b3, 0xb4: 0x0384, 0xb5: 0x00b5, 0xb6: 0x00b6, 0xb7: 0x00b7, 0xb8: 0x0388,
    0xb9: 0x0389, 0xba: 0x038a, 0xbb: 0x00bb, 0xbc: 0x038c, 0xbd: 0x00bd, 0xbe: 0x038e,
    0xbf: 0x038f,
  };
  for (const [byte, codePoint] of Object.entries(punctuation)) set(Number(byte), codePoint);
  for (let i = 0; i <= 0x0f; i += 1) set(0xc0 + i, 0x0390 + i); // ΐ Α … Ο
  set(0xd0, 0x03a0); // Π
  set(0xd1, 0x03a1); // Ρ
  for (let i = 3; i <= 0x0f; i += 1) set(0xd0 + i, 0x03a0 + i); // Σ … ί (0xD2 undefined)
  for (let i = 0; i <= 0x0f; i += 1) set(0xe0 + i, 0x03b0 + i); // ΰ α … ο
  for (let i = 0; i <= 0x0e; i += 1) set(0xf0 + i, 0x03c0 + i); // π … ώ (0xFF undefined)
  return table;
})();

export function encodeCp1253(text) {
  const bytes = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x80) {
      bytes.push(codePoint);
      continue;
    }
    const index = CP1253_HIGH.indexOf(codePoint);
    bytes.push(index >= 0 ? 0x80 + index : 0x3f);
  }
  return Buffer.from(bytes);
}

export function decodeCp1253(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte < 0x80) {
      text += String.fromCharCode(byte);
    } else {
      const codePoint = CP1253_HIGH[byte - 0x80];
      text += codePoint === null ? '\uFFFD' : String.fromCodePoint(codePoint);
    }
  }
  return text;
}

export function normalizeEncoding(value) {
  const normalized = String(value ?? 'utf-8').trim().toLowerCase().replace(/_/g, '-');
  if (['utf-8', 'utf8'].includes(normalized)) return 'utf-8';
  if (['windows-1253', 'cp1253', '1253', 'ansi', 'ansi-1253', 'greek'].includes(normalized)) {
    return 'windows-1253';
  }
  throw new Error(`Unsupported encoding '${value}'; use utf-8 or windows-1253`);
}

export function encodeText(text, encoding) {
  return encoding === 'windows-1253' ? encodeCp1253(text) : Buffer.from(text, 'utf8');
}

export function decodeText(bytes, encoding) {
  return encoding === 'windows-1253' ? decodeCp1253(bytes) : Buffer.from(bytes).toString('utf8');
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function defaultOptions() {
  const capture = process.platform === 'win32' ? 'C:\\Capture' : path.resolve('capture');
  return {
    capture,
    output: null,
    encoding: 'utf-8',
    eftDelayMs: 3000,
    consumeDelayMs: 0,
    failures: {},
    hang: false,
    pollMs: 100,
    once: false,
    quiet: false,
    help: false,
  };
}

export function parseArgs(argv) {
  const options = defaultOptions();
  const args = [...argv];
  const next = (flag) => {
    const value = args.shift();
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  const integer = (flag, value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
    return parsed;
  };
  while (args.length) {
    const flag = args.shift();
    switch (flag) {
      case '--capture':
        options.capture = path.resolve(next(flag));
        break;
      case '--output':
        options.output = path.resolve(next(flag));
        break;
      case '--encoding':
        options.encoding = normalizeEncoding(next(flag));
        break;
      case '--eft-delay-ms':
        options.eftDelayMs = integer(flag, next(flag));
        break;
      case '--consume-delay-ms':
        options.consumeDelayMs = integer(flag, next(flag));
        break;
      case '--poll-ms':
        options.pollMs = Math.max(20, integer(flag, next(flag)));
        break;
      case '--fail': {
        const spec = next(flag);
        const match = /^([A-Za-z]{2})=(0x)?([0-9A-Fa-f]{1,2})$/.exec(spec.trim());
        if (!match) throw new Error(`--fail expects CMD=0xNN, got '${spec}'`);
        const command = match[1].toUpperCase();
        if (!KNOWN_COMMANDS.has(command)) throw new Error(`--fail: unknown command '${command}'`);
        const code = parseInt(match[3], 16);
        if (code === 0) throw new Error('--fail code must be non-zero');
        options.failures[command] = code;
        break;
      }
      case '--hang':
        options.hang = true;
        break;
      case '--once':
        options.once = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown flag '${flag}' (see --help)`);
    }
  }
  if (!options.output) options.output = path.join(options.capture, 'Output');
  return options;
}

export const HELP = `Fake RBS/MAT CAP Driver service for pos-tauri rehearsals.

  node scripts/fake-capdriver.mjs [--capture DIR] [--output DIR] [--encoding utf-8|windows-1253]
      [--eft-delay-ms N] [--consume-delay-ms N] [--fail CMD=0xNN]... [--hang] [--once] [--quiet]

Defaults: capture ${defaultOptions().capture}, output <capture>/Output, utf-8, EFT delay 3000 ms.
In the POS device settings turn OFF "Require the Windows service" and point the
capture/output folders at the same directories.`;

// ---------------------------------------------------------------------------
// Command processing
// ---------------------------------------------------------------------------

const hex = (code) => `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;

function failureMessage(command) {
  switch (command) {
    case 'LR':
      return 'EFTPOS Payment Failed';
    case 'SL':
      return 'Item rejected (department/VAT mismatch)';
    case 'CR':
      return 'Payment rejected';
    default:
      return 'Command rejected';
  }
}

/**
 * Interpret one command file. Pure: no filesystem, no waiting.
 */
export function processCommands(text, options) {
  const failures = options?.failures ?? {};
  const results = [];
  const receipt = { items: [], discounts: [], comment: null, cash: null, card: null, control: [] };
  let cancelled = false;
  let hasEft = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const slash = line.indexOf('/');
    const command = (slash >= 0 ? line.slice(0, slash) : line).toUpperCase();
    const parts = line.split('/');

    if (cancelled) {
      results.push({ command, line, code: null, message: 'skipped, receipt is canceled' });
      continue;
    }
    if (!KNOWN_COMMANDS.has(command)) {
      results.push({ command, line, code: 0x01, message: 'Unknown command' });
      cancelled = true;
      continue;
    }
    if (failures[command]) {
      results.push({ command, line, code: failures[command], message: failureMessage(command) });
      cancelled = true;
      continue;
    }

    results.push({ command, line, code: 0x00, message: 'OK' });
    switch (command) {
      case 'SL':
        receipt.items.push({
          description: parts[1] ?? '',
          barcode: parts[2] ?? '',
          quantity: Number(parts[3] ?? '0'),
          unitPrice: Number(parts[4] ?? '0'),
          department: Number(parts[5] ?? '0'),
          vat: Number(parts[6] ?? '0'),
        });
        break;
      case 'DE':
        receipt.discounts.push(Number(parts[1] ?? '0'));
        break;
      case 'CM':
        receipt.comment = parts[1] ?? '';
        break;
      case 'CR':
        receipt.cash = { code: Number(parts[1] ?? '0'), amount: Number(parts[2] ?? '0'), label: parts[3] ?? '' };
        break;
      case 'LR':
        hasEft = true;
        receipt.card = {
          code: Number(parts[1] ?? '0'),
          amount: Number(parts[2] ?? '0'),
          label: parts[3] ?? '',
          eftIndex: Number(parts[6] ?? '0'),
        };
        break;
      default:
        receipt.control.push(command);
    }
  }

  const outputLines = results.map((result) =>
    result.code === null
      ? `(${result.command}) ${result.message}`
      : `(${result.command})Error ${hex(result.code)}: ${result.message}`,
  );
  if (cancelled) outputLines.push('Receipt is canceled');

  return { results, receipt, cancelled, hasEft, outputLines };
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function renderReceipt(fileName, processed) {
  const { receipt, outputLines } = processed;
  const money = (value) => value.toFixed(2).padStart(9);
  const lines = [`┌─ fake CAP · ${fileName}`];
  for (const item of receipt.items) {
    lines.push(
      `│ ${item.description.padEnd(22).slice(0, 22)} ${item.quantity.toFixed(3)} x ${money(item.unitPrice)}  dept ${item.department} VAT ${item.vat}%`,
    );
  }
  for (const discount of receipt.discounts) lines.push(`│ discount ${money(-discount)}`);
  if (receipt.comment) lines.push(`│ note: ${receipt.comment}`);
  if (receipt.cash) lines.push(`│ CASH  code ${receipt.cash.code} ${receipt.cash.label}`);
  if (receipt.card) lines.push(`│ CARD  code ${receipt.card.code} ${money(receipt.card.amount)} via EFT #${receipt.card.eftIndex}`);
  for (const control of receipt.control) lines.push(`│ control: ${control}`);
  lines.push('├─ driver reply');
  for (const line of outputLines) lines.push(`│ ${line}`);
  lines.push('└──────────────────────────────────');
  return lines.join('\n');
}

export function ensureFolders(options) {
  fs.mkdirSync(options.capture, { recursive: true });
  fs.mkdirSync(options.output, { recursive: true });
}

export function pendingCommandFiles(options) {
  return fs
    .readdirSync(options.capture, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.txt') && name !== LOG_FILE_NAME)
    .sort()
    .map((name) => path.join(options.capture, name));
}

/**
 * Consume one command file the way the vendor service does: reply file in
 * Output/, a log line, then delete the command. Returns the processed result.
 */
export async function handleCommandFile(filePath, options, log = () => {}) {
  const fileName = path.basename(filePath);
  const bytes = fs.readFileSync(filePath);
  const text = decodeText(bytes, options.encoding);
  const processed = processCommands(text, options);

  if (options.consumeDelayMs > 0) await sleep(options.consumeDelayMs);
  if (processed.hasEft && !processed.cancelled && options.eftDelayMs > 0) {
    log(`  terminal: waiting ${options.eftDelayMs} ms for the card…`);
    await sleep(options.eftDelayMs);
  }

  const replyText = `${processed.outputLines.join('\r\n')}\r\n`;
  fs.writeFileSync(path.join(options.output, fileName), encodeText(replyText, options.encoding));
  const logText = processed.outputLines.map((line) => `[${timestamp()}] ${fileName} ${line}`).join('\r\n') + '\r\n';
  fs.appendFileSync(path.join(options.capture, LOG_FILE_NAME), encodeText(logText, options.encoding));
  fs.unlinkSync(filePath);

  log(renderReceipt(fileName, processed));
  return processed;
}

/**
 * Process everything currently pending. With `--hang` nothing is touched so
 * the POS runs into its transaction timeout.
 */
export async function runOnce(options, log = () => {}) {
  ensureFolders(options);
  const files = pendingCommandFiles(options);
  if (options.hang) {
    if (files.length) log(`holding ${files.length} command file(s) untouched (--hang)`);
    return 0;
  }
  let processed = 0;
  for (const file of files) {
    await handleCommandFile(file, options, log);
    processed += 1;
  }
  return processed;
}

export function startFakeCapDriver(options, log = () => {}) {
  ensureFolders(options);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce(options, log);
    } catch (error) {
      log(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  }, options.pollMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  const log = options.quiet ? () => {} : (message) => console.log(message);
  ensureFolders(options);
  log(
    `fake CAP Driver watching ${options.capture} → ${options.output} (${options.encoding}, EFT delay ${options.eftDelayMs} ms` +
      `${options.hang ? ', HANG' : ''}${Object.keys(options.failures).length ? `, fail ${JSON.stringify(options.failures)}` : ''})`,
  );
  if (options.once) {
    const count = await runOnce(options, log);
    log(`processed ${count} command file(s)`);
    return;
  }
  const service = startFakeCapDriver(options, log);
  const stop = () => {
    service.stop();
    log('fake CAP Driver stopped');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, 'scripts', 'fake-capdriver.mjs');
const LOG_FILE_NAME = 'CapDriverSVC_log.txt';

// ΚΑΡΤΑ / ΜΕΤΡΗΤΑ in Windows-1253, as the POS adapter writes them in ANSI mode.
const KARTA_1253 = Buffer.from([0xca, 0xc1, 0xd1, 0xd4, 0xc1]);
const METRITA_1253 = Buffer.from([0xcc, 0xc5, 0xd4, 0xd1, 0xc7, 0xd4, 0xc1]);

function setup() {
  const capture = mkdtempSync(path.join(tmpdir(), 'fake-capdriver-'));
  const output = path.join(capture, 'Output');
  mkdirSync(output, { recursive: true });
  return { capture, output };
}

function runFake(capture: string, extra: string[]) {
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--capture', capture, '--once', '--quiet', '--eft-delay-ms', '0', ...extra],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `fake-capdriver failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test('consumes a cash receipt and answers like CapDriverSVC', () => {
  const { capture, output } = setup();
  try {
    const command = path.join(capture, 'pos-tauri-cash-1.txt');
    writeFileSync(command, 'SL/ΔΟΚΙΜΗ//1.000/0.01/3/24\r\nCM/ORDER 1/\r\nCR/1/0/ΜΕΤΡΗΤΑ\r\n', 'utf8');

    runFake(capture, []);

    assert.equal(existsSync(command), false, 'command file must be consumed');
    const reply = readFileSync(path.join(output, 'pos-tauri-cash-1.txt'), 'utf8');
    assert.match(reply, /\(SL\)Error 0x00: OK/);
    assert.match(reply, /\(CM\)Error 0x00: OK/);
    assert.match(reply, /\(CR\)Error 0x00: OK/);
    assert.doesNotMatch(reply, /Receipt is canceled/);
    const log = readFileSync(path.join(capture, LOG_FILE_NAME), 'utf8');
    assert.match(log, /pos-tauri-cash-1\.txt \(CR\)Error 0x00: OK/);
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
});

test('declines a card payment in ANSI 1253 mode and cancels the receipt', () => {
  const { capture, output } = setup();
  try {
    const command = path.join(capture, 'pos-tauri-card-1.txt');
    writeFileSync(
      command,
      Buffer.concat([
        Buffer.from('SL/TEST//1.000/0.01/3/24\r\nLR/2/0.01/', 'latin1'),
        KARTA_1253,
        Buffer.from('///1/1/\r\n', 'latin1'),
      ]),
    );

    runFake(capture, ['--encoding', 'windows-1253', '--fail', 'LR=0x42']);

    assert.equal(existsSync(command), false);
    const replyBytes = readFileSync(path.join(output, 'pos-tauri-card-1.txt'));
    const reply = replyBytes.toString('latin1');
    assert.match(reply, /\(SL\)Error 0x00: OK/);
    assert.match(reply, /\(LR\)Error 0x42: EFTPOS Payment Failed/);
    assert.match(reply, /Receipt is canceled/);
    // Nothing in the reply may be UTF-8 multi-byte Greek; ANSI mode stays single-byte.
    assert.equal(replyBytes.includes(Buffer.from([0xce, 0x9a])), false);
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
});

test('re-encodes the Greek payment label so a Windows-1253 POS file round-trips', () => {
  const { capture } = setup();
  try {
    const command = path.join(capture, 'pos-tauri-ansi-1.txt');
    writeFileSync(
      command,
      Buffer.concat([Buffer.from('CR/1/0/', 'latin1'), METRITA_1253, Buffer.from('\r\n', 'latin1')]),
    );

    runFake(capture, ['--encoding', 'windows-1253']);

    const log = readFileSync(path.join(capture, LOG_FILE_NAME));
    assert.match(log.toString('latin1'), /\(CR\)Error 0x00: OK/);
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
});

test('--hang leaves the command file untouched so the POS times out', () => {
  const { capture, output } = setup();
  try {
    const command = path.join(capture, 'pos-tauri-hang-1.txt');
    writeFileSync(command, 'XX/\r\n', 'utf8');

    runFake(capture, ['--hang']);

    assert.equal(existsSync(command), true, 'hang mode must never consume');
    assert.equal(existsSync(path.join(output, 'pos-tauri-hang-1.txt')), false);
    assert.equal(existsSync(path.join(capture, LOG_FILE_NAME)), false);
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
});

test('rejects an unknown command with a non-zero error code', () => {
  const { capture, output } = setup();
  try {
    writeFileSync(path.join(capture, 'pos-tauri-bad-1.txt'), 'QQ/what/\r\nCR/1/0/CASH\r\n', 'utf8');

    runFake(capture, []);

    const reply = readFileSync(path.join(output, 'pos-tauri-bad-1.txt'), 'utf8');
    assert.match(reply, /\(QQ\)Error 0x01: Unknown command/);
    assert.match(reply, /\(CR\) skipped, receipt is canceled/);
    assert.match(reply, /Receipt is canceled/);
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
});

test('refuses unknown flags and encodings instead of guessing', () => {
  const badFlag = spawnSync(process.execPath, [scriptPath, '--capture', tmpdir(), '--bogus'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /Unknown flag '--bogus'/);

  const badEncoding = spawnSync(
    process.execPath,
    [scriptPath, '--capture', tmpdir(), '--encoding', 'latin1'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(badEncoding.status, 2);
  assert.match(badEncoding.stderr, /Unsupported encoding 'latin1'/);
});

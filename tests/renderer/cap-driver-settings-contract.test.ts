import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// CAP Driver (RBS/MAT) site-configurable settings: the file encoding must be
// selectable (installers set to ANSI 1253 vs UTF-8), the cashier TCP probe
// must be opt-in (RBS ELIO links are often UDP/serial behind the service),
// and the service requirement must be switchable off for the rehearsal
// script. This pins the UI, the Rust adapter, and the five locales together.

const read = (...segments: string[]) => readFileSync(path.join(process.cwd(), ...segments), 'utf8');

const sectionSource = read('src', 'renderer', 'components', 'peripherals', 'CashRegisterSection.tsx');
const adapterSource = read('src-tauri', 'src', 'ecr', 'protocols', 'cap_driver.rs');
const codepageSource = read('src-tauri', 'src', 'ecr', 'codepage.rs');
const ecrModSource = read('src-tauri', 'src', 'ecr', 'mod.rs');
const fakeServiceSource = read('scripts', 'fake-capdriver.mjs');

const locale = (name: string): Record<string, any> =>
  JSON.parse(read('src', 'locales', `${name}.json`));

const CAP_SETTING_KEYS = [
  'capFileEncoding',
  'capFileEncodingUtf8',
  'capFileEncodingAnsi',
  'capFileEncodingHelp',
  'capProbeTcp',
  'capProbeTcpHelp',
  'capRequireService',
  'capRequireServiceHelp',
];

test('cash-register form exposes CAP file encoding, TCP probe, and service requirement', () => {
  assert.match(sectionSource, /type CapFileEncoding = 'utf-8' \| 'windows-1253'/);
  assert.match(sectionSource, /requireService: boolean/);
  assert.match(sectionSource, /probeDeviceTcp: boolean/);
  assert.match(sectionSource, /fileEncoding: CapFileEncoding/);

  // Defaults: UTF-8, probe off, service required.
  assert.match(
    sectionSource,
    /DEFAULT_CAP_DRIVER_SETTINGS: CapDriverSettings = \{[\s\S]*?requireService: true,[\s\S]*?probeDeviceTcp: false,[\s\S]*?fileEncoding: 'utf-8',[\s\S]*?\}/,
  );

  // Stored settings normalize with the same defaults and accept the ANSI aliases.
  assert.match(sectionSource, /requireService: settings\.requireService !== false/);
  assert.match(sectionSource, /probeDeviceTcp: settings\.probeDeviceTcp === true/);
  assert.match(sectionSource, /fileEncoding: asCapFileEncoding\(settings\.fileEncoding\)/);
  assert.match(sectionSource, /\['windows-1253', 'cp1253', '1253', 'ansi', 'ansi-1253'\]\.includes\(normalized\)/);

  // Controls exist and write back into settings.
  assert.match(sectionSource, /<select[\s\S]{0,200}value=\{form\.settings\.fileEncoding\}/);
  assert.match(sectionSource, /<option value="utf-8">/);
  assert.match(sectionSource, /<option value="windows-1253">/);
  assert.match(sectionSource, /checked=\{form\.settings\.probeDeviceTcp\}/);
  assert.match(sectionSource, /checked=\{form\.settings\.requireService\}/);
  for (const key of CAP_SETTING_KEYS) {
    assert.match(
      sectionSource,
      new RegExp(`settings\\.peripherals\\.cashRegister\\.${key}'`),
      `CashRegisterSection must use locale key ${key}`,
    );
  }

  // The port copy no longer promises TCP: the vendor service may use UDP.
  assert.doesNotMatch(sectionSource, /A valid vendor ERP TCP port is required/);
});

test('CAP adapter reads the same setting keys and gates the TCP probe', () => {
  assert.match(adapterSource, /bool_setting\(config, &\["probeDeviceTcp", "probe_device_tcp"\]\)\.unwrap_or\(false\)/);
  assert.match(adapterSource, /FileEncoding::parse\(string_setting\(config, &\["fileEncoding", "file_encoding"\]\)\)\?/);
  assert.match(adapterSource, /bool_setting\(config, &\["requireService", "require_service"\]\)[\s\S]{0,40}\.unwrap_or\(true\)/);
  assert.match(adapterSource, /if !self\.probe_device_tcp \{\s*return Ok\(\(\)\);\s*\}/);
  // Command file bytes and the service's Output/log go through the encoding.
  assert.match(adapterSource, /\.file_encoding\s*\.encode\(&format!\("\{\}\\r\\n", commands\.join\("\\r\\n"\)\)\)/);
  assert.match(adapterSource, /\.map\(\|bytes\| self\.file_encoding\.decode\(&bytes\)\)/);
  assert.match(adapterSource, /"windows-1253" \| "cp1253" \| "1253" \| "ansi" \| "ansi-1253" \| "greek"/);
  assert.match(ecrModSource, /pub mod codepage;/);
  assert.match(codepageSource, /pub fn encode_cp1253/);
  assert.match(codepageSource, /pub fn decode_cp1253/);
});

test('CAP setting labels exist in every POS locale', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const values = locale(language).settings?.peripherals?.cashRegister;
    assert.ok(values, `${language}.settings.peripherals.cashRegister missing`);
    for (const key of CAP_SETTING_KEYS) {
      const value = values[key];
      assert.equal(typeof value, 'string', `${language}: ${key} missing`);
      assert.ok(value.trim().length > 0, `${language}: ${key} empty`);
      assert.doesNotMatch(value, /NEEDS TRANSLATION/, `${language}: ${key} is a placeholder`);
    }
    assert.doesNotMatch(String(values.tcpPortRequired), /\bTCP\b/, `${language}: port copy must not promise TCP`);
  }
});

test('fake CAP Driver script speaks the same encodings and error markers as the adapter', () => {
  assert.match(fakeServiceSource, /export function encodeCp1253/);
  assert.match(fakeServiceSource, /export function decodeCp1253/);
  assert.match(fakeServiceSource, /Receipt is canceled/);
  assert.match(fakeServiceSource, /EFTPOS Payment Failed/);
  assert.match(fakeServiceSource, /LOG_FILE_NAME = 'CapDriverSVC_log\.txt'/);
  // Same alias list as the Rust parser so a site setting means one thing everywhere.
  assert.match(fakeServiceSource, /\['windows-1253', 'cp1253', '1253', 'ansi', 'ansi-1253', 'greek'\]/);
});

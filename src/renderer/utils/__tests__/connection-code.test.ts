import { describe, expect, it, vi } from 'vitest';
import { decodeConnectionString, normalizeAdminDashboardUrl } from '../connection-code';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const valid = { key: 'fixture-secret', url: 'https://admin.example/api/', tid: 'TERMINAL-1' };

describe('connection code validation', () => {
  it('accepts URL-safe codes, wrapped paste and UTF-8 terminal names without exposing credentials in logs', () => {
    const log = vi.spyOn(console, 'error');
    const code = encode({ ...valid, tid: 'Κατάστημα-1', surl: 'https://data.example', skey: 'fixture-anon' });
    expect(decodeConnectionString(` ${code.slice(0, 20)}\n${code.slice(20)} `)).toEqual({
      apiKey: 'fixture-secret', adminUrl: valid.url, terminalId: 'Κατάστημα-1',
      supabaseUrl: 'https://data.example', supabaseAnonKey: 'fixture-anon',
    });
    expect(decodeConnectionString('not-a-code')).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { ...valid, key: 123 }, { ...valid, tid: {} }, { ...valid, url: [] },
    { ...valid, key: ' ' }, { ...valid, tid: '\n' }, { ...valid, url: ' ' },
    { ...valid, url: 'https://bad host.example' }, { ...valid, url: 'file:///private' },
    { ...valid, url: 'ftp://admin.example' }, { ...valid, url: 'https://user:secret@admin.example' },
    { ...valid, url: 'https://[invalid' },
  ])('rejects malformed payload %j before it can populate a connection preview', (payload) => {
    expect(decodeConnectionString(encode(payload))).toBeNull();
  });

  it('preserves supported hosted and local server normalization and legacy optional fields', () => {
    expect(normalizeAdminDashboardUrl('admin.example/api/')).toBe('https://admin.example');
    expect(normalizeAdminDashboardUrl('localhost:3000/api')).toBe('http://localhost:3000');
    expect(decodeConnectionString(encode({ ...valid, url: 'localhost:3000', supabaseUrl: 'https://data.example', supabaseAnonKey: 'fixture-anon' })))
      .toMatchObject({ adminUrl: 'localhost:3000', supabaseUrl: 'https://data.example', supabaseAnonKey: 'fixture-anon' });
  });
});

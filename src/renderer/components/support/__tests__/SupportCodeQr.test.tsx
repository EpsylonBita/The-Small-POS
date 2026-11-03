import React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeSupportQr, SupportCodeScreen } from '../SupportCodeScreen';
import { SupportCodeSchema } from '../../../hooks/useSupportSession';
import fixture from '../../../../../../shared/pos/support/__fixtures__/routes/pos-support-sessions.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// shared/'s own qrcode dependency is an independent test oracle only. The desktop CI job installs
// shared/ before these checks; the repo-root install does not run on a desktop-only change.
const require = createRequire(path.resolve(process.cwd(), '../shared/package.json'));
const reference: { create(segments: { data: string; mode: string }[], options: { errorCorrectionLevel: string; maskPattern: number }): { version: number; modules: { size: number; data: Uint8Array } } } = require('qrcode/lib/core/qrcode');
afterEach(cleanup);

it.each([1, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 500, 1000, 2048])('encodes %i bytes identically to the independent QR reference', length => {
  const value = fixture.response.qr_url.repeat(Math.ceil(length / fixture.response.qr_url.length)).slice(0, length);
  const qr = encodeSupportQr(value);
  const expected = reference.create([{ data: value, mode: 'byte' }], { errorCorrectionLevel: 'L', maskPattern: 0 });
  expect(qr.version).toBe(expected.version);
  expect(qr.size).toBe(expected.modules.size);
  expect(qr.cells).toEqual(Array.from(expected.modules.data));
});
it('renders only local SVG paths from the shipped fragment URL without a resource request', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const code = SupportCodeSchema.parse(fixture.response);
  render(<SupportCodeScreen view="code" code={code} remainingMs={1000} busy={false} onRetry={vi.fn()} onCancel={vi.fn()} />);
  const qr = screen.getByRole('img');
  expect(qr.tagName.toLowerCase()).toBe('svg');
  expect(qr.querySelector('path')).toBeInTheDocument();
  expect(qr.outerHTML).not.toContain(code.qr_url);
  expect(document.querySelector('[src], [href]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  'https://console.example.test/admin/support/connect?c=ABCDEFGH#c=ABCDEFGH',
  'https://your-user:your-password@console.example.test/admin/support/connect#c=ABCDEFGH',
  'http://console.example.test/admin/support/connect#c=ABCDEFGH',
  'https://console.example.test/other#c=ABCDEFGH',
])('rejects unsafe QR URL %s', qr_url => {
  expect(SupportCodeSchema.safeParse({ ...fixture.response, qr_url }).success).toBe(false);
  render(<SupportCodeScreen view="code" code={{ ...fixture.response, qr_url }} remainingMs={1000} busy={false} onRetry={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
});

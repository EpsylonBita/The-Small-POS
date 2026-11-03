import React from 'react';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { localeBundles } from '../../src/locales/bundles';
import { SupportBannerView } from '../../src/renderer/components/support/SupportBanner';
import { SupportCodeScreen } from '../../src/renderer/components/support/SupportCodeScreen';
import { SUPPORT_BANNER_STATES, type SupportBannerSnapshot } from '../../src/renderer/hooks/useSupportSession';

// CI's parity runner uses node:test; the bounded worker also runs this exact file
// under Vitest with an explicit narrow include, without running the parity suite.
const register: (name: string, body: () => void) => unknown = process.env.VITEST
  ? (await import('vitest')).test : (await import('node:test')).test;
const snapshot: SupportBannerSnapshot = {
  availability: null, state: 'connected', session_id: null, operator_name: 'Operator', remaining_ms: 600_000,
  current_activity_key: null, can_connect: false, staff: null, extend_allowed: true, critical_op_active: false, write_outcome: null,
};
for (const theme of ['light', 'dark']) {
  for (const locale of ['el', 'en', 'de', 'fr', 'it', 'sq'] as const) {
    register(`${theme}/${locale}: all banner and code states retain named, opaque touch controls`, () => {
      const i18n = createInstance();
      void i18n.init({ lng: locale, resources: { [locale]: { translation: localeBundles[locale] } }, initAsync: false });
      const render = (child: React.ReactElement) => renderToStaticMarkup(<I18nextProvider i18n={i18n}><div className={theme} style={{ width: 320 }}>{child}</div></I18nextProvider>);
      for (const state of SUPPORT_BANNER_STATES) {
        const markup = render(<SupportBannerView snapshot={{ ...snapshot, state }} onEnd={() => {}} onExtend={() => {}} />);
        assert.ok(markup.includes(String(i18n.t(`support.banner.${state}`))));
        assert.ok(markup.includes(String(i18n.t('support.banner.end'))));
        assert.ok(markup.includes('shrink-0 whitespace-nowrap'));
        assert.ok(markup.includes('min-h-[48px] min-w-[48px]'));
        assert.ok(markup.includes('bg-(--pos-s-surface)'));
        assert.ok(markup.includes('bg-(--pos-s-sel-bg)'));
        assert.ok(!markup.includes('truncate'));
      }
      for (const view of ['code', 'expired', 'offline', 'error'] as const) {
        const code = { code_id: '40000000-0000-4000-a000-000000000004', code: 'ABCD-EFGH', terminal_name: 'Counter',
          expires_at: '2026-11-01T12:10:00.000Z', server_time: '2026-11-01T12:00:00.000Z',
          qr_url: 'https://the-small.ai/admin/support/connect#ABCD-EFGH', qr_data_url: 'data:image/png;base64,eW91ci1xci1pbWFnZQ==' };
        const markup = render(<SupportCodeScreen view={view} code={code} remainingMs={600_000} busy={false} onRetry={() => {}} onCancel={() => {}} />);
        assert.ok(markup.includes(String(i18n.t('support.code.cancel'))));
        assert.equal(markup.includes('ABCD-EFGH'), view === 'code');
        assert.ok(!markup.includes('support.code.'));
      }
    });
  }
}

function luminance(hex: string) {
  const values = [0, 2, 4].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
register('support surface and selection tokens meet 4.5:1 in both themes', () => {
  const css = readFileSync('src/renderer/styles/glassmorphism.css', 'utf8');
  for (const [foreground, background] of [['18181b', 'ffffff'], ['fafafa', '18181b'], ['18181b', 'facc15']]) {
    assert.ok(css.includes(`#${foreground}`) && css.includes(`#${background}`));
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    assert.ok((light + 0.05) / (dark + 0.05) >= 4.5);
  }
});
register('one shared session owner mounts the banner and direct Health action', () => {
  const app = readFileSync('src/renderer/App.tsx', 'utf8');
  const health = readFileSync('src/renderer/components/SyncStatusIndicator.tsx', 'utf8');
  // Phase 3 put the restore notice and interaction host inside the same single provider.
  assert.equal(app.split('<SupportSessionProvider>').length - 1, 1);
  assert.match(app, /<SupportSessionProvider>(?:(?!<\/SupportSessionProvider>).)*<AppContent \/>(?:(?!<\/SupportSessionProvider>).)*<\/SupportSessionProvider>/);
  assert.ok(app.includes('<SupportBanner />'));
  assert.match(health, /overflow-y-auto px-5 py-5 sm:px-6">\s*<SupportConnectAction \/>/);
});

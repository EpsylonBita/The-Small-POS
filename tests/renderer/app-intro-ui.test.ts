import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.join(process.cwd(), 'src', 'renderer', rel), 'utf8');

// Founder 31/10: «αυτό το βίντεο να μπαίνει μόλις τρέχει η εφαρμογή και μετά να πηγαίνει εκεί στη θέση του
// στο login modal».
test('the start-up intro plays over the till window only, in its own root, and lands on the sign-in logo', () => {
  // The page loads src/main.tsx (index.html); src/renderer/index.tsx is an old entry nothing loads, which is
  // where the first try mounted it, so the live till never showed it (31/10).
  const html = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  const entry = readFileSync(path.join(process.cwd(), 'src', 'main.tsx'), 'utf8');
  assert.match(entry, /if \(!resolveExternalDisplayKind\(''\) && intro\.shouldPlayAppIntro\(\)\) \{/, 'not on the customer/kitchen displays');
  assert.match(entry, /const introRoot = ReactDOM\.createRoot\(introHost\);/);
  assert.match(entry, /onGone=\{\(\) => \{\s*introRoot\.unmount\(\);\s*introHost\.remove\(\);/);
  // Started before the app loads, and never in the way of the app.
  assert.ok(entry.indexOf("import('./renderer/components/AppIntro')") < entry.indexOf("import('./renderer/App')"));
  assert.match(entry, /\} catch \(introError\) \{\s*console\.warn\('\[Startup\] intro skipped \(non-fatal\):', introError\);/);
  assert.doesNotMatch(read('index.tsx'), /AppIntro/);

  const intro = read('components/AppIntro.tsx');
  assert.match(intro, /import introClip from '\.\.\/assets\/intro\/the-small-intro\.mp4';/);
  assert.match(intro, /muted\s+playsInline/);
  assert.match(intro, /INTRO_LAND_AT_S = 6\.4;/);
  // Never waits on the clip: bounded timers move it on.
  assert.match(intro, /at\(INTRO_START_MAX_MS, \(\) => \{\s*if \(!started\) land\(\);/);
  assert.match(intro, /at\(INTRO_MAX_MS, land\);/);
  assert.match(intro, /video\?\.play\(\)\?\.catch\(land\);/);
  assert.doesNotMatch(intro, /onAnimationComplete|onExitComplete|onAnimationEnd|onEnded/);
  // A key skips it and never types into the sign-in keypad underneath.
  assert.match(intro, /event\.stopImmediatePropagation\(\);\s*land\(\);/);
  assert.match(intro, /window\.addEventListener\('keydown', onKey, true\);/);
  assert.match(intro, /document\.querySelector<HTMLElement>\('\[data-login-logo\]'\)/);
  assert.doesNotMatch(intro, /rgba\(/, 'opaque colours only');

  // The real sign-in logo waits hidden while the moving one is on its way.
  assert.match(read('pages/LoginPage.tsx'), /ref=\{logoRef\}\s*data-login-logo\s/);
  assert.match(read('styles/glassmorphism.css'), /html\[data-app-intro\] \[data-login-logo\] \{\s*opacity: 0 !important;\s*\}/);
});

test('the intro clip is bundled, small enough, and allowed by the content security policy', () => {
  const clip = statSync(path.join(process.cwd(), 'src', 'renderer', 'assets', 'intro', 'the-small-intro.mp4'));
  assert.ok(clip.size > 100_000 && clip.size < 8_000_000, `clip size ${clip.size}`);
  const conf = readFileSync(path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8');
  assert.match(conf, /media-src 'self'/);
  assert.match(read('types/assets.d.ts'), /declare module '\*\.mp4'/);
});

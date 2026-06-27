import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.join(process.cwd(), 'src', 'renderer', rel), 'utf8');
const loginSource = () => read('pages/LoginPage.tsx');
const animatedBackgroundSource = () => read('components/AnimatedBackground.tsx');
const themeToggleSource = () => read('components/ThemeToggle.tsx');

// Restoration guard (round 186): LoginPage must keep the restored yellow/black lava-lamp orb
// animation, and AnimatedBackground must not be simplified back to a static/plain background.
test('LoginPage renders AnimatedBackground and the yellow lava-lamp orb animation is intact', () => {
  const login = loginSource();
  assert.match(login, /import AnimatedBackground from ['"]\.\.\/components\/AnimatedBackground['"]/);
  assert.match(login, /<AnimatedBackground \/>/);

  const bg = animatedBackgroundSource();
  // Framer-motion blobs that loop forever (the lava-lamp motion, not a static gradient).
  assert.match(bg, /from 'framer-motion'/);
  assert.match(bg, /<motion\.div/);
  assert.match(bg, /repeat: Infinity/);
  // Radial-gradient orbs in the yellow/amber palette (black/white core -> yellow edges).
  assert.match(bg, /radial-gradient\(circle/);
  assert.match(bg, /#eab308|#facc15|#fde68a|#d97706|#92400e/);
  // It must not have been flattened to a single static element with no animation.
  assert.match(bg, /Lava lamp blob/);
});

// Round 271 restoration verification: the yellow lava-lamp orbs must animate in BOTH theme
// branches, not just one. Guards against a half-restore where only the light (or only the dark)
// branch keeps the orbs/motion. Branch-scoped + source-level to avoid brittle full snapshots.
test('AnimatedBackground preserves the yellow lava-lamp animation in both light and dark branches', () => {
  const bg = animatedBackgroundSource();

  // Each theme renders its own orb set: the light (!isDark) branch precedes the dark (isDark) one.
  const lightStart = bg.indexOf('{!isDark && (');
  const darkStart = bg.indexOf('{isDark && (');
  assert.ok(lightStart >= 0, 'light theme branch (!isDark) must render');
  assert.ok(darkStart > lightStart, 'dark theme branch (isDark) must render after the light branch');

  const branches = [
    { name: 'light', src: bg.slice(lightStart, darkStart), gradientVar: 'lightOrbGradient' },
    { name: 'dark', src: bg.slice(darkStart), gradientVar: 'darkOrbGradient' },
  ];

  for (const { name, src, gradientVar } of branches) {
    const blobs = src.match(/<motion\.div/g) ?? [];
    const loops = src.match(/repeat: Infinity/g) ?? [];
    const animates = src.match(/animate=\{\{/g) ?? [];
    assert.ok(blobs.length >= 3, `${name} branch must keep multiple lava-lamp motion.div blobs (found ${blobs.length})`);
    assert.equal(loops.length, blobs.length, `${name} branch: every orb loops forever (repeat: Infinity)`);
    assert.equal(animates.length, blobs.length, `${name} branch: every orb has an animate transform (drift/scale)`);
    assert.match(src, new RegExp(`background: ${gradientVar}`), `${name} orbs must paint the ${gradientVar}`);
  }

  // Both orb gradients stay radial yellow/amber (black/white core -> yellow edge).
  const lightGradient = bg.match(/const lightOrbGradient = '([^']*)'/)?.[1] ?? '';
  const darkGradient = bg.match(/const darkOrbGradient = '([^']*)'/)?.[1] ?? '';
  const YELLOW = /#eab308|#facc15|#fde68a|#d97706|#92400e/;
  assert.match(lightGradient, /radial-gradient\(circle/, 'light orb must be a radial gradient');
  assert.match(darkGradient, /radial-gradient\(circle/, 'dark orb must be a radial gradient');
  assert.match(lightGradient, YELLOW, 'light orb gradient must keep yellow/amber tokens');
  assert.match(darkGradient, YELLOW, 'dark orb gradient must keep yellow/amber tokens');
});

// Founder access-control correction: settings must not be reachable before staff login.
// Login keeps the theme toggle, but no connection/settings shortcut is rendered or accepted.
test('LoginPage does not expose settings before authentication', () => {
  const login = loginSource();

  assert.doesNotMatch(login, /onOpenSettings/);
  assert.doesNotMatch(login, /login\.connectionSettings/);
  assert.doesNotMatch(login, /Connection settings/);
  assert.doesNotMatch(login, /\bSettings\b/);

  // No native title tooltip anywhere on the login page.
  assert.doesNotMatch(login, /\btitle=/);
  assert.match(login, /<ThemeToggle \/>/);
});

test('LoginPage uses the requested theme-specific app logos', () => {
  const login = loginSource();

  assert.match(login, /import logoBlack from ["']\.\.\/assets\/logo-black\.png["']/);
  assert.match(login, /import logoWhite from ["']\.\.\/assets\/logo-white\.png["']/);
  assert.match(login, /const loginLogoSource = isDark \? logoBlack : logoWhite/);
  assert.match(login, /src=\{loginLogoSource\}/);
  assert.doesNotMatch(login, /dark:hidden|hidden dark:block/);
});

// Round 186 follow-up: the login-screen ThemeToggle exposed a native title tooltip + hover text
// classes. Touchscreen-first -> aria-label only, active/tap feedback (no hover), cycle + A/Sun/Moon
// states preserved.
test('ThemeToggle has aria-label, no native title, and no hover utilities (touch-first)', () => {
  const source = themeToggleSource();

  // Accessible name via aria-label (keyed by theme), no native title tooltip.
  assert.match(source, /aria-label=\{t\('app\.themeToggle\.title', \{ theme \}\)\}/);
  assert.doesNotMatch(source, /\btitle=/);

  // No hover utilities; active/tap feedback instead.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.match(source, /active:scale-95/);
  assert.match(source, /active:text-white/);
  assert.match(source, /active:text-black/);

  // Cycle behaviour + visible A / Sun / Moon states are unchanged.
  assert.match(source, /onClick=\{cycle\}/);
  assert.match(source, /const cycle = \(\) => setTheme\(theme === 'auto' \? 'dark' : theme === 'dark' \? 'light' : 'auto'\);/);
  assert.match(source, /<span className="text-xs font-semibold">A<\/span>/);
  assert.match(source, /<Moon className="h-5 w-5" \/>/);
  assert.match(source, /<Sun className="h-5 w-5" \/>/);
});

// Round 348 (live QA regression hardening): the fresh debug app shows the animated yellow orb background.
// Lock that the orbs stay MULTIPLE + animated (not flattened to one static element) and LoginPage keeps
// mounting it. Source already matches; this is a guard, not a redesign.
test('Round 348: login keeps multiple animated yellow orbs, not a static background', () => {
  const bg = animatedBackgroundSource();
  const orbCount = (bg.match(/<motion\.div/g) ?? []).length;
  assert.ok(orbCount >= 6, `expected several animated orbs, found ${orbCount}`);
  assert.ok((bg.match(/animate=\{/g) ?? []).length >= 6, 'each orb must declare a framer-motion animate prop');
  assert.match(bg, /repeat: Infinity/);
  assert.match(bg, /#eab308|#facc15|#fde68a|#d97706|#92400e|#f59e0b/);
  // The page still mounts the animated background (no swap to a static flat element).
  assert.match(loginSource(), /<AnimatedBackground \/>/);
});

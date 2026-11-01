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
  // Keep the same cycle while surfacing a failed durable theme save.
  assert.match(source, /const cycle = \(\) => \{\s*try \{\s*setTheme\(theme === 'auto' \? 'dark' : theme === 'dark' \? 'light' : 'auto'\);\s*\} catch \{\s*toast\.error\(t\('errors\.saveFailed'\)\);\s*\}\s*\};/);
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

// Founder 31/10 («με το που βάλεις το σωστό PIN κάνει login μόνο του ... μήπως έβγαζα τελείως το κουμπί»):
// the PIN screen has no sign-in button. It signs in by itself at the PIN's length, which the till keeps as a
// digit count per slot (utils/loginPinLength) when a PIN is set and after every successful sign-in.
test('the PIN screen has no sign-in button and every PIN path keeps the digit count', () => {
  const login = loginSource();
  assert.doesNotMatch(login, /onClick=\{handleLoginClick\}[\s\S]{0,200}w-full bg-yellow-400/);
  assert.doesNotMatch(login, /\{isLoading \? t\('login\.loggingIn'\) : t\('login\.loginButton'\)\}/);
  assert.doesNotMatch(login, /setTimeout\(resolve, 500\)/, 'no artificial wait before the PIN is checked');
  assert.match(login, /pin\.length === autoSubmitLength/);
  assert.match(login, /data-testid="login-enter-key"/);
  assert.match(login, /rememberLoginPinLength\(bridge, \['admin', 'staff'\], newPin\.length\)/);
  assert.match(login, /rememberLoginPinLength\(bridge, \['staff'\], legacyPin\.length\)/);
  // Clear and backspace are icons in the digits' frame.
  assert.match(login, /<X size=\{22\} aria-hidden="true" \/>/);

  assert.match(read('App.tsx'), /rememberLoginPinLength\(bridge, \[loginPinSlotForRole\(userData\.role\)\], pin\.length\)/);
  assert.match(
    read('components/modals/ConnectionSettingsModal.tsx'),
    /rememberLoginPinLength\(bridge, \['staff'\], pin\.length\)/,
  );
});

// Founder 31/10 («ένα ωραίο animation όταν κάνει login και μπαίνει στο σύστημα»), then «δεν είναι ομαλό: να
// κατεβαίνει από εκεί που είναι στο κέντρο και μετά να κάνει zoom ... επίσης καθυστερεί ... σβήνοντας και το
// modal του login»: the exit starts the moment the PIN is accepted (before the session is completed), the card
// fades while the logo glides from its place to the middle, and the same mounted sign-in layer then zooms away
// over the till. Only a sign-in plays it, it paints opaque colours, and reduce motion is MotionConfig's "user".
test('the sign-in screen leaves at once: the logo glides to the middle, then the layer zooms into the till', () => {
  const app = read('App.tsx');
  // 'leaving' is set right after the native PIN check, before the organisation and keyring work.
  const success = app.indexOf("if (result && result.success && userData) {");
  const leaving = app.indexOf("setLoginExit('leaving');", success);
  const enrich = app.indexOf('enrichSessionUserWithOrganization(userData)', success);
  assert.ok(success > 0 && leaving > success && leaving < enrich, 'the exit starts before the session work');
  assert.match(app, /await loginScreenLeft;[\s\S]{0,400}setLoginExit\('opening'\)[\s\S]{0,200}setUser\(enrichedUser\);/);
  assert.match(app, /window\.setTimeout\(resolve, LOGIN_LEAVE_MAX_MS\)/, 'never waits on an animation that does not report');
  // One sign-in layer, kept mounted from the login screen to the zoom (no remount, no jump).
  assert.match(app, /key="login-layer"/);
  assert.match(app, /animate=\{\{ opacity: isOpeningTill \? 0 : 1 \}\}/);
  assert.match(app, /delay: LOGIN_TILL_REVEAL_DELAY_S, duration: LOGIN_TILL_REVEAL_S/);
  assert.match(app, /if \(!user\) \{\s*return \(\s*<>\s*\{null\}\s*\{loginLayer\}\s*<\/>/);
  assert.match(app, /<\/ErrorBoundary>\s*\{loginLayer\}\s*<\/>/);
  assert.match(app, /<MotionConfig reducedMotion="user">/);
  // A failure after the PIN was accepted brings the card back.
  assert.match(app, /loginLeftRef\.current = null;\s*setLoginExit\(null\);\s*throw err;/);

  const login = loginSource();
  assert.match(login, /data-testid="login-flying-logo"/);
  assert.match(login, /: \{ x: logoFlight\.dx, y: logoFlight\.dy, scale: 1\.35, transition: \{ duration: LOGIN_LOGO_GLIDE_S/);
  // Bounded timers, never the animation's end (motion rule: checkout never freezes).
  assert.match(login, /window\.setTimeout\(\(\) => onLeft\?\.\(\), LOGIN_LOGO_GLIDE_S \* 1000 \+ LOGIN_LOGO_HOLD_MS\)/);
  assert.match(app, /\(\) => setLoginExit\(null\),\s*\(LOGIN_TILL_REVEAL_DELAY_S \+ LOGIN_TILL_REVEAL_S\) \* 1000 \+ 60/);
  assert.doesNotMatch(login + app, /onAnimationComplete/);
  // Founder 31/10 («θα ήθελα πιο αργή την κίνηση!!»): an unhurried exit.
  assert.match(login, /LOGIN_LOGO_GLIDE_S = 0\.9;/);
  assert.match(login, /LOGIN_CARD_FADE_S = 0\.6;/);
  // Founder 31/10 («να κάνει ζουμ μέχρι την πέρλα του λογοτύπου»): the logo dives into its pearl until it
  // fills the window, around the pearl's measured centre, and the till shows through the gold.
  assert.match(login, /const PEARL_ZOOM_STEPS = \[3, 7, 16, 36\];/);
  assert.match(login, /scale: \[1\.35, \.\.\.PEARL_ZOOM_STEPS, logoFlight\.pearlScale\]/);
  assert.match(login, /LOGIN_PEARL_ZOOM_S = 1\.1;/);
  assert.match(login, /transformOrigin: PEARL\[isDark \? 'dark' : 'light'\]\.origin/);
  assert.match(login, /pearlScale: \(Math\.hypot\(root\.width, root\.height\) \/ \(logo\.width \* PEARL\[/);
  assert.match(app, /LOGIN_LEAVE_MAX_MS = 1600;/);
  assert.match(login, /: isLeaving\s*\? \{ opacity: 0, scale: 0\.96, transition: \{ duration: LOGIN_CARD_FADE_S/);
  assert.doesNotMatch(login, /rgba\(/, 'opaque colours only');
});

test('signing out plays it backwards: the till fades slowly into gold, rests, then the logo comes out of the pearl', () => {
  // Founder 31/10: «και στο Logout πρέπει να έχει το ίδιο animation σε reverse!!», then «είναι πολύ απότομο·
  // πρέπει να γίνεται κίτρινο όλο σιγά σιγά και να κάνει fade η εφαρμογή και μετά να ξεκινήσει το transition».
  const app = read('App.tsx');
  const logout = app.slice(app.indexOf('const handleLogout = async () => {'), app.indexOf('if (externalDisplayKind) {'));
  // The layer starts fading in over the till first; the till leaves only once the gold covers it.
  const returning = logout.indexOf("setLoginExit('returning');");
  const nativeLogout = logout.indexOf('await bridge.auth.logout();');
  const covered = logout.indexOf('await covered;');
  const dropped = logout.indexOf('setUser(null);');
  assert.ok(returning > 0 && returning < nativeLogout && nativeLogout < covered && covered < dropped, 'gold first, till after');
  assert.match(logout, /window\.setTimeout\(resolve, LOGIN_RETURN_COVER_S \* 1000\)/);
  assert.match(app, /initial=\{loginExit === 'returning' && user \? \{ opacity: 0 \} : false\}/);
  assert.match(app, /: loginExit === 'returning'\s*\? \{ duration: LOGIN_RETURN_COVER_S, ease: 'easeInOut' \}/);
  assert.match(app, /setLoginExit\(null\), LOGIN_RETURN_TOTAL_S \* 1000 \+ 60/);
  // The native sign-out announces itself as a session end (reason 'logout'); it must not drop the till mid-fade.
  assert.match(logout, /if \(signingOutRef\.current\) return;\s*signingOutRef\.current = true;/);
  assert.match(logout, /\} finally \{\s*signingOutRef\.current = false;\s*\}/);
  assert.match(app, /onLogout: \(reason\) => \{[\s\S]{0,300}if \(reason === 'logout' && signingOutRef\.current\) return;/);
  const events = read('hooks/useAppEvents.ts');
  assert.match(events, /if \(reason !== 'logout'\) \{\s*toast\.error\(tRef\.current\('system\.sessionExpired'\)/);

  const login = loginSource();
  // A full second of gold, a short rest, then out of the pearl (the dive's steps reversed) and home.
  assert.match(login, /LOGIN_RETURN_COVER_S = 1\.0;/);
  assert.match(login, /LOGIN_RETURN_HOLD_S = 0\.25;/);
  assert.match(login, /const RETURN_ZOOM_START_S = LOGIN_RETURN_COVER_S \+ LOGIN_RETURN_HOLD_S;/);
  assert.match(login, /\? \{ x: logoFlight\.dx, y: logoFlight\.dy, scale: logoFlight\.pearlScale \}/);
  assert.match(login, /scale: \[logoFlight\.pearlScale, logoFlight\.pearlScale, \.\.\.\[\.\.\.PEARL_ZOOM_STEPS\]\.reverse\(\), 1\.35, 1\]/);
  assert.match(login, /times: RETURN_TIMES,/);
  assert.match(login, /if \(exitPhase === 'returning'\) return;/, 'no sign-in report on the way back');
  // The card fades back in only as the logo comes home.
  assert.match(login, /opacity: \[0, 0, 1\],[\s\S]{0,200}times: \[0, \(LOGIN_RETURN_TOTAL_S - LOGIN_CARD_FADE_S\) \/ LOGIN_RETURN_TOTAL_S, 1\]/);
  assert.match(login, /\{exitPhase !== 'returning' && \(/, 'no gold ring on the way back');
});

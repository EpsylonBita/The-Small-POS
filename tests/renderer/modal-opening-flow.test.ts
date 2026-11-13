import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Founder, 11/11/2026: «για κλάσματα δευτερολέπτου κάθε επιλογή σαν να φλασάρει κάτι… Θέλω να
// ανοίγουν με smooth animation από το κουμπί που πατήθηκαν». Recorded frame by frame on the dev
// till, the flash had three causes; each one is pinned here:
// 1. one window replacing another dropped the blurred backdrop for a few frames;
// 2. the New Order chooser swapped its cards for a «Setting up order…» spinner, waited 300 ms for
//    nothing, showed the cards again and only then opened the next window;
// 3. «Service» closed the chooser and showed the Services screen sharp until its window came.
const rendererRoot = path.join(process.cwd(), 'src', 'renderer');
const read = (...parts: string[]) => readFileSync(path.join(rendererRoot, ...parts), 'utf8');

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing after ${start}: ${end}`);
  return source.slice(from, to);
}

test('a glass window grows out of the pressed control, and is solid early so the growth shows', () => {
  const css = read('styles', 'glassmorphism.css');
  const enter = sliceBetween(css, '@keyframes liquidModalEnter {', '@keyframes modalExit');
  assert.match(enter, /from \{\s*opacity: 0;\s*transform: scale\(0\.6\);\s*\}/);
  assert.match(enter, /55% \{\s*opacity: 1;\s*\}/);
  assert.match(enter, /to \{\s*opacity: 1;\s*transform: scale\(1\);\s*\}/);
  // The origin is the press point that modal-origin.ts writes on the shell.
  assert.match(css, /transform-origin: var\(--modal-origin-x, 50%\) var\(--modal-origin-y, 50%\);/);
  // Timing stays on the shared modal token (checkout never waits for an animation).
  assert.match(css, /animation: liquidModalEnter var\(--pos-motion-base, 180ms\) var\(--pos-ease/);
});

test('the New Order chooser hands over to the next window in the same step, with no spinner', () => {
  const dashboard = read('components', 'OrderDashboard.tsx');
  const handler = sliceBetween(
    dashboard,
    'const handleOrderTypeSelect = async (',
    'if (type === "pickup") {',
  );
  assert.match(handler, /setShowOrderTypeModal\(false\);/);
  assert.doesNotMatch(handler, /setTimeout|await /, 'no artificial wait before the next window');
  assert.doesNotMatch(dashboard, /isOrderTypeTransitioning/);
  assert.doesNotMatch(dashboard, /orderFlow\.settingUpOrder/);

  const flow = read('components', 'OrderFlow.tsx');
  const flowHandler = sliceBetween(
    flow,
    "const handleSelectOrderType = useCallback(async (type: 'pickup' | 'delivery' | 'dine-in') => {",
    "if (type === 'pickup') {",
  );
  assert.match(flowHandler, /setIsOrderTypeModalOpen\(false\);/);
  assert.doesNotMatch(flowHandler, /setTimeout|await /, 'no artificial wait before the next window');
  assert.doesNotMatch(flow, /isTransitioning|setIsTransitioning/);
  assert.doesNotMatch(flow, /orderFlow\.settingUpOrder/);
});

test('«Service» holds the blurred backdrop until the appointment window is in the page', () => {
  const dashboard = read('components', 'OrderDashboard.tsx');
  const handler = sliceBetween(dashboard, 'const handleSelectServiceFlow = () => {', '};');
  assert.match(handler, /setShowOrderTypeModal\(false\);/);
  assert.match(handler, /setServicesCreatePending\(true\);/);
  assert.match(handler, /setActiveTab\("services"\);/);
  assert.match(handler, /setServicesOpenCreateSignal\(\(n\) => n \+ 1\);/);

  assert.match(
    dashboard,
    /<ModalBackdropBridge\s+active=\{servicesCreatePending\}\s+onGiveUp=\{releaseServicesCreatePending\}\s*\/>/,
  );
  assert.match(dashboard, /onCreateRequestSettled=\{handleServicesCreateSettled\}/);
  // One press opens one window: the consumed signal is cleared, so a later visit to the Services
  // tab does not open the window again.
  const settled = sliceBetween(dashboard, 'const handleServicesCreateSettled = useCallback(() => {', '}, []);');
  assert.match(settled, /setServicesCreatePending\(false\);/);
  assert.match(settled, /setServicesOpenCreateSignal\(0\);/);
});

test('the held backdrop is the modal backdrop alone: below every window, no fade-in, not a dialog', () => {
  const bridge = read('components', 'ui', 'ModalBackdropBridge.tsx');
  assert.match(bridge, /takeOverBackdrop\(entry\);/);
  assert.match(bridge, /className="liquid-glass-modal-backdrop liquid-glass-modal-backdrop--continued modal-backdrop-bridge"/);
  assert.match(bridge, /aria-hidden="true"/);
  assert.doesNotMatch(bridge, /role="dialog"/);
  assert.match(bridge, /MODAL_BACKDROP_BRIDGE_GIVE_UP_MS = 4000/);
  // A quick hand-over shows nothing; only a slow one shows a busy mark that takes no press.
  assert.match(bridge, /MODAL_BACKDROP_BRIDGE_BUSY_AFTER_MS = 400/);
  assert.match(bridge, /\{busy && \(\s*<div\s+role="status"[\s\S]*?pointer-events-none[\s\S]*?t\('common\.loading'\)/);

  const css = read('styles', 'glassmorphism.css');
  const rule = sliceBetween(css, '.liquid-glass-modal-backdrop.modal-backdrop-bridge {', '}');
  assert.match(rule, /position: fixed;/);
  assert.match(rule, /inset: var\(--app-window-frame-height, 2rem\) 0 0 0;/);
  // The appointment window sits at z-index 1000 and glass windows at 20000.
  assert.match(rule, /z-index: 999;/);
});

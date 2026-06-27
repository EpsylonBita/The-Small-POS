import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Founder rule: every modal/overlay mounts outside the page container (document.body)
// and blurs the rest of the screen. These guard the vertical-module overlays.
const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

const helperSource = read('src/renderer/utils/render-modal-portal.ts');
const appointments = read('src/renderer/pages/verticals/salon/AppointmentsView.tsx');
const reservations = read('src/renderer/pages/verticals/restaurant/ReservationsView.tsx');
const rooms = read('src/renderer/pages/verticals/hotel/RoomsView.tsx');
const guestBilling = read('src/renderer/pages/verticals/hotel/GuestBillingView.tsx');

const importsHelper = (src: string): boolean =>
  /import \{ renderModalPortal \} from '\.\.\/\.\.\/\.\.\/utils\/render-modal-portal';/.test(src) &&
  /renderModalPortal\(/.test(src);

test('renderModalPortal mounts at document.body with an SSR fallback', () => {
  assert.match(helperSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(helperSource, /return createPortal\(node, document\.body\);/);
  assert.match(helperSource, /typeof document === 'undefined' \|\| !document\.body/);
});

test('AppointmentsView booking modal portals to body with a full-screen blur backdrop', () => {
  assert.ok(importsHelper(appointments), 'AppointmentsView must use renderModalPortal');
  assert.match(appointments, /return renderModalPortal\(/);
  assert.match(appointments, /fixed inset-0 z-\[1000\][^`]*backdrop-blur-xl/);
  assert.match(appointments, /isDark \? 'bg-black\/55' : 'bg-black\/22'/);
});

test('RoomsView modal portals to body with a high-z full-screen blur overlay', () => {
  assert.ok(importsHelper(rooms), 'RoomsView must use renderModalPortal');
  assert.match(rooms, /return renderModalPortal\(/);
  assert.match(rooms, /fixed inset-0 z-\[1200\]/);
  assert.match(rooms, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
});

test('RoomsView shared Modal exposes dialog semantics so it joins the topmost-modal behavior', () => {
  // The room detail modal was a plain group/heading. The shared Modal helper must
  // declare role="dialog" + aria-modal and a labelled title (via useId) so it
  // participates in the [role="dialog"] topmost stack and is announced as a dialog.
  assert.match(rooms, /const titleId = useId\(\);/);
  assert.match(rooms, /ref=\{dialogRef\}/);
  assert.match(rooms, /role="dialog"/);
  assert.match(rooms, /aria-modal="true"/);
  assert.match(rooms, /aria-labelledby=\{titleId\}/);
  assert.match(rooms, /<h2 id=\{titleId\}/);
});

test('RoomsView shared Modal closes on Escape only when it is the topmost dialog', () => {
  // The Modal is mounted only while open, so the Escape listener needs no isOpen gate.
  assert.match(rooms, /const handleEscape = \(event: KeyboardEvent\) => \{/);
  assert.match(rooms, /if \(event\.key !== 'Escape'\) \{\s*return;\s*\}/);
  // Topmost-dialog gate (mirrors TableActionModal/ReservationForm): a dialog opened
  // above this one closes first, and an underlying modal is never dismissed instead.
  assert.match(rooms, /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/);
  assert.match(rooms, /if \(dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== dialogRef\.current\) \{/);
  // Dismisses via the close-only onClose (never a room action), and cleans up.
  assert.match(rooms, /event\.preventDefault\(\);\s*onClose\(\);/);
  assert.match(rooms, /document\.addEventListener\('keydown', handleEscape\);/);
  assert.match(rooms, /document\.removeEventListener\('keydown', handleEscape\)/);
});

test('GuestBillingView charge/payment modal portals to body with a high-z full-screen blur overlay', () => {
  assert.ok(importsHelper(guestBilling), 'GuestBillingView must use renderModalPortal');
  assert.match(guestBilling, /return renderModalPortal\(/);
  assert.match(guestBilling, /fixed inset-0 z-\[1200\]/);
  assert.match(guestBilling, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
});

test('ReservationsView create + details overlays portal to body with high z and backdrop blur', () => {
  assert.ok(importsHelper(reservations), 'ReservationsView must use renderModalPortal');
  const portalUsages = reservations.match(/renderModalPortal\(/g);
  assert.ok(portalUsages && portalUsages.length >= 2, 'both reservation overlays should portal to body');

  // The clipped low-z overlays (behind the sidebar) must be gone.
  assert.doesNotMatch(reservations, /fixed inset-0 z-40/);
  assert.doesNotMatch(reservations, /fixed inset-0 z-30/);
  const highZ = reservations.match(/fixed inset-0 z-\[1200\]/g);
  assert.ok(highZ && highZ.length >= 2, 'both overlays should use the high app-modal z-index');

  // The create/service overlays share a full-screen blurred glass backdrop.
  assert.match(reservations, /const modalScrimClass = `absolute inset-0 backdrop-blur-xl/);
  assert.match(reservations, /<div className=\{modalScrimClass\} onClick=\{\(\) => setShowCreateModal\(false\)\}/);
  assert.match(reservations, /<div className=\{modalScrimClass\} onClick=\{closeServiceModal\}/);
  // The details drawer still has its own lighter click-away blur.
  assert.match(reservations, /absolute inset-0 bg-black\/30 backdrop-blur-sm/);

  // Click-outside close behavior is preserved.
  assert.match(reservations, /onClick=\{\(\) => setShowCreateModal\(false\)\}/);
  assert.match(reservations, /onClick=\{\(\) => setSelectedReservation\(null\)\}/);
});

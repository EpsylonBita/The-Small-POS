/**
 * Module audit 2026-09-16 — desktop kitchen board pins:
 * - the fallback poll runs only while realtime is down (it used to fire every 1.5 s on top
 *   of the realtime channel and could exhaust the terminal's POS read budget mid-service);
 * - a ticket whose order carries only `owner_terminal_id` (a uuid the client cannot compare
 *   with its public terminal id) is trusted because the server already applied the scope.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(ROOT, 'src', 'renderer', 'pages', 'KitchenDisplayPage.tsx'), 'utf8')

test('the fallback poll is gated on the realtime connection and runs every 4 s', () => {
  assert.match(source, /const KDS_FALLBACK_POLL_INTERVAL_MS = 4000;/)
  assert.match(source, /if \(!autoRefresh \|\| !isIdentityReady \|\| !branchId \|\| isRealtimeConnected\) \{/)
  assert.match(source, /\}, \[autoRefresh, branchId, fetchOrders, isIdentityReady, isRealtimeConnected\]\);/)
})

test('owner-only tickets returned by the server are kept on the board', () => {
  assert.match(source, /if \(ticketOwnerTerminalId\) return true;/)
  assert.doesNotMatch(source, /ticketOwnerTerminalId === terminalId\) return true/)
})

test('elapsed hours use a locale key instead of an English literal', () => {
  assert.match(source, /t\('kitchen\.hoursAgo'/)
  assert.doesNotMatch(source, /\$\{Math\.floor\(mins \/ 60\)\}h \$\{mins % 60\}m/)
})

/**
 * Module audit 2026-09-16, revised 2026-09-28 (founder: the Windows KDS has no cloud) — desktop kitchen board pins:
 * - the board is composed from the local order store; there is no KDS API read, ticket
 *   realtime channel, fallback poll or status PATCH, so nothing can drain the POS read budget;
 * - a bump saves a local kitchen phase and never writes the canonical order status;
 * - local orders stay terminal scoped.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(ROOT, 'src', 'renderer', 'pages', 'KitchenDisplayPage.tsx'), 'utf8')

test('the board is local-only: no KDS API, realtime channel or fallback poll', () => {
  assert.doesNotMatch(source, /\/api\/pos\/kds|kds_tickets|subscriptionManager|KDS_FALLBACK_POLL_INTERVAL_MS|fetchFromAdmin|posApiFetch/)
  assert.match(source, /composeLocalKitchenOrders\(localOrders, terminalId/)
})

test('a bump saves a local kitchen phase and never writes the order status', () => {
  // The expected stage and the write resolve the same identity keys as the board read.
  assert.match(source, /await localPreparationStore\.mark\(bumpScope, current\.id, next, findLocalPreparationMark\(state, keys\)\?\.phase \?\? null, keys\)/)
  assert.doesNotMatch(source, /updateOrderStatusDetailed|updateOrderStatus\(|order_update_status|useOrderStore\.setState/)
})

test('local orders stay terminal scoped', () => {
  assert.match(source, /!isActiveLocalKitchenOrder\(record\) \|\| !matchesKdsTerminal\(terminalId, record\)/)
})

test('elapsed hours use a locale key instead of an English literal', () => {
  assert.match(source, /t\('kitchen\.hoursAgo'/)
  assert.doesNotMatch(source, /\$\{Math\.floor\(mins \/ 60\)\}h \$\{mins % 60\}m/)
})

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guards for the local-only Caller ID runtime and the retired Live
// Screen feature. The behavioral proof lives in the hook, modal and Rust
// tests; these pin the wiring so a later change cannot silently re-enable a
// cloud delivery path or a screen-capture poller.

const projectRoot = path.resolve(__dirname, '..', '..', '..')
const srcRoot = path.join(projectRoot, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' || entry === 'node_modules' ? [] : sourceFiles(full)
    }
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

const read = (...segments: string[]) =>
  readFileSync(path.join(projectRoot, ...segments), 'utf8')

describe('local-only Caller ID wiring', () => {
  it('no runtime module subscribes to cloud Caller ID delivery or posts receipts', () => {
    const cloudDeliveryModule = path.join(srcRoot, 'renderer', 'services', 'CallerIdRealtimeService.ts')
    const offenders = sourceFiles(srcRoot)
      .filter((file) => file !== cloudDeliveryModule)
      .filter((file) =>
        /subscribeToCallerIdEvents|reportCallerIdReceipt|\/api\/pos\/caller-id\/(events|lines\/)/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(projectRoot, file))

    expect(offenders).toEqual([])
  })

  it('the dashboard passes no Realtime client to the Caller ID hook', () => {
    const app = read('src', 'renderer', 'App.tsx')
    const hookCall = app.slice(app.indexOf('useCallerIdNotifications({'))
    const callBody = hookCall.slice(0, hookCall.indexOf('})'))

    expect(callBody).toContain('onOpenCustomerSearch')
    expect(callBody).not.toMatch(/realtimeClient|realtimeReady/)
  })

  it('the native runtime has no per-call publication and no fixed config poll', () => {
    const runtime = read('src-tauri', 'src', 'callerid', 'grandstream_fxo.rs')
    const production = runtime.slice(0, runtime.indexOf('#[cfg(test)]'))

    expect(production).not.toContain('/api/pos/caller-id/lines/')
    expect(production).not.toMatch(/CONFIG_POLL_INTERVAL|fn publish_event/)
    expect(production).toContain('ACTIVATION_RENEWAL_INTERVAL')
  })

  it('the call record stays on the till and never stands before the popup', () => {
    // Founder, 23/11/2026: the till keeps a 30-day local record of its calls.
    const callLog = read('src-tauri', 'src', 'callerid', 'call_log.rs')
    const record = callLog.slice(0, callLog.indexOf('#[cfg(test)]'))

    // No network client, no admin route, no outbound queue row.
    expect(record).not.toMatch(
      /reqwest|fetch_from_admin|admin_fetch|\/api\/|supabase|sync_queue|enqueue/i,
    )
    expect(record).toContain('CALL_LOG_RETENTION_DAYS: i64 = 30')

    const runtime = read('src-tauri', 'src', 'callerid', 'grandstream_fxo.rs')
    const publisher = runtime.slice(
      runtime.indexOf('async fn run_event_publisher'),
      runtime.indexOf('fn build_local_event_body'),
    )
    // The popup event goes first; the record is handed over, never awaited.
    expect(publisher.indexOf('emit_local(')).toBeGreaterThan(-1)
    expect(publisher.indexOf('record_local(CallLogEntry')).toBeGreaterThan(
      publisher.indexOf('emit_local('),
    )
    expect(publisher).not.toMatch(/record_local\([\s\S]*?\)\s*\.await/)
    // The listener, where packets are accepted and counted, does not record.
    const listener = runtime.slice(
      runtime.indexOf('async fn run_udp_line'),
      runtime.indexOf('/// Delivers each accepted call'),
    )
    expect(listener.length).toBeGreaterThan(1000)
    expect(listener).not.toMatch(/call_log|CallLogEntry|record_local/)
  })

  it('the «Πρόσφατες κλήσεις» list reads the till and stays out of the popup’s way', () => {
    // Founder, 23/11/2026: staff read the call record in a list of the till.
    const list = read('src', 'renderer', 'components', 'callerid', 'RecentCalls.tsx')
    const service = read('src', 'renderer', 'services', 'caller-id-call-record.ts')
    for (const source of [list, service]) {
      // No ear on the call event: the hook that shows the popup stays its only listener.
      expect(source).not.toMatch(/\bonEvent\s*\(|\boffEvent\s*\(|validated-local-call/)
      // The till's own record only: no admin route, no request, no interval.
      expect(source).not.toMatch(/adminFetch|posApi|fetch\s*\(|\/api\/|setInterval/)
    }
    // A row's one action is the popup's own, a customer search: never an order.
    expect(list).not.toMatch(/enqueueCallerIdOrderIntent|startOrder|addCustomer|viewCustomer/)
    expect(list).toContain('onSearchCustomer(request)')

    // The two commands exist natively and are local: the record module still
    // names no network client (asserted above for the whole module).
    const lib = read('src-tauri', 'src', 'lib.rs')
    expect(lib).toContain('commands::callerid::callerid_recent_calls,')
    expect(lib).toContain('commands::callerid::callerid_record_call_action,')
    const commands = read('src-tauri', 'src', 'commands', 'callerid.rs')
    const added = commands.slice(
      commands.indexOf('pub async fn callerid_recent_calls'),
      commands.indexOf('/// Legacy SIP configuration is read-only'),
    )
    expect(added.length).toBeGreaterThan(400)
    expect(added).not.toMatch(/reqwest|fetch_from_admin|admin_fetch|\/api\/|supabase|sync_queue/i)

    // "Order started" reaches the record through the search host's existing
    // observer, called from the app shell. The popup, the notification hook and
    // the search host are not edited for it.
    const app = read('src', 'renderer', 'App.tsx')
    expect(app).toContain('onContinueToOrderType={noteCallerIdOrderStarted}')
    expect(app).toContain('recordCallerIdOrderStarted(callerIdCustomerSearch, customer)')
    expect(app).toContain('<RecentCallsHost onSearchCustomer={openCallerIdCustomerSearch} />')
    const host = read('src', 'renderer', 'components', 'callerid', 'CallerIdCustomerSearchModalHost.tsx')
    expect(host).not.toMatch(/caller-id-call-record|recordCallAction|recentCalls/)
    for (const untouched of [
      ['src', 'renderer', 'components', 'callerid', 'CallerIdPopup.tsx'],
      ['src', 'renderer', 'hooks', 'useCallerIdNotifications.ts'],
    ]) {
      expect(read(...untouched)).not.toMatch(/caller-id-call-record|recordCallAction|recentCalls|RecentCalls/)
    }
  })
})

describe('Live Screen is retired', () => {
  it('ships no screen capture handler, prompt or IPC channel', () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) =>
        /ScreenCaptureHandler|ScreenCaptureControlRequestModal|screen-capture:|screenCapture\.|\/api\/pos\/screen-share/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(projectRoot, file))

    expect(offenders).toEqual([])
  })

  it('registers no native screen capture commands', () => {
    const lib = read('src-tauri', 'src', 'lib.rs')
    const runtime = read('src-tauri', 'src', 'commands', 'runtime.rs')

    expect(lib).not.toMatch(/screen_capture_|ScreenCaptureSignalPollingState/)
    expect(runtime).not.toMatch(/screen_capture_|screen-share/)
  })
})

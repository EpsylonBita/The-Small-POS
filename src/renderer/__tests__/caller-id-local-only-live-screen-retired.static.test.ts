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

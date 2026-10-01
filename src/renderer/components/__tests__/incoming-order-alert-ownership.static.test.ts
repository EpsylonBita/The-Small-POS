/**
 * Source contract for the incoming-order alert (Tomikro, 30/09/2026):
 * mounted once at the App level beside the routes (never inside a route, so
 * /new-order is covered too), exactly one owner of the sound loop (a module a
 * render error cannot stop), the Orders screen keeps the approval itself,
 * both use the same order scope, and the alert rings independently of the
 * efood page's own sound switch.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = path.resolve(__dirname, '..', '..')
const read = (...segments: string[]) => readFileSync(path.join(renderer, ...segments), 'utf8')

describe('incoming-order alert ownership', () => {
  it('App.tsx mounts the alert once, beside the routes and inside the router, next to the cancellation notice', () => {
    const app = read('App.tsx')
    const mount = '<IncomingOrderAlertManager enabled={Boolean(user)} />'
    expect(app.split(mount)).toHaveLength(2)
    const routesEnd = app.indexOf('</Suspense>', app.indexOf('<AppRoutes'))
    const cancellation = app.indexOf('<CancellationNoticeManager enabled={Boolean(user)} />')
    const alert = app.indexOf(mount)
    const routerEnd = app.lastIndexOf('</HashRouter>')
    expect(routesEnd).toBeGreaterThan(-1)
    expect(alert).toBeGreaterThan(routesEnd)
    expect(alert).toBeGreaterThan(cancellation)
    expect(alert).toBeLessThan(routerEnd)

    // /new-order renders without the main layout, so the layout must not be
    // the alert's home.
    const routes = read('AppRoutes.tsx')
    expect(routes).toMatch(/path="\/new-order"[\s\S]*?<NewOrderPage \/>/)
    // The routes have their own error boundary (reset by the pathname after
    // a crash), so a page that crashes never reaches the App-level boundary
    // around the alert and unmounts it.
    expect(routes).toMatch(/const \{ pathname \} = useLocation\(\);/)
    expect(routes).toMatch(/<ErrorBoundary resetKey=\{pathname\}>\s*<Routes>[\s\S]*<\/Routes>\s*<\/ErrorBoundary>/)
    const layout = read('components', 'RefactoredMainLayout.tsx')
    expect(layout).not.toMatch(/<IncomingOrderAlert|from '\.\/notices\/IncomingOrderAlert/)
    // It publishes its page for the alert instead.
    expect(layout).toMatch(/setPosLayoutView\(currentView\)/)
    expect(layout).toMatch(/setPosLayoutView\(null\)/)
    // A crashing page stays inside its own boundary.
    expect(layout).toMatch(/<ErrorBoundary>\s*\{renderCurrentView\(\)\}\s*<\/ErrorBoundary>/)
  })

  it('the sound loop lives in a module, outside the dialog and its error boundary', () => {
    const loop = read('services', 'incomingOrderAlertLoop.ts')
    const host = read('components', 'notices', 'IncomingOrderAlertHost.tsx')
    const manager = read('components', 'notices', 'IncomingOrderAlertManager.tsx')
    expect(loop).toMatch(/playSelectedPlatformSound\(/)
    expect(host).not.toMatch(/playSelectedPlatformSound|playAppAudioTones/)
    // The manager starts the loop outside the boundary that wraps the dialog.
    expect(manager).toMatch(/startIncomingOrderAlertLoop\(\)/)
    expect(manager).toMatch(/<IncomingOrderAlertBoundary resetKey=\{resetKey\} onError=\{handleRenderError\}>\s*<IncomingOrderAlertHost/)
  })

  it('the dialog never focuses a button by itself', () => {
    const host = read('components', 'notices', 'IncomingOrderAlertHost.tsx')
    expect(host).not.toMatch(/autoFocus/)
    expect(host).toMatch(/tabIndex=\{-1\}/)
    expect(host).toMatch(/motion-safe:animate-pulse/)
    expect(host).not.toMatch(/[\s"]animate-pulse/)
  })

  it('OrderDashboard no longer plays the alert: the loop module is the one owner', () => {
    const dashboard = read('components', 'OrderDashboard.tsx')
    expect(dashboard).not.toMatch(/playSelectedPlatformSound/)
    expect(dashboard).not.toMatch(/startAlertLoop|stopAlertLoop|INCOMING_ORDER_ALERT_REPEAT_MS/)
    // It still opens the approval panel for the queue head by itself …
    expect(dashboard).toMatch(/const nextOrder = scopedPendingExternalOrders\[0\];/)
    // … and re-presents it on top when the alert's «Open the order» asks.
    expect(dashboard).toMatch(/subscribeIncomingOrderApprovalFocus\(/)
    expect(dashboard).toMatch(/<OrderApprovalPanel\s+key=\{approvalPanelInstance\}/)
  })

  it('the alert and the food Orders screen share one order scope', () => {
    const food = read('components', 'dashboards', 'FoodDashboard.tsx')
    const manager = read('components', 'notices', 'IncomingOrderAlertManager.tsx')
    expect(food).toMatch(/import \{ foodOrderFilter \} from '\.\/dashboardOrderScope';/)
    expect(food).toMatch(/orderFilter=\{foodOrderFilter\}/)
    expect(manager).toMatch(/getDashboardOrderFilter\(getBusinessCategory\(businessType\)\)/)
  })

  it('rings independently of the efood page’s own sound switch', () => {
    for (const source of [
      read('services', 'incomingOrderAlert.ts'),
      read('services', 'incomingOrderAlertLoop.ts'),
      read('components', 'notices', 'IncomingOrderAlertHost.tsx'),
      read('components', 'notices', 'IncomingOrderAlertManager.tsx'),
    ]) {
      expect(source).not.toMatch(/from '[^']*efoodPartner'|useEfoodPartner/)
    }
  })
})

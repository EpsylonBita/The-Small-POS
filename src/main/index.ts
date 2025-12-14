import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'
import { HeartbeatService } from './services/HeartbeatService'
import { RealtimeOrderHandler } from '../services/RealtimeOrderHandler'
import { RealtimeCustomerHandler } from '../services/RealtimeCustomerHandler'

export function setupRealtimeHandlers(args: {
  mainWindow: BrowserWindow | null,
  dbManager: DatabaseManager,
  heartbeatService: HeartbeatService,
  branchId?: string | null,
  terminalId?: string | null,
}) {
  const { mainWindow, dbManager, heartbeatService } = args

  const terminalId = (args.terminalId && args.terminalId.trim()) || heartbeatService.getTerminalId()
  const dbSvc = dbManager.getDatabaseService()
  const resolvedBranch = (args.branchId && args.branchId.trim())
    || (dbSvc?.settings?.getSetting?.('terminal', 'branch_id', null) as string | null)
    || (process.env.DEFAULT_BRANCH_ID && process.env.DEFAULT_BRANCH_ID.trim() ? process.env.DEFAULT_BRANCH_ID.trim() : null)

  const orderHandler = new RealtimeOrderHandler(resolvedBranch, terminalId, mainWindow, dbManager)
  const customerHandler = new RealtimeCustomerHandler(resolvedBranch, terminalId, mainWindow, dbManager)

  // Fire and forget; handlers manage their own channels
  orderHandler.initialize().catch(err => console.error('RealtimeOrderHandler init failed:', err))
  customerHandler.initialize().catch(err => console.error('RealtimeCustomerHandler init failed:', err))

  return {
    cleanup: async () => {
      try { await orderHandler.cleanup() } catch {}
      try { await customerHandler.cleanup() } catch {}
    }
  }
}


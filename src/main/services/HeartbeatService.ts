// POS Terminal Heartbeat Service
// Handles terminal registration, heartbeat monitoring, and sync status reporting

import { getSupabaseClient, SUPABASE_CONFIG, SUPABASE_TABLES } from '../../shared/supabase-config'
import { app, ipcMain, BrowserWindow } from 'electron'
import * as os from 'os'
import * as crypto from 'crypto'

// Import the database manager for settings
import { DatabaseManager } from '../database';

// Settings structure
interface SettingsCollection {
  [category: string]: Record<string, unknown>;
}

export interface HeartbeatData {
  terminal_id: string
  timestamp: string
  status: 'online' | 'offline' | 'error'
  version: string
  uptime: number
  memory_usage: number
  cpu_usage: number
  settings_hash: string
  sync_status: 'synced' | 'pending' | 'failed'
  pending_updates: number
  organization_id?: string
  sync_stats?: {
    driver_earnings: { pending: number; failed: number };
    staff_payments: { pending: number; failed: number };
    shift_expenses: { pending: number; failed: number };
  }
}

export interface TerminalInfo {
  terminal_id: string
  name: string
  location: string
  ip_address: string
  mac_address?: string
  version: string
  organization_id?: string
}

export interface AppControlCommand {
  id: string
  app_id: string
  command: 'shutdown' | 'restart' | 'enable' | 'disable' | 'sync_settings' | 'force_check'
  status: 'pending' | 'acknowledged' | 'executing' | 'completed' | 'failed'
  created_at: string
  acknowledged_at?: string
  executed_at?: string
  completed_at?: string
  error_message?: string
  created_by?: string
  metadata?: Record<string, unknown>
}

export class HeartbeatService {
  private heartbeatInterval: NodeJS.Timeout | null = null
  private terminalInfo: TerminalInfo | null = null
  private syncStatus: 'synced' | 'pending' | 'failed' = 'synced'
  private pendingUpdates: number = 0
  private settingsHash: string = ''
  private isRunning: boolean = false
  private startTime: number = Date.now()
  private supabase = getSupabaseClient()
  private readonly disableDirectSupabase: boolean = true
  private databaseManager: DatabaseManager | null = null
  private mainWindow: BrowserWindow | null = null
  private pendingControlState: string | null = null
  private configuredTerminalId: string | null = null

  constructor(terminalId?: string) {
    if (terminalId) {
      this.configuredTerminalId = terminalId
    }
  }

  setDatabaseManager(databaseManager: DatabaseManager): void {
    this.databaseManager = databaseManager
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private notifyRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  async initialize(): Promise<void> {
    try {
      // Generate or load terminal information
      await this.setupTerminalInfo()

      // Register terminal with admin dashboard
      await this.registerTerminal()

      // Start realtime subscriptions (commands + settings) before heartbeat
      await this.startRealtimeSubscriptions()

      // Check for pending settings on startup
      try {
        console.log('Checking for pending settings on startup...')
        await this.fetchAndApplyPendingSettings()
      } catch (settingsError) {
        console.warn('Failed to fetch pending settings on startup:', settingsError)
      }

      // Start heartbeat monitoring
      this.startHeartbeat()

    } catch (error) {
      console.error('Failed to initialize HeartbeatService:', error)
      throw error
    }
  }

  private async setupTerminalInfo(): Promise<void> {
    const hostname = os.hostname()
    const platform = os.platform()
    const arch = os.arch()
    const networkInterfaces = os.networkInterfaces()

    const dbSvc = this.databaseManager?.getDatabaseService?.()
    const savedTid = dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', null) as string | null
    const savedName = dbSvc?.settings?.getSetting?.('terminal', 'name', null) as string | null
    const savedLocation = dbSvc?.settings?.getSetting?.('terminal', 'location', null) as string | null

    let macAddress = ''
    for (const [interfaceName, addresses] of Object.entries(networkInterfaces)) {
      if (addresses && !interfaceName.includes('lo') && !interfaceName.includes('loopback')) {
        const physicalInterface = addresses.find(addr => !addr.internal && addr.mac !== '00:00:00:00:00:00')
        if (physicalInterface) {
          macAddress = physicalInterface.mac
          break
        }
      }
    }

    let terminalId: string
    if (savedTid && String(savedTid).trim()) {
      terminalId = String(savedTid).trim()
    } else if (this.configuredTerminalId && this.configuredTerminalId.trim()) {
      terminalId = this.configuredTerminalId.trim()
    } else if (process.env.TERMINAL_ID && process.env.TERMINAL_ID.trim()) {
      terminalId = process.env.TERMINAL_ID.trim()
    } else {
      const machineFingerprint = `${hostname}-${platform}-${arch}-${macAddress}`
      terminalId = `terminal-${crypto.createHash('md5').update(machineFingerprint).digest('hex').substring(0, 8)}`
    }

    let ipAddress = '127.0.0.1'
    try {
      const interfaces = os.networkInterfaces()
      for (const [name, addresses] of Object.entries(interfaces)) {
        if (addresses && !name.includes('lo')) {
          const address = addresses.find(addr => addr.family === 'IPv4' && !addr.internal)
          if (address) {
            ipAddress = address.address
            break
          }
        }
      }
    } catch (error) {
      console.warn('Could not determine IP address, using localhost:', error)
    }

    const defaultName = `POS Terminal ${terminalId.split('-')[1] || '001'}`
    const name = (savedName && String(savedName).trim()) ? String(savedName).trim() : defaultName
    const location = (savedLocation && String(savedLocation).trim()) ? String(savedLocation).trim() : (hostname || 'Unknown Location')

    const savedOrgId = dbSvc?.settings?.getSetting?.('terminal', 'organization_id', null) as string | null

    this.terminalInfo = {
      terminal_id: terminalId,
      name,
      location,
      ip_address: ipAddress,
      mac_address: macAddress || undefined,
      version: app.getVersion(),
      organization_id: savedOrgId || undefined
    }

    if (!this.databaseManager) {
      console.warn('DatabaseManager not available, skipping initial settings')
      return
    }

    const settings = {
      terminal_id: terminalId,
      name,
      location,
      organization_id: savedOrgId
    }

    await this.databaseManager.updateLocalSettings('terminal', settings)
    this.updateSettingsHash({ terminal: settings })
  }

  private async registerTerminal(): Promise<void> {
    if (this.disableDirectSupabase) {
      console.log('Skipping legacy Supabase registration; using admin dashboard /api/pos/terminal-heartbeat instead')
      return
    }
    console.warn('Legacy Supabase registration is not implemented.')
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat()
    }, 30000)

    this.sendHeartbeat()
    this.isRunning = true
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.disableDirectSupabase) {
      console.log('Skipping legacy Supabase heartbeat; using admin dashboard /api/pos/terminal-heartbeat instead')
      return
    }

    if (!this.terminalInfo) {
      console.warn('Cannot send heartbeat: terminal info not initialized')
      return
    }

    try {
      let financialStats;
      try {
        if (this.databaseManager) {
          financialStats = this.databaseManager.getDatabaseService().sync.getFinancialSyncStats();
        }
      } catch (e) {
        console.warn('Failed to get financial sync stats for heartbeat', e);
      }

      const heartbeatData: HeartbeatData = {
        terminal_id: this.terminalInfo.terminal_id,
        timestamp: new Date().toISOString(),
        status: 'online',
        version: this.terminalInfo.version,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memory_usage: this.getMemoryUsage(),
        cpu_usage: await this.getCpuUsage(),
        settings_hash: this.settingsHash,
        sync_status: this.syncStatus,
        pending_updates: this.pendingUpdates,
        organization_id: this.terminalInfo.organization_id,
        sync_stats: financialStats
      }

      if (this.pendingControlState) {
        console.log('Skipping status update to online - pending control state:', this.pendingControlState)
      } else {
        const { error: terminalError } = await this.supabase
          .from(SUPABASE_TABLES.POS_TERMINALS)
          .update({
            status: 'online',
            last_heartbeat: heartbeatData.timestamp,
            uptime: heartbeatData.uptime
          })
          .eq('terminal_id', this.terminalInfo.terminal_id)

        if (terminalError) {
          throw new Error(`Terminal update failed: ${terminalError.message}`)
        }

        // Also update sync_stats in pos_terminals if supported
        try {
          if (heartbeatData.sync_stats) {
            await this.supabase
              .from(SUPABASE_TABLES.POS_TERMINALS)
              .update({
                sync_stats: heartbeatData.sync_stats
              })
              .eq('terminal_id', this.terminalInfo.terminal_id);
          }
        } catch (e) {
          // Ignore error if column missing
          console.warn('Could not update sync_stats in pos_terminals (column might be missing)', e);
        }
      }

      const heartbeatInsert: any = {
        terminal_id: heartbeatData.terminal_id,
        timestamp: heartbeatData.timestamp,
        status: heartbeatData.status,
        version: heartbeatData.version,
        uptime: heartbeatData.uptime,
        memory_usage: heartbeatData.memory_usage,
        cpu_usage: heartbeatData.cpu_usage,
        settings_hash: heartbeatData.settings_hash,
        sync_status: heartbeatData.sync_status,
        pending_updates: heartbeatData.pending_updates
      };
      if (heartbeatData.organization_id) {
        heartbeatInsert.organization_id = heartbeatData.organization_id;
      }
      if (heartbeatData.sync_stats) {
        heartbeatInsert.sync_stats = heartbeatData.sync_stats;
      }

      const { error: heartbeatError } = await this.supabase
        .from(SUPABASE_TABLES.POS_HEARTBEATS)
        .insert(heartbeatInsert)

      if (heartbeatError) {
        console.warn('Failed to insert heartbeat record:', heartbeatError.message)
      }

      console.log('Heartbeat sent successfully for terminal:', this.terminalInfo.terminal_id)

      try {
        const pendingCommand = await this.checkForPendingCommands()
        if (pendingCommand) {
          console.log('Pending command found:', pendingCommand.command)
          await this.acknowledgeCommand(pendingCommand.id)
          await this.executeCommand(pendingCommand)
        }
      } catch (commandError) {
        console.error('Command processing failed:', commandError)
      }

    } catch (error) {
      console.error('Heartbeat failed:', error)
    }
  }

  private getMemoryUsage(): number {
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    return Math.round((usedMemory / totalMemory) * 100)
  }

  private async getCpuUsage(): Promise<number> {
    return new Promise((resolve) => {
      const startUsage = process.cpuUsage()
      setTimeout(() => {
        const currentUsage = process.cpuUsage(startUsage)
        const totalUsage = currentUsage.user + currentUsage.system
        const cpuPercent = Math.round((totalUsage / 1000000) * 100)
        resolve(Math.min(cpuPercent, 100))
      }, 100)
    })
  }

  private async startRealtimeSubscriptions(): Promise<void> {
    if (!this.terminalInfo) return
    try {
      const terminalId = this.terminalInfo.terminal_id

      this.supabase
        .channel(`commands-${terminalId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: SUPABASE_TABLES.APP_CONTROL_COMMANDS,
          filter: `app_id=eq.${terminalId}`
        }, async (payload: any) => {
          const row = payload.new as AppControlCommand
          if (row && row.status === 'pending') {
            try {
              await this.acknowledgeCommand(row.id)
              await this.executeCommand(row)
            } catch (err) {
              console.error('Realtime command handling failed:', err)
            }
          }
        })
        .subscribe()

      this.supabase
        .channel(`settings-${terminalId}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'pos_configurations',
          filter: `terminal_id=eq.${terminalId}`
        }, async (_payload: any) => {
          try {
            await this.fetchAndApplyPendingSettings()
          } catch (err) {
            console.error('Realtime settings sync failed:', err)
          }
        })
        .subscribe()

      console.log('Realtime subscriptions started for terminal:', terminalId)
    } catch (error) {
      console.error('Failed to start realtime subscriptions:', error)
    }
  }

  private async fetchAndApplyPendingSettings(): Promise<void> {
    if (!this.terminalInfo) return

    try {
      const terminalId = this.terminalInfo.terminal_id
      const { data, error } = await this.supabase
        .from('pos_configurations')
        .select('*')
        .eq('terminal_id', terminalId)
        .eq('sync_status', 'pending')

      if (error) throw error
      if (!data || data.length === 0) return

      const grouped: Record<string, Record<string, unknown>> = {}
      for (const row of data as any[]) {
        const cat = row.setting_category
        const key = row.setting_key
        if (!grouped[cat]) grouped[cat] = {}
        grouped[cat][key] = row.setting_value

        // Check if organization_id changed in settings
        if (cat === 'terminal' && key === 'organization_id' && row.setting_value) {
          const newOrgId = String(row.setting_value)
          if (newOrgId !== this.terminalInfo.organization_id) {
            console.log('Organization ID updated from settings:', newOrgId)
            this.terminalInfo.organization_id = newOrgId
          }
        }
      }

      await this.handlePendingSettings(grouped as SettingsCollection)

      const { error: markErr } = await this.supabase
        .from('pos_configurations')
        .update({ sync_status: 'synced', last_sync_at: new Date().toISOString() })
        .eq('terminal_id', terminalId)
        .eq('sync_status', 'pending')

      if (markErr) {
        console.warn('Failed to mark settings as synced:', markErr.message)
      }

      console.log('Pending settings applied for terminal:', terminalId)
    } catch (error) {
      console.error('Failed to fetch/apply pending settings:', error)
      try {
        if (this.terminalInfo) {
          const { error: failErr } = await this.supabase
            .from('pos_configurations')
            .update({ sync_status: 'failed' })
            .eq('terminal_id', this.terminalInfo.terminal_id)
            .eq('sync_status', 'pending')
          if (failErr) console.warn('Also failed to mark settings as failed:', failErr.message)
        }
      } catch { }
    }
  }

  private async handlePendingSettings(settings: SettingsCollection): Promise<void> {
    if (!this.databaseManager) return

    for (const [category, categorySettings] of Object.entries(settings)) {
      await this.databaseManager.updateLocalSettings(category, categorySettings)
    }

    this.updateSettingsHash(settings)
  }

  private updateSettingsHash(settings: SettingsCollection): void {
    const settingsString = JSON.stringify(settings, Object.keys(settings).sort())
    this.settingsHash = crypto.createHash('md5').update(settingsString).digest('hex')
  }

  // Command polling and execution methods
  private async checkForPendingCommands(): Promise<AppControlCommand | null> {
    if (!this.terminalInfo) {
      return null
    }

    try {
      const { data, error } = await this.supabase
        .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
        .select('*')
        .eq('app_id', this.terminalInfo.terminal_id)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (error) {
        throw error
      }

      return data as AppControlCommand | null
    } catch (error) {
      console.error('Failed to check for pending commands:', error)
      return null
    }
  }

  private async acknowledgeCommand(commandId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
        .update({
          status: 'acknowledged',
          acknowledged_at: new Date().toISOString()
        })
        .eq('id', commandId)

      if (error) {
        throw error
      }

      console.log('Command acknowledged:', commandId)
    } catch (error) {
      console.error('Failed to acknowledge command:', error)
      throw error
    }
  }

  private async executeCommand(command: AppControlCommand): Promise<void> {
    if (!this.terminalInfo) {
      const error = new Error('Terminal info not initialized')
      console.error('Execute command failed:', error)
      throw error
    }

    try {
      // Update command status to executing
      const { error: executingError } = await this.supabase
        .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
        .update({
          status: 'executing',
          executed_at: new Date().toISOString()
        })
        .eq('id', command.id)

      if (executingError) {
        throw new Error(`Failed to update command status to executing: ${executingError.message}`)
      }

      console.log('Executing command:', command.command)

      // Execute the command based on type
      switch (command.command) {
        case 'shutdown':
          await this.handleShutdownCommand(command)
          break
        case 'restart':
          await this.handleRestartCommand(command)
          break
        case 'disable':
          await this.handleDisableCommand(command)
          break
        case 'enable':
          await this.handleEnableCommand(command)
          break
        case 'sync_settings':
          await this.fetchAndApplyPendingSettings()
          break
        case 'force_check':
          await this.forceCommandCheck()
          break
        default:
          throw new Error(`Unknown command: ${command.command}`)
      }

      // Update command status to completed
      const { error: completedError } = await this.supabase
        .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', command.id)

      if (completedError) {
        console.error('Failed to update command status to completed:', completedError)
        // Don't throw here - command executed successfully
      }

      // Update terminal's last_command_at timestamp
      const { error: terminalError } = await this.supabase
        .from(SUPABASE_TABLES.POS_TERMINALS)
        .update({
          last_command_at: new Date().toISOString()
        })
        .eq('terminal_id', this.terminalInfo.terminal_id)

      if (terminalError) {
        console.error('Failed to update terminal last_command_at:', terminalError)
        // Don't throw here - command executed successfully
      }

      console.log('Command completed successfully:', command.command)

    } catch (error) {
      console.error('Command execution failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Notify renderer of command failure
      this.notifyRenderer('control-command-failed', {
        command: command.command,
        error: errorMessage,
        timestamp: new Date().toISOString()
      })

      // Update command status to failed
      try {
        const { error: failedError } = await this.supabase
          .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage
          })
          .eq('id', command.id)

        if (failedError) {
          console.error('Failed to update command status to failed:', failedError)
        }
      } catch (updateError) {
        console.error('Failed to update command failure status:', updateError)
      }

      throw error
    }
  }

  private async handleShutdownCommand(command: AppControlCommand): Promise<void> {
    console.log('Initiating graceful shutdown...')

    // Notify renderer before updating status
    this.notifyRenderer('control-command-received', {
      type: 'shutdown',
      message: 'Shutdown command received from admin dashboard. Application will close in a few seconds...',
      timestamp: new Date().toISOString()
    })

    // Set pending control state to prevent heartbeat from overriding
    this.pendingControlState = 'shutdown_pending'

    // Update terminal control status
    const { error } = await this.supabase
      .from(SUPABASE_TABLES.POS_TERMINALS)
      .update({
        control_status: 'shutdown_pending',
        status: 'offline'
      })
      .eq('terminal_id', this.terminalInfo!.terminal_id)

    if (error) {
      console.error('Failed to update terminal status:', error)
      // Continue with shutdown even if update fails
    }

    // Add 2-second delay to allow database update to propagate to admin dashboard
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Emit process event for main to handle graceful shutdown
    // @ts-ignore - Custom event type
    process.emit('pos-control-command', { type: 'shutdown', commandId: command.id })
  }

  private async handleRestartCommand(command: AppControlCommand): Promise<void> {
    console.log('Initiating application restart...')

    // Notify renderer before updating status
    this.notifyRenderer('control-command-received', {
      type: 'restart',
      message: 'Restart command received from admin dashboard. Application will restart in a few seconds...',
      timestamp: new Date().toISOString()
    })

    // Set pending control state to prevent heartbeat from overriding
    this.pendingControlState = 'restart_pending'

    // Update terminal control status
    const { error } = await this.supabase
      .from(SUPABASE_TABLES.POS_TERMINALS)
      .update({
        control_status: 'restart_pending',
        status: 'offline'
      })
      .eq('terminal_id', this.terminalInfo!.terminal_id)

    if (error) {
      console.error('Failed to update terminal status:', error)
      // Continue with restart even if update fails
    }

    // Add 2-second delay to allow database update to propagate to admin dashboard
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Emit process event for main to handle graceful restart
    // @ts-ignore - Custom event type
    process.emit('pos-control-command', { type: 'restart', commandId: command.id })
  }

  private async handleDisableCommand(command: AppControlCommand): Promise<void> {
    console.log('Disabling terminal...')

    // Set pending control state
    this.pendingControlState = 'disabled'

    // Update terminal control status to disabled
    const { error } = await this.supabase
      .from(SUPABASE_TABLES.POS_TERMINALS)
      .update({
        control_status: 'disabled',
        status: 'offline'
      })
      .eq('terminal_id', this.terminalInfo!.terminal_id)

    if (error) {
      console.error('Failed to update terminal status:', error)
    }

    // Emit process event for main to handle
    // @ts-ignore - Custom event type
    process.emit('pos-control-command', { type: 'disable', commandId: command.id })

    // Stop heartbeat service
    this.stop()
  }

  private async handleEnableCommand(command: AppControlCommand): Promise<void> {
    console.log('Enabling terminal...')

    // Clear pending control state
    this.pendingControlState = null

    // Update terminal control status to idle
    const { error } = await this.supabase
      .from(SUPABASE_TABLES.POS_TERMINALS)
      .update({
        control_status: 'idle',
        status: 'online'
      })
      .eq('terminal_id', this.terminalInfo!.terminal_id)

    if (error) {
      console.error('Failed to update terminal status:', error)
    }

    // Emit process event for main to handle
    // @ts-ignore - Custom event type
    process.emit('pos-control-command', { type: 'enable', commandId: command.id })

    // Resume heartbeat if not running
    if (!this.isRunning) {
      this.startHeartbeat()
    }
  }

  // Public methods for other services to interact with
  setSyncStatus(status: 'synced' | 'pending' | 'failed'): void {
    this.syncStatus = status
  }

  setPendingUpdates(count: number): void {
    this.pendingUpdates = count
  }

  getTerminalId(): string {
    return this.terminalInfo?.terminal_id || 'unknown'
  }

  getSyncStatus(): 'synced' | 'pending' | 'failed' {
    return this.syncStatus
  }

  getOrganizationId(): string | undefined {
    return this.terminalInfo?.organization_id
  }

  // Force command check (useful for testing)
  async forceCommandCheck(): Promise<void> {
    try {
      const pendingCommand = await this.checkForPendingCommands()
      if (pendingCommand) {
        console.log('Force check - pending command found:', pendingCommand.command)
        await this.acknowledgeCommand(pendingCommand.id)
        await this.executeCommand(pendingCommand)
      } else {
        console.log('Force check - no pending commands')
      }
    } catch (error) {
      console.error('Force command check failed:', error)
      throw error
    }
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.isRunning = false
  }

  isActive(): boolean {
    return this.isRunning
  }

  // Force a heartbeat (useful for testing or immediate sync)
  async forceHeartbeat(): Promise<void> {
    await this.sendHeartbeat()
  }

  // Mark command as completed
  async markCommandCompleted(commandId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from(SUPABASE_TABLES.APP_CONTROL_COMMANDS)
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', commandId)

      if (error) {
        console.error('Failed to mark command as completed:', error)
        throw error
      }

      console.log('Command marked as completed:', commandId)
    } catch (error) {
      console.error('Error marking command as completed:', error)
      throw error
    }
  }
}
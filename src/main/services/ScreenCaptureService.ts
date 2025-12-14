/**
 * ScreenCaptureService
 * 
 * Manages screen capture requests and coordinates with renderer process
 * Uses Supabase Realtime to listen for admin requests
 */

import { BrowserWindow } from 'electron'
import { SupabaseClient } from '@supabase/supabase-js'

export class ScreenCaptureService {
  private terminalId: string
  private supabase: SupabaseClient
  private mainWindow: BrowserWindow | null = null
  private activeRequestId: string | null = null

  constructor(terminalId: string, supabase: SupabaseClient) {
    this.terminalId = terminalId
    this.supabase = supabase
  }

  /**
   * Initialize screen capture service
   */
  async initialize(): Promise<void> {
    console.log('[ScreenCapture] Service initialized for terminal:', this.terminalId)
    
    // Listen for remote streaming requests from admin dashboard
    await this.setupRealtimeListener()
  }

  /**
   * Set main window reference for sending IPC messages
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Listen for screen share requests via Supabase Realtime
   */
  private async setupRealtimeListener(): Promise<void> {
    // Subscribe to screen_share_requests table for this terminal
    this.supabase
      .channel(`screen_share_requests:${this.terminalId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'screen_share_requests',
          filter: `terminal_id=eq.${this.terminalId}`
        },
        async (payload) => {
          console.log('[ScreenCapture] Received screen share request:', payload)
          
          if (payload.new && payload.new.status === 'requested') {
            const requestId = payload.new.id
            const adminSessionId = payload.new.admin_session_id
            
            // Start streaming by notifying renderer
            await this.startStreaming(requestId, adminSessionId)
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'screen_share_requests',
          filter: `terminal_id=eq.${this.terminalId}`
        },
        async (payload) => {
          // Check if request was stopped
          if (payload.new && payload.new.status === 'stopped') {
            await this.stopStreaming()
          }
        }
      )
      .subscribe()
  }

  /**
   * Start streaming by notifying renderer process
   */
  private async startStreaming(requestId: string, adminSessionId: string): Promise<void> {
    try {
      console.log('[ScreenCapture] Starting screen stream...')
      
      this.activeRequestId = requestId

      // Send IPC message to renderer to start screen capture
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('screen-capture:start', {
          requestId,
          adminSessionId,
          terminalId: this.terminalId
        })
      } else {
        throw new Error('Main window not available')
      }

      // Update request status to 'streaming'
      await this.supabase
        .from('screen_share_requests')
        .update({ 
          status: 'streaming',
          started_at: new Date().toISOString()
        })
        .eq('id', requestId)

      console.log('[ScreenCapture] Screen stream request sent to renderer')

    } catch (error) {
      console.error('[ScreenCapture] Failed to start streaming:', error)
      
      // Update request status to 'failed'
      await this.supabase
        .from('screen_share_requests')
        .update({ 
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error'
        })
        .eq('id', requestId)
    }
  }

  /**
   * Stop streaming (public method for IPC handler)
   */
  async stopStreaming(): Promise<void> {
    console.log('[ScreenCapture] Stopping screen stream...')

    // Send IPC message to renderer to stop screen capture
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('screen-capture:stop')
    }

    this.activeRequestId = null
    console.log('[ScreenCapture] Screen stream stopped')
  }

  /**
   * Get streaming status
   */
  getStatus(): { isStreaming: boolean; requestId: string | null } {
    return {
      isStreaming: this.activeRequestId !== null,
      requestId: this.activeRequestId
    }
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    await this.stopStreaming()
  }
}

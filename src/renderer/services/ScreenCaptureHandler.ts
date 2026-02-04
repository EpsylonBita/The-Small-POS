import { getSupabaseClient } from '../../shared/supabase-config'

interface ScreenCaptureConfig {
  requestId: string
  adminSessionId: string
  terminalId: string
}

class ScreenCaptureHandler {
  private peerConnection: RTCPeerConnection | null = null
  private screenStream: MediaStream | null = null
  private supabase: any
  private config: ScreenCaptureConfig | null = null
  private isStreaming = false
  private isStarting = false
  private answerChannel: any | null = null
  private answerSet = false
  private pendingCandidates: any[] = []
  private controlChannel: RTCDataChannel | null = null

  constructor() {
    this.supabase = getSupabaseClient()
    this.setupIPCListeners()
  }

  private setupIPCListeners(): void {
    const electron = (window as any).electron
    if (!electron) {
      console.warn('[ScreenCapture] Electron IPC not available')
      return
    }

    electron.ipcRenderer.on('screen-capture:start', async (data: ScreenCaptureConfig) => {
      console.log('[ScreenCapture] Received start command:', data)
      await this.startCapture(data)
    })

    electron.ipcRenderer.on('screen-capture:stop', async () => {
      console.log('[ScreenCapture] Received stop command')
      await this.stopCapture()
    })
  }

  private async startCapture(config: ScreenCaptureConfig): Promise<void> {
    if (this.isStreaming || this.isStarting) {
      console.log('[ScreenCapture] Already streaming/starting, ignoring request')
      return
    }

    this.isStarting = true
    this.config = config

    try {
      // SECURITY: Use IPC-based screen capture that shows user consent dialog
      // This ensures the user is aware and consents to screen capture enumeration
      let primaryScreenId: string | null = null
      try {
        const electron = (window as any).electron
        if (electron?.ipcRenderer?.invoke) {
          const result = await electron.ipcRenderer.invoke('screen-capture:get-sources', { types: ['screen'] })
          if (result?.success && result.sources?.length > 0) {
            // Prefer the source whose display_id matches primary display (if exposed)
            const primary = result.sources.find((s: any) => (s as any)?.display_id === 'primary') || result.sources[0]
            primaryScreenId = primary.id
          } else if (!result?.success) {
            throw new Error(result?.error || 'User denied screen capture access')
          }
        }
      } catch (dcErr) {
        console.warn('[ScreenCapture] Failed to get sources with consent:', dcErr)
        // SECURITY: Don't fall through to getDisplayMedia without consent - propagate error
        throw dcErr
      }

      let stream: MediaStream | null = null
      if (primaryScreenId) {
        try {
          stream = await (navigator.mediaDevices as any).getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: primaryScreenId,
                minWidth: 640,
                maxWidth: 1920,
                minHeight: 480,
                maxHeight: 1080,
                frameRate: 10
              }
            }
          })
        } catch (e) {
          console.warn('[ScreenCapture] getUserMedia desktop path failed', e)
        }
      }

      if (!stream) {
        // SECURITY: getDisplayMedia shows its own browser-native consent dialog
        // This is acceptable as it requires explicit user interaction to select a screen
        const mediaDevices: any = (navigator.mediaDevices as any)
        if (typeof mediaDevices?.getDisplayMedia === 'function') {
          // Call directly to preserve correct this binding and avoid Illegal invocation
          stream = await mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false })
        } else {
          throw new Error('Neither desktop capture nor getDisplayMedia is available')
        }
      }

      this.screenStream = stream
      await this.setupWebRTC()
      this.isStreaming = true
      this.isStarting = false
      console.log('[ScreenCapture] Streaming started')
    } catch (error) {
      console.error('[ScreenCapture] Failed to start capture:', error)
      if (this.config && this.supabase) {
        await this.supabase
          .from('screen_share_requests')
          .update({ status: 'failed', error_message: error instanceof Error ? error.message : 'Unknown error' })
          .eq('id', this.config.requestId)
      }
      this.isStreaming = false
      this.isStarting = false
      this.config = null
    }
  }

  private async setupWebRTC(): Promise<void> {
    if (!this.config || !this.screenStream) throw new Error('Missing config or screen stream')

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    })

    this.screenStream.getTracks().forEach(track => {
      this.peerConnection!.addTrack(track, this.screenStream!)
    })

    this.peerConnection.ondatachannel = (ev) => {
      if (ev.channel.label === 'control') {
        this.controlChannel = ev.channel
        this.controlChannel.onmessage = (msg) => this.handleControlMessage(msg.data)
        this.controlChannel.onopen = () => console.log('[ScreenCapture] Control channel open')
        this.controlChannel.onclose = () => console.log('[ScreenCapture] Control channel closed')
        this.controlChannel.onerror = (e) => console.warn('[ScreenCapture] Control channel error', e)
      }
    }

    this.answerSet = false
    this.pendingCandidates = []

    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.config) {
        await this.supabase
          .from('screen_share_signals')
          .insert({ request_id: this.config.requestId, type: 'candidate', data: event.candidate, sender: 'terminal' })
      }
    }

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState
      console.log('[ScreenCapture] Connection state:', state)
      if (state === 'disconnected' || state === 'failed') {
        this.stopCapture()
      }
    }

    const offer = await this.peerConnection.createOffer()
    await this.peerConnection.setLocalDescription(offer)

    await this.supabase
      .from('screen_share_signals')
      .insert({ request_id: this.config.requestId, type: 'offer', data: offer, sender: 'terminal' })

    console.log('[ScreenCapture] WebRTC offer sent')
    this.listenForWebRTCAnswer()
  }

  private listenForWebRTCAnswer(): void {
    if (!this.config) return
    if (this.answerChannel) return

    this.answerChannel = this.supabase
      .channel(`screen_share_signals:${this.config.requestId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'screen_share_signals', filter: `request_id=eq.${this.config.requestId}` },
        async (payload: any) => {
          if (payload.new && payload.new.sender === 'admin') {
            const signalData = payload.new.data
            if (payload.new.type === 'answer') {
              try {
                await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(signalData))
                this.answerSet = true
                if (this.pendingCandidates.length) {
                  for (const cand of this.pendingCandidates) {
                    try { await this.peerConnection?.addIceCandidate(new RTCIceCandidate(cand)) } catch (iceErr) {
                      console.warn('[ScreenCapture] Failed to add queued ICE candidate', iceErr)
                    }
                  }
                  this.pendingCandidates = []
                }
              } catch (err) {
                console.error('[ScreenCapture] setRemoteDescription failed', err)
              }
            } else if (payload.new.type === 'candidate') {
              if (this.peerConnection) {
                if (this.answerSet || this.peerConnection.remoteDescription) {
                  try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(signalData)) } catch (iceErr) {
                    console.warn('[ScreenCapture] addIceCandidate failed (will queue)', iceErr)
                    this.pendingCandidates.push(signalData)
                  }
                } else {
                  this.pendingCandidates.push(signalData)
                }
              }
            }
          }
        }
      )
      .subscribe()
  }

  private handleControlMessage(_raw: any): void {
    // SECURITY: Remote input injection is disabled for security reasons.
    // The input:inject IPC handler was removed from the preload allowlist
    // and disabled in screen-capture-handlers.ts because it allowed arbitrary
    // keyboard/mouse input injection which could be exploited by attackers.
    //
    // If remote support is required in the future, implement specific
    // validated actions instead (e.g., remote-support:click-button with
    // element ID validation, or a restricted command set).
    console.warn('[ScreenCapture] Remote input is disabled for security reasons')
  }

  private async stopCapture(): Promise<void> {
    console.log('[ScreenCapture] Stopping capture...')
    this.isStreaming = false
    this.isStarting = false

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop())
      this.screenStream = null
    }

    if (this.peerConnection) {
      this.peerConnection.close()
      this.peerConnection = null
    }

    if (this.answerChannel) {
      try { await this.answerChannel.unsubscribe() } catch {}
      this.answerChannel = null
    }

    this.config = null
    this.answerSet = false
    this.pendingCandidates = []
  }

  cleanup(): void {
    this.stopCapture()
  }
}

export const screenCaptureHandler = new ScreenCaptureHandler()
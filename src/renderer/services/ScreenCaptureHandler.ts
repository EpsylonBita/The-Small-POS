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
      let primaryScreenId: string | null = null
      try {
        const dc = (window as any).electron?.desktopCapturer
        if (dc?.getSources) {
          const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
          if (sources && sources.length > 0) {
            // Prefer the source whose display_id matches primary display (if exposed)
            const primary = sources.find((s: any) => (s as any)?.display_id === 'primary') || sources[0]
            primaryScreenId = primary.id
          }
        }
      } catch (dcErr) {
        console.warn('[ScreenCapture] desktopCapturer.getSources failed; fallback to getDisplayMedia', dcErr)
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

  private handleControlMessage(raw: any): void {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw
      const electron = (window as any).electron
      if (!electron) return
      const t = msg?.t
      if (t === 'mm') {
        electron.ipcRenderer.invoke('input:inject', { type: 'mouseMove', x: msg.x, y: msg.y, normalized: true })
      } else if (t === 'md') {
        electron.ipcRenderer.invoke('input:inject', { type: 'mouseDown', button: ['left','middle','right'][msg.b || 0], x: msg.x, y: msg.y, normalized: true })
      } else if (t === 'mu') {
        electron.ipcRenderer.invoke('input:inject', { type: 'mouseUp', button: ['left','middle','right'][msg.b || 0], x: msg.x, y: msg.y, normalized: true })
      } else if (t === 'mw') {
        electron.ipcRenderer.invoke('input:inject', { type: 'mouseWheel', deltaX: msg.dx || 0, deltaY: msg.dy || 0 })
      } else if (t === 'kd') {
        electron.ipcRenderer.invoke('input:inject', { type: 'keyDown', keyCode: msg.k, code: msg.c })
      } else if (t === 'ku') {
        electron.ipcRenderer.invoke('input:inject', { type: 'keyUp', keyCode: msg.k, code: msg.c })
      }
    } catch (e) {
      console.warn('[ScreenCapture] Failed to handle control message', e)
    }
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
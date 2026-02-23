import { getBridge, offEvent, onEvent } from '../../lib'
import type { ScreenCaptureSignal, ScreenCaptureSignalBatchPayload } from '../../lib/ipc-contracts'

interface ScreenCaptureConfig {
  requestId: string
  adminSessionId: string
  terminalId: string
}

class ScreenCaptureHandler {
  private peerConnection: RTCPeerConnection | null = null
  private screenStream: MediaStream | null = null
  private config: ScreenCaptureConfig | null = null
  private isStreaming = false
  private isStarting = false
  private answerChannel: { unsubscribe: () => Promise<void> } | null = null
  private answerSet = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private lastSignalTimestamp: string | null = null
  private seenSignalIds = new Set<string>()
  private controlChannel: RTCDataChannel | null = null
  private eventUnsubscribers: Array<() => void> = []
  private bridge = getBridge()

  constructor() {
    this.setupIPCListeners()
  }

  private async fetchFromAdmin(path: string, options?: { method?: string; body?: unknown }): Promise<any> {
    const result = await this.bridge.adminApi.fetchFromAdmin(path, options)
    if (!result?.success) {
      throw new Error(result?.error || `Admin API request failed for ${path}`)
    }
    return result?.data ?? result
  }

  private async sendSignal(requestId: string, type: 'offer' | 'candidate', data: unknown): Promise<void> {
    const payload = await this.fetchFromAdmin('/api/pos/screen-share/terminal', {
      method: 'POST',
      body: { requestId, type, data },
    })

    if (payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `Failed to send ${type} signal`)
    }
  }

  private async updateRequestStatus(
    requestId: string,
    status: 'active' | 'failed' | 'stopped',
    errorMessage?: string
  ): Promise<void> {
    const payload = await this.fetchFromAdmin('/api/pos/screen-share/terminal', {
      method: 'PATCH',
      body: {
        requestId,
        status,
        errorMessage: errorMessage || null,
      },
    })

    if (payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `Failed to set status ${status}`)
    }
  }

  private async applyIncomingSignals(signals: ScreenCaptureSignal[]): Promise<void> {
    for (const signal of signals) {
      if (!signal?.id || this.seenSignalIds.has(signal.id)) {
        continue
      }

      this.seenSignalIds.add(signal.id)

      if (typeof signal.created_at === 'string') {
        if (!this.lastSignalTimestamp || signal.created_at > this.lastSignalTimestamp) {
          this.lastSignalTimestamp = signal.created_at
        }
      }

      if (signal.sender !== 'admin') {
        continue
      }

      const signalData = signal.data
      if (!signalData || typeof signalData !== 'object') {
        continue
      }

      if (signal.type === 'answer') {
        try {
          await this.peerConnection?.setRemoteDescription(
            new RTCSessionDescription(signalData as RTCSessionDescriptionInit)
          )
          this.answerSet = true
          if (this.pendingCandidates.length) {
            for (const cand of this.pendingCandidates) {
              try {
                await this.peerConnection?.addIceCandidate(new RTCIceCandidate(cand))
              } catch (iceErr) {
                console.warn('[ScreenCapture] Failed to add queued ICE candidate', iceErr)
              }
            }
            this.pendingCandidates = []
          }
        } catch (err) {
          console.error('[ScreenCapture] setRemoteDescription failed', err)
        }
      } else if (signal.type === 'candidate') {
        if (this.peerConnection) {
          if (this.answerSet || this.peerConnection.remoteDescription) {
            try {
              await this.peerConnection.addIceCandidate(
                new RTCIceCandidate(signalData as RTCIceCandidateInit)
              )
            } catch (iceErr) {
              console.warn('[ScreenCapture] addIceCandidate failed (will queue)', iceErr)
              this.pendingCandidates.push(signalData as RTCIceCandidateInit)
            }
          } else {
            this.pendingCandidates.push(signalData as RTCIceCandidateInit)
          }
        }
      }
    }
  }

  private async handleSignalBatchPayload(payload: ScreenCaptureSignalBatchPayload): Promise<void> {
    if (typeof payload?.lastSignalTimestamp === 'string') {
      if (!this.lastSignalTimestamp || payload.lastSignalTimestamp > this.lastSignalTimestamp) {
        this.lastSignalTimestamp = payload.lastSignalTimestamp
      }
    }

    const requestStatus = typeof payload?.request?.status === 'string'
      ? payload.request.status
      : null
    if (requestStatus === 'stopped' || requestStatus === 'failed') {
      if (this.isStreaming || this.isStarting) {
        void this.stopCapture({ status: requestStatus })
      }
      return
    }

    const signals = Array.isArray(payload?.signals) ? payload.signals : []
    if (signals.length === 0) {
      return
    }

    await this.applyIncomingSignals(signals)
  }

  private setupIPCListeners(): void {
    const startHandler = async (data: ScreenCaptureConfig) => {
      console.log('[ScreenCapture] Received start command:', data)
      await this.startCapture(data)
    }

    const stopHandler = async () => {
      console.log('[ScreenCapture] Received stop command')
      await this.stopCapture()
    }

    onEvent('screen-capture:start', startHandler)
    onEvent('screen-capture:stop', stopHandler)
    this.eventUnsubscribers.push(() => offEvent('screen-capture:start', startHandler))
    this.eventUnsubscribers.push(() => offEvent('screen-capture:stop', stopHandler))
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
        const result = await this.bridge.screenCapture.getSources({ types: ['screen'] })
        const sources = Array.isArray(result?.sources) ? result.sources : []
        if (result?.success && sources.length > 0) {
          // Prefer the source whose display_id matches primary display (if exposed)
          const primary = sources.find((s) => s?.display_id === 'primary') || sources[0]
          primaryScreenId = primary.id
        } else if (!result?.success) {
          throw new Error(result?.error || 'User denied screen capture access')
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
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown capture startup error'
      await this.stopCapture({ status: 'failed', errorMessage })
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
    this.lastSignalTimestamp = null
    this.seenSignalIds.clear()

    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.config) {
        try {
          await this.sendSignal(this.config.requestId, 'candidate', event.candidate)
        } catch (signalError) {
          console.warn('[ScreenCapture] Failed to send ICE candidate', signalError)
        }
      }
    }

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState
      console.log('[ScreenCapture] Connection state:', state)
      if (state === 'disconnected' || state === 'failed') {
        void this.stopCapture()
      }
    }

    const offer = await this.peerConnection.createOffer()
    await this.peerConnection.setLocalDescription(offer)

    const localOffer = this.peerConnection.localDescription
      ? { type: this.peerConnection.localDescription.type, sdp: this.peerConnection.localDescription.sdp }
      : { type: offer.type, sdp: offer.sdp }

    await this.sendSignal(this.config.requestId, 'offer', localOffer)
    await this.updateRequestStatus(this.config.requestId, 'active')

    console.log('[ScreenCapture] WebRTC offer sent')
    this.listenForWebRTCAnswer()
  }

  private listenForWebRTCAnswer(): void {
    if (!this.config) return
    if (this.answerChannel) return

    const requestId = this.config.requestId
    const signalBatchHandler = (payload: ScreenCaptureSignalBatchPayload) => {
      if (payload?.requestId && payload.requestId !== requestId) {
        return
      }
      void this.handleSignalBatchPayload(payload)
    }
    const signalPollErrorHandler = (payload: any) => {
      if (payload?.requestId && payload.requestId !== requestId) {
        return
      }
      console.warn('[ScreenCapture] Native signal polling error', payload?.error || payload)
    }
    const signalPollStoppedHandler = (payload: { requestId?: string }) => {
      if (payload?.requestId && payload.requestId !== requestId) {
        return
      }
      if (this.isStreaming || this.isStarting) {
        console.warn('[ScreenCapture] Native signal polling stopped unexpectedly')
        void this.stopCapture({
          status: 'failed',
          errorMessage: 'Native signal polling stopped unexpectedly',
        })
      }
    }

    onEvent('screen-capture:signal-batch', signalBatchHandler)
    onEvent('screen-capture:signal-poll-error', signalPollErrorHandler)
    onEvent('screen-capture:signal-poll-stopped', signalPollStoppedHandler)

    this.answerChannel = {
      unsubscribe: async () => {
        offEvent('screen-capture:signal-batch', signalBatchHandler)
        offEvent('screen-capture:signal-poll-error', signalPollErrorHandler)
        offEvent('screen-capture:signal-poll-stopped', signalPollStoppedHandler)
        try {
          await this.bridge.screenCapture.stopSignalPolling(requestId)
        } catch (stopError) {
          console.warn('[ScreenCapture] Failed to stop native signal polling', stopError)
        }
      },
    }

    void (async () => {
      try {
        const result = await this.bridge.screenCapture.startSignalPolling(
          requestId,
          this.lastSignalTimestamp || undefined
        )
        if (result?.success === false) {
          throw new Error(result?.error || 'Native screen-share signal polling start rejected')
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Native screen-share signal polling failed'
        console.error('[ScreenCapture] Native polling start failed', error)
        try {
          await this.updateRequestStatus(requestId, 'failed', errorMessage)
        } catch (statusError) {
          console.warn('[ScreenCapture] Failed to report native polling startup failure', statusError)
        }
        await this.stopCapture({ status: null })
      }
    })()
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

  private async stopCapture(options?: {
    status?: 'stopped' | 'failed' | null
    errorMessage?: string
  }): Promise<void> {
    const status = options?.status === undefined ? 'stopped' : options.status
    console.log('[ScreenCapture] Stopping capture...')
    const requestId = this.config?.requestId ?? null
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
    this.lastSignalTimestamp = null
    this.seenSignalIds.clear()

    if (requestId && status) {
      try {
        await this.updateRequestStatus(
          requestId,
          status,
          status === 'failed' ? options?.errorMessage : undefined
        )
      } catch (statusError) {
        if (status === 'failed') {
          console.warn('[ScreenCapture] Failed to mark screen share as failed', statusError)
        } else {
          console.warn('[ScreenCapture] Failed to mark screen share as stopped', statusError)
        }
      }
    }
  }

  cleanup(): void {
    this.eventUnsubscribers.forEach((unsub) => {
      try { unsub() } catch {}
    })
    this.eventUnsubscribers = []
    void this.stopCapture()
  }
}

export const screenCaptureHandler = new ScreenCaptureHandler()

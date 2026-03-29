import { emitCompatEvent, getBridge, offEvent, onEvent } from '../../lib'
import type {
  ScreenCaptureRequestState,
  ScreenCaptureSignal,
  ScreenCaptureSignalBatchPayload,
} from '../../lib/ipc-contracts'

interface ScreenCaptureConfig {
  requestId: string
  adminSessionId?: string
  terminalId: string
  remoteViewCapabilities?: Record<string, unknown> | null
}

interface TerminalSessionPayload {
  request?: (ScreenCaptureRequestState & { id?: string }) | null
  terminal?: {
    terminal_id?: string
    client_platform?: string | null
    remote_view_capabilities?: Record<string, unknown> | null
  } | null
}

type ControlAction = 'approve_control' | 'deny_control'

const CONTROL_REQUEST_EVENT = 'screen-capture:control-request'
const CONTROL_REQUEST_CLEARED_EVENT = 'screen-capture:control-request-cleared'

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
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null
  private sessionPollingEnabled = false
  private sessionPollInFlight = false
  private currentRequestState: (ScreenCaptureRequestState & { id?: string }) | null = null
  private lastControlPromptKey: string | null = null
  private lastPointerPosition = { x: 0.5, y: 0.5 }
  private reportedCapabilities: Record<string, unknown> = {
    liveView: true,
    remoteControl: true,
    requiresControlApproval: true,
    interactionScope: 'window',
    captureTarget: 'window',
    notes: null,
  }
  private bridge = getBridge()

  constructor() {
    this.setupIPCListeners()
  }

  private async fetchFromAdmin(
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<any> {
    const result = await this.bridge.adminApi.fetchFromAdmin(path, options)
    if (!result?.success) {
      throw new Error(result?.error || `Admin API request failed for ${path}`)
    }
    return result?.data ?? result
  }

  private startIdleSessionPolling(): void {
    if (!this.sessionPollingEnabled || this.sessionPollTimer) {
      return
    }

    void this.pollForPendingSession()
    this.sessionPollTimer = setInterval(() => {
      void this.pollForPendingSession()
    }, 1500)
  }

  private stopIdleSessionPolling(): void {
    if (!this.sessionPollTimer) {
      return
    }
    clearInterval(this.sessionPollTimer)
    this.sessionPollTimer = null
  }

  private async pollForPendingSession(): Promise<void> {
    if (!this.sessionPollingEnabled || this.sessionPollInFlight || this.isStreaming || this.isStarting) {
      return
    }

    this.sessionPollInFlight = true
    try {
      const payload = (await this.fetchFromAdmin(
        '/api/pos/screen-share/terminal/session'
      )) as TerminalSessionPayload
      const request = payload?.request

      if (!request?.id || (request.status !== 'requested' && request.status !== 'active')) {
        return
      }

      this.currentRequestState = request
      if (payload?.terminal?.remote_view_capabilities) {
        this.reportedCapabilities = payload.terminal.remote_view_capabilities
      }

      if (this.config?.requestId === request.id) {
        return
      }

      await this.startCapture({
        requestId: request.id,
        adminSessionId: '',
        terminalId: payload?.terminal?.terminal_id || '',
        remoteViewCapabilities: payload?.terminal?.remote_view_capabilities ?? null,
      })
    } catch (error) {
      console.warn('[ScreenCapture] Idle session polling failed', error)
    } finally {
      this.sessionPollInFlight = false
    }
  }

  private getReportedCapabilities(): Record<string, unknown> {
    return {
      liveView: true,
      remoteControl: true,
      requiresControlApproval: true,
      interactionScope: 'window',
      captureTarget: 'window',
      notes: null,
      ...this.reportedCapabilities,
    }
  }

  private async sendSignal(requestId: string, type: 'offer' | 'candidate', data: unknown): Promise<void> {
    const payload = await this.fetchFromAdmin('/api/pos/screen-share/terminal', {
      method: 'POST',
      body: { requestId, type, data },
    })

    if (payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `Failed to send ${type} signal`)
    }

    if (payload?.request) {
      this.currentRequestState = payload.request
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
        clientPlatform: 'windows',
        remoteViewCapabilities: this.getReportedCapabilities(),
      },
    })

    if (payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `Failed to set status ${status}`)
    }

    if (payload?.request) {
      this.currentRequestState = payload.request
    }
    if (payload?.terminal?.remote_view_capabilities) {
      this.reportedCapabilities = payload.terminal.remote_view_capabilities
    }
  }

  private async respondToControlRequest(
    action: ControlAction,
    denialReason?: string
  ): Promise<void> {
    if (!this.config) {
      this.clearControlRequestPrompt()
      return
    }

    const payload = await this.fetchFromAdmin('/api/pos/screen-share/terminal/session', {
      method: 'PATCH',
      body: {
        requestId: this.config.requestId,
        action,
        ...(denialReason ? { denialReason } : {}),
      },
    })

    if (payload?.success === false) {
      throw new Error(payload?.error || 'Failed to update control request')
    }

    if (payload?.request) {
      this.currentRequestState = payload.request
    }

    this.lastControlPromptKey = null
    this.clearControlRequestPrompt()
  }

  private publishControlRequestPrompt(): void {
    if (!this.config || !this.currentRequestState) {
      return
    }

    emitCompatEvent(CONTROL_REQUEST_EVENT, {
      requestId: this.config.requestId,
      requestedAt: this.currentRequestState.control_requested_at || null,
      terminalId: this.config.terminalId || null,
    })
  }

  private clearControlRequestPrompt(): void {
    emitCompatEvent(CONTROL_REQUEST_CLEARED_EVENT, {
      requestId: this.config?.requestId || this.currentRequestState?.id || null,
    })
  }

  private maybePromptForControlApproval(): void {
    if (!this.config || !this.currentRequestState || this.currentRequestState.control_status !== 'requested') {
      this.clearControlRequestPrompt()
      return
    }

    const promptKey = `${this.config.requestId}:${this.currentRequestState.control_requested_at || 'requested'}`
    if (this.lastControlPromptKey === promptKey) {
      return
    }

    this.lastControlPromptKey = promptKey
    this.publishControlRequestPrompt()
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
            for (const candidate of this.pendingCandidates) {
              try {
                await this.peerConnection?.addIceCandidate(new RTCIceCandidate(candidate))
              } catch (iceErr) {
                console.warn('[ScreenCapture] Failed to add queued ICE candidate', iceErr)
              }
            }
            this.pendingCandidates = []
          }
        } catch (error) {
          console.error('[ScreenCapture] setRemoteDescription failed', error)
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

    if (payload?.request) {
      this.currentRequestState = {
        ...this.currentRequestState,
        ...payload.request,
        ...(payload.requestId ? { id: payload.requestId } : {}),
      }
    }

    const requestStatus = typeof this.currentRequestState?.status === 'string'
      ? this.currentRequestState.status
      : null

    this.maybePromptForControlApproval()

    if (requestStatus === 'stopped' || requestStatus === 'failed') {
      if (this.isStreaming || this.isStarting) {
        void this.stopCapture({ status: requestStatus as 'stopped' | 'failed' })
      }
      this.clearControlRequestPrompt()
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
    this.currentRequestState = {
      id: config.requestId,
      status: 'requested',
      control_status: 'view_only',
    }
    this.lastControlPromptKey = null
    this.clearControlRequestPrompt()

    try {
      let primaryScreenId: string | null = null
      try {
        const result = await this.bridge.screenCapture.getSources({ types: ['screen', 'window'] })
        const sources = Array.isArray(result?.sources) ? result.sources : []
        if (result?.success && sources.length > 0) {
          const primary = sources.find((source) => source?.display_id === 'primary') || sources[0]
          primaryScreenId = primary.id
        } else if (!result?.success) {
          throw new Error(result?.error || 'User denied screen capture access')
        }
      } catch (sourceError) {
        console.warn('[ScreenCapture] Failed to get capture sources with consent:', sourceError)
        primaryScreenId = null
      }

      let stream: MediaStream | null = null
      const canUseNativeDesktopSource =
        typeof primaryScreenId === 'string' &&
        primaryScreenId.trim().length > 0 &&
        primaryScreenId !== 'primary'

      if (canUseNativeDesktopSource) {
        try {
          stream = (await Promise.race([
            (navigator.mediaDevices as any).getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: primaryScreenId,
                  minWidth: 640,
                  maxWidth: 1920,
                  minHeight: 480,
                  maxHeight: 1080,
                  frameRate: 10,
                },
              },
            }),
            new Promise<never>((_, reject) => {
              window.setTimeout(() => {
                reject(new Error('Desktop source capture timed out'))
              }, 1500)
            }),
          ])) as MediaStream
        } catch (error) {
          console.warn('[ScreenCapture] getUserMedia desktop path failed', error)
        }
      } else if (primaryScreenId === 'primary') {
        console.info('[ScreenCapture] Native source id is placeholder-only, falling back to display picker')
      }

      if (!stream) {
        const mediaDevices: any = navigator.mediaDevices as any
        if (typeof mediaDevices?.getDisplayMedia === 'function') {
          stream = await mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false })
        } else {
          throw new Error('Neither desktop capture nor getDisplayMedia is available')
        }
      }

      if (!stream) {
        throw new Error('Screen capture stream was not created')
      }

      const activeStream: MediaStream = stream
      this.screenStream = activeStream
      const displaySurface = activeStream.getVideoTracks()[0]?.getSettings?.().displaySurface
      this.reportedCapabilities = {
        ...this.getReportedCapabilities(),
        captureTarget: displaySurface === 'window' ? 'window' : 'screen',
        interactionScope: 'window',
      }

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
    if (!this.config || !this.screenStream) {
      throw new Error('Missing config or screen stream')
    }

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    })

    this.screenStream.getTracks().forEach((track) => {
      this.peerConnection!.addTrack(track, this.screenStream!)
    })

    this.peerConnection.ondatachannel = (event) => {
      if (event.channel.label !== 'control') {
        return
      }

      this.controlChannel = event.channel
      this.controlChannel.onmessage = (message) => this.handleControlMessage(message.data)
      this.controlChannel.onopen = () => console.log('[ScreenCapture] Control channel open')
      this.controlChannel.onclose = () => console.log('[ScreenCapture] Control channel closed')
      this.controlChannel.onerror = (error) => console.warn('[ScreenCapture] Control channel error', error)
    }

    this.answerSet = false
    this.pendingCandidates = []
    this.lastSignalTimestamp = null
    this.seenSignalIds.clear()

    this.peerConnection.onicecandidate = async (event) => {
      if (!event.candidate || !this.config) {
        return
      }

      try {
        await this.sendSignal(this.config.requestId, 'candidate', event.candidate)
      } catch (signalError) {
        console.warn('[ScreenCapture] Failed to send ICE candidate', signalError)
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
    if (!this.config || this.answerChannel) {
      return
    }

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
        } catch (error) {
          console.warn('[ScreenCapture] Failed to stop native signal polling', error)
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

  private resolvePoint(x?: number, y?: number): { clientX: number; clientY: number; target: Element | null } {
    const normalizedX = Math.min(1, Math.max(0, typeof x === 'number' ? x : this.lastPointerPosition.x))
    const normalizedY = Math.min(1, Math.max(0, typeof y === 'number' ? y : this.lastPointerPosition.y))

    this.lastPointerPosition = { x: normalizedX, y: normalizedY }

    const clientX = Math.round(normalizedX * window.innerWidth)
    const clientY = Math.round(normalizedY * window.innerHeight)
    const target = document.elementFromPoint(clientX, clientY) || document.body

    return { clientX, clientY, target }
  }

  private dispatchMouseEvent(
    type: 'mousemove' | 'mousedown' | 'mouseup' | 'click',
    payload: { x?: number; y?: number; b?: number }
  ): void {
    const { clientX, clientY, target } = this.resolvePoint(payload.x, payload.y)
    const button = typeof payload.b === 'number' ? payload.b : 0
    const mouseEvent = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: type === 'mouseup' || type === 'click' ? 0 : 1 << button,
      view: window,
    })

    if (type === 'mousedown' && target instanceof HTMLElement) {
      target.focus()
    }

    target?.dispatchEvent(mouseEvent)
  }

  private dispatchWheelEvent(payload: { dx?: number; dy?: number }): void {
    const { clientX, clientY, target } = this.resolvePoint()
    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      deltaX: typeof payload.dx === 'number' ? payload.dx : 0,
      deltaY: typeof payload.dy === 'number' ? payload.dy : 0,
      view: window,
    })
    target?.dispatchEvent(wheelEvent)
  }

  private dispatchKeyboardEvent(type: 'keydown' | 'keyup', payload: { k?: string; c?: string }): void {
    const target = (document.activeElement as HTMLElement | null) || document.body
    const keyboardEvent = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key: typeof payload.k === 'string' ? payload.k : '',
      code: typeof payload.c === 'string' ? payload.c : '',
    })
    target.dispatchEvent(keyboardEvent)
  }

  private handleControlMessage(raw: any): void {
    if (this.currentRequestState?.control_status !== 'approved') {
      return
    }

    let payload: { t?: string; x?: number; y?: number; b?: number; dx?: number; dy?: number; k?: string; c?: string }
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return
    }

    switch (payload?.t) {
      case 'mm':
        this.dispatchMouseEvent('mousemove', payload)
        break
      case 'md':
        this.dispatchMouseEvent('mousedown', payload)
        break
      case 'mu':
        this.dispatchMouseEvent('mouseup', payload)
        this.dispatchMouseEvent('click', payload)
        break
      case 'mw':
        this.dispatchWheelEvent(payload)
        break
      case 'kd':
        this.dispatchKeyboardEvent('keydown', payload)
        break
      case 'ku':
        this.dispatchKeyboardEvent('keyup', payload)
        break
      default:
        break
    }
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
      this.screenStream.getTracks().forEach((track) => track.stop())
      this.screenStream = null
    }

    if (this.peerConnection) {
      this.peerConnection.close()
      this.peerConnection = null
    }

    if (this.answerChannel) {
      try {
        await this.answerChannel.unsubscribe()
      } catch {
        // Ignore cleanup errors.
      }
      this.answerChannel = null
    }

    this.controlChannel = null
    this.config = null
    this.answerSet = false
    this.pendingCandidates = []
    this.lastSignalTimestamp = null
    this.seenSignalIds.clear()
    this.lastControlPromptKey = null

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

    this.currentRequestState = null
    this.clearControlRequestPrompt()
  }

  setIdleSessionPollingEnabled(enabled: boolean): void {
    if (this.sessionPollingEnabled === enabled) {
      return
    }

    this.sessionPollingEnabled = enabled
    if (enabled) {
      this.startIdleSessionPolling()
      return
    }

    this.stopIdleSessionPolling()
  }

  async approvePendingControlRequest(): Promise<void> {
    await this.respondToControlRequest('approve_control')
  }

  async denyPendingControlRequest(): Promise<void> {
    await this.respondToControlRequest(
      'deny_control',
      'Terminal operator denied control.',
    )
  }

  cleanup(): void {
    this.stopIdleSessionPolling()
    this.eventUnsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe()
      } catch {
        // Ignore cleanup errors.
      }
    })
    this.eventUnsubscribers = []
    void this.stopCapture()
  }
}

export const screenCaptureHandler = new ScreenCaptureHandler()

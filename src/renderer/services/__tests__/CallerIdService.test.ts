import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  posApiGet: vi.fn(),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
}))

import { callerIdGetServerConfig } from '../CallerIdService'

describe('callerIdGetServerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('projects only safe FXO fields and drops credentials before returning to the UI', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        minimumClientVersion: '1.4.50',
        ipTrustSourcePolicy: 'founder_pilot',
        sourceLines: [{
          id: 'line-1',
          name: 'Main line',
          adapterType: 'generic_sip',
          sourceId: 'source-1',
          deviceProfileKey: 'grandstream_ht813_fxo',
          connectorFamily: 'analog_fxo',
          sourceChannel: 'fxo-1',
          countryCode: 'GR',
          isReceivingTarget: true,
          config: {
            trustedDeviceIp: '192.168.1.44',
            listenPort: 5060,
            shouldNeverReachUi: 'private-value',
          },
          credentialVersion: 7,
          credentials: {
            apiSecret: 'super-secret',
          },
        }],
        receivingLines: [{
          id: 'line-1',
          name: 'Main line',
          countryCode: 'GR',
          topic: 'callerid:line:line-1',
          readinessAttempt: { attemptId: 'attempt-1' },
        }],
      },
    })

    const result = await callerIdGetServerConfig()

    expect(mocks.posApiGet).toHaveBeenCalledWith('/api/pos/caller-id/config')
    expect(result).toEqual({
      enabled: true,
      minimumClientVersion: '1.4.50',
      ipTrustSourcePolicy: 'founder_pilot',
      sourceLines: [{
        id: 'line-1',
        name: 'Main line',
        adapterType: 'generic_sip',
        sourceId: 'source-1',
        deviceProfileKey: 'grandstream_ht813_fxo',
        connectorFamily: 'analog_fxo',
        sourceChannel: 'fxo-1',
        countryCode: 'GR',
        isReceivingTarget: true,
        trustedDeviceIp: '192.168.1.44',
        listenPort: 5060,
      }],
      receivingLines: [{ id: 'line-1', name: 'Main line', countryCode: 'GR' }],
    })
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('private-value')
    expect(JSON.stringify(result)).not.toContain('credentialVersion')
  })

  it('fails closed for unsafe ports and unknown trust policies', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        ipTrustSourcePolicy: 'unexpected',
        sourceLines: [{
          id: 'line-1',
          config: { trustedDeviceIp: '192.168.1.44', listenPort: 80 },
        }],
      },
    })

    const result = await callerIdGetServerConfig()

    expect(result.ipTrustSourcePolicy).toBe('blocked')
    expect(result.sourceLines[0]?.listenPort).toBeNull()
  })

  it('surfaces the authenticated API error', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: false,
      error: 'Terminal is not assigned',
      status: 403,
    })

    await expect(callerIdGetServerConfig()).rejects.toThrow('Terminal is not assigned')
  })
})

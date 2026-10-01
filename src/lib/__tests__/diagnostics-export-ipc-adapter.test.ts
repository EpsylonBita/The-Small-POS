import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { TauriBridge } from '../ipc-adapter'
import type { DiagnosticsExportOptions } from '../ipc-contracts'
import {
  HEALTH_VIEW_FORMAT,
  buildHealthView,
} from '../../../../shared/pos/health/diagnostics-bundle'

/**
 * The Health view snapshot must cross the IPC boundary to the native export
 * (diagnostics_export → health_view.json). The arg builder used to keep only
 * the two boolean options, so every desktop bundle said "not collected".
 */
const healthView = buildHealthView({
  platform: 'windows',
  source: 'health_modal',
  capturedAt: '2026-09-30T08:15:00.000Z',
  availability: 'ready',
  summary: null,
  issues: [
    {
      code: 'fiscal_queue_not_empty',
      severity: 'critical',
      status: 'blocking',
      params: { count: 2 },
    },
  ],
  closeout: null,
  lastActions: [],
  counts: { parityPending: 2, financialFailed: 0 },
})

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ success: true, path: 'C:/diagnostics/bundle.zip' })
})

describe('diagnostics export IPC arguments', () => {
  it('sends the shared Health view snapshot with the export options', async () => {
    await new TauriBridge().diagnostics.export({
      includeLogs: true,
      redactSensitive: true,
      healthView,
    })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('diagnostics_export', {
      arg0: { includeLogs: true, redactSensitive: true, healthView },
    })
    const sent = invoke.mock.calls[0][1].arg0.healthView
    expect(sent.format).toBe(HEALTH_VIEW_FORMAT)
    expect(sent.issues).toEqual([
      {
        code: 'fiscal_queue_not_empty',
        severity: 'critical',
        status: 'blocking',
        params: { count: 2 },
      },
    ])
  })

  it('sends a snapshot on its own', async () => {
    await new TauriBridge().diagnostics.export({ healthView })

    expect(invoke).toHaveBeenCalledWith('diagnostics_export', { arg0: { healthView } })
  })

  it.each([
    ['null', null],
    ['an array', [healthView]],
    ['a string', JSON.stringify(healthView)],
  ])('drops a Health view that is %s and keeps the options', async (_label, value) => {
    await new TauriBridge().diagnostics.export({
      includeLogs: false,
      redactSensitive: true,
      healthView: value,
    } as unknown as DiagnosticsExportOptions)

    expect(invoke).toHaveBeenCalledWith('diagnostics_export', {
      arg0: { includeLogs: false, redactSensitive: true },
    })
  })

  it('keeps the no-argument export (the native side then uses its defaults)', async () => {
    await new TauriBridge().diagnostics.export()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toBe('diagnostics_export')
    expect(invoke.mock.calls[0][1]).toBeUndefined()
  })
})

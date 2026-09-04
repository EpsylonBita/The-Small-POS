import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import en from '../../../../locales/en.json'
import { emitCompatEvent } from '../../../../lib/event-bridge'
import type { RepairWorkspaceSnapshot } from '../contracts'
import { RepairWorkspaceActions } from '../RepairWorkspaceActions'

const workspace: RepairWorkspaceSnapshot = {
  scopeToken: 'scope-a',
  source: 'authoritative_cache',
  repair: {
    id: '11111111-1111-4111-8111-111111111111',
    displayNumber: 'R-ATH-26-000001',
    status: 'diagnosing',
    priority: 'normal',
    title: null,
    intakeMode: 'standard',
    isAnonymous: false,
    assignedStaffId: null,
    dueAt: null,
    completedAt: null,
    deliveredAt: null,
    version: 2,
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:00:00.000Z',
    customerId: '22222222-2222-4222-8222-222222222222',
    customerDeviceId: '33333333-3333-4333-8333-333333333333',
    intakeNotes: null,
    diagnosis: 'Initial finding',
    currency: 'EUR',
    reopenedFromRepairId: null,
  },
  aliases: [],
  customer: { id: '22222222-2222-4222-8222-222222222222', displayName: 'Alex' },
  device: null,
  lines: [],
  timeline: [],
  estimates: [],
  estimateLines: [],
  approvals: [],
  capabilities: {
    read: true,
    create: true,
    update: true,
    assign: true,
    approve: true,
    overrideApproval: false,
    planParts: true,
    consumeParts: false,
    transfer: false,
    cancel: true,
    manageAttachments: true,
    collectPayments: false,
    refundPayments: false,
    fiscalize: false,
    overrideDeliveryBalance: false,
  },
  allowedTransitions: ['repairing', 'ready', 'approved', 'delivered'],
  pendingChanges: [],
  syncState: 'synced',
  needsRefetch: false,
}

function renderActions(overrides: Partial<React.ComponentProps<typeof RepairWorkspaceActions>> = {}) {
  const instance = i18next.createInstance()
  void instance.init({ lng: 'en', resources: { en: { translation: en } } })
  const props: React.ComponentProps<typeof RepairWorkspaceActions> = {
    tab: 'overview',
    workspace,
    attachmentPolicy: { maxBytes: 100, allowedMimeTypes: ['image/jpeg'] },
    connectivity: 'offline',
    hasActiveShift: true,
    isBusy: false,
    onExecuteCommand: vi.fn().mockResolvedValue(undefined),
    onStagePhoto: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(<I18nextProvider i18n={instance}><RepairWorkspaceActions {...props} /></I18nextProvider>)
  return props
}

afterEach(() => cleanup())

describe('RepairWorkspaceActions', () => {
  it('filters transitions through server allowedTransitions and offline policy, while delivery stays locked', async () => {
    const props = renderActions()

    expect(screen.getByRole('button', { name: 'Repairing' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Ready' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approved' })).not.toBeInTheDocument()
    expect(screen.getByText(/approved status.*approval action/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Delivered' })).not.toBeInTheDocument()
    expect(screen.getByText(/delivery remain locked/i)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith({
      command: 'transition_status',
      payload: { target_status: 'ready', reason: null, remain_consumed: false },
    }))
  })

  it('assigns the repair to the canonical current staff member while offline', async () => {
    const props = renderActions({
      currentStaffId: '77777777-7777-4777-8777-777777777777',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Assign to me' }))

    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith({
      command: 'assign_repair',
      payload: { assigned_staff_id: '77777777-7777-4777-8777-777777777777' },
    }))
    expect(screen.queryByText('77777777-7777-4777-8777-777777777777')).not.toBeInTheDocument()
  })

  it('does not offer self-assignment for a non-canonical staff identity', () => {
    renderActions({ currentStaffId: 'local-simple-pin' })

    expect(screen.queryByRole('button', { name: 'Assign to me' })).not.toBeInTheDocument()
    expect(screen.getByText(/canonical staff identity/i)).toBeVisible()
  })

  it('allows an offline diagnosis draft but requires online connectivity for final diagnosis', async () => {
    const props = renderActions({ tab: 'diagnosis' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Diagnosis' }), {
      target: { value: 'Display assembly damaged' },
    })

    expect(screen.getByRole('button', { name: 'Save diagnosis draft' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save final diagnosis' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save diagnosis draft' }))

    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith({
      command: 'update_diagnosis',
      payload: { diagnosis: 'Display assembly damaged', draft: true },
    }))
  })

  it('adds a manual planned line without using an untyped catalog lookup', async () => {
    const props = renderActions({ tab: 'partsLabour' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Line name' }), { target: { value: 'Screen assembly' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Unit price' }), { target: { value: '89.90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add planned line' }))

    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'plan_line',
      payload: expect.objectContaining({
        line_type: 'part',
        name_snapshot: 'Screen assembly',
        unit_price_snapshot: '89.90',
        retail_product_id: null,
      }),
    })))
    expect(screen.getByText(/catalog lookup remains locked/i)).toBeVisible()
  })

  it('selects a repair-safe catalog result with canonical references and immutable snapshots', async () => {
    const catalogItem = {
      key: '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666',
      kind: 'part' as const,
      retailProductId: '55555555-5555-4555-8555-555555555555',
      retailVariantId: '66666666-6666-4666-8666-666666666666',
      serviceId: null,
      nameSnapshot: 'Screen assembly — Black',
      skuSnapshot: 'SCREEN-BLK',
      description: 'OLED module',
      unitCostSnapshot: 40,
      unitPriceSnapshot: 89.9,
      vatRateSnapshot: 24,
    }
    const onCatalogSearch = vi.fn().mockResolvedValue([catalogItem])
    const props = renderActions({
      tab: 'partsLabour',
      connectivity: 'online',
      onCatalogSearch,
      onCatalogBarcodeLookup: vi.fn(),
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Catalog search' }), {
      target: { value: 'screen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search catalog' }))
    await waitFor(() => expect(onCatalogSearch).toHaveBeenCalledWith('part', 'screen'))
    fireEvent.click(await screen.findByRole('button', { name: /Screen assembly — Black/ }))

    expect(screen.getByRole('textbox', { name: 'Line name' })).toHaveValue('Screen assembly — Black')
    expect(screen.getByRole('textbox', { name: 'SKU' })).toHaveValue('SCREEN-BLK')
    expect(screen.getByRole('spinbutton', { name: 'Unit price' })).toHaveValue(89.9)
    expect(screen.getByRole('spinbutton', { name: 'VAT rate' })).toHaveValue(24)

    fireEvent.click(screen.getByRole('button', { name: 'Add planned line' }))
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'plan_line',
      payload: expect.objectContaining({
        name_snapshot: 'Screen assembly — Black',
        sku_snapshot: 'SCREEN-BLK',
        description: 'OLED module',
        unit_cost_snapshot: '40',
        unit_price_snapshot: '89.9',
        vat_rate_snapshot: '24',
        retail_product_id: catalogItem.retailProductId,
        retail_variant_id: catalogItem.retailVariantId,
        service_id: null,
      }),
    })))
  })

  it('consumes and reverses a catalog part online using its safe original movement projection', async () => {
    const basePart = {
      id: '44444444-4444-4444-8444-444444444444',
      lineType: 'part' as const,
      nameSnapshot: 'Screen assembly',
      skuSnapshot: 'SCREEN-01',
      description: null,
      quantity: 1,
      unitPriceSnapshot: 89.9,
      vatRateSnapshot: 24,
      retailProductId: '55555555-5555-4555-8555-555555555555',
      retailVariantId: null,
      serviceId: null,
      partState: 'planned' as const,
      displayOrder: 0,
      aggregateVersion: 2,
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z',
    }
    const props = renderActions({
      tab: 'partsLabour',
      connectivity: 'online',
      workspace: {
        ...workspace,
        lines: [basePart],
        capabilities: { ...workspace.capabilities, consumeParts: true },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Consume part' }))
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith({
      command: 'consume_repair_part',
      payload: { line_id: basePart.id },
    }))

    cleanup()
    const reversalProps = renderActions({
      tab: 'partsLabour',
      connectivity: 'online',
      workspace: {
        ...workspace,
        lines: [{ ...basePart, partState: 'consumed' }],
        timeline: [{
          id: '88888888-8888-4888-8888-888888888888',
          aggregateVersion: 3,
          eventType: 'part_consumed',
          repairLineId: basePart.id,
          movementId: '99999999-9999-4999-8999-999999999999',
          occurredAt: '2026-08-27T08:01:00.000Z',
          createdAt: '2026-08-27T08:01:00.000Z',
        }],
        capabilities: { ...workspace.capabilities, consumeParts: true },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reverse consumption' }))
    await waitFor(() => expect(reversalProps.onExecuteCommand).toHaveBeenLastCalledWith({
      command: 'reverse_repair_part',
      payload: {
        line_id: basePart.id,
        original_movement_id: '99999999-9999-4999-8999-999999999999',
      },
    }))
  })

  it('keeps stock reversal locked when no matching safe original movement is projected', () => {
    const consumedPart = {
      id: '44444444-4444-4444-8444-444444444444',
      lineType: 'part' as const,
      nameSnapshot: 'Screen assembly',
      skuSnapshot: 'SCREEN-01',
      description: null,
      quantity: 1,
      unitPriceSnapshot: 89.9,
      vatRateSnapshot: 24,
      retailProductId: '55555555-5555-4555-8555-555555555555',
      retailVariantId: null,
      serviceId: null,
      partState: 'consumed' as const,
      displayOrder: 0,
      aggregateVersion: 2,
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z',
    }
    renderActions({
      tab: 'partsLabour',
      connectivity: 'online',
      workspace: {
        ...workspace,
        lines: [consumedPart],
        timeline: [{
          id: '88888888-8888-4888-8888-888888888888',
          aggregateVersion: 3,
          eventType: 'part_consumed',
          repairLineId: '77777777-7777-4777-8777-777777777777',
          movementId: '99999999-9999-4999-8999-999999999999',
          occurredAt: '2026-08-27T08:01:00.000Z',
          createdAt: '2026-08-27T08:01:00.000Z',
        }],
        capabilities: { ...workspace.capabilities, consumeParts: true },
      },
    })

    expect(screen.queryByRole('button', { name: 'Reverse consumption' })).not.toBeInTheDocument()
    expect(screen.getByText(/native workspace does not expose the original movement/i)).toBeVisible()
  })

  it('records the canonical accepted decision instead of transitioning directly to approved', async () => {
    const props = renderActions({
      tab: 'estimateApproval',
      connectivity: 'online',
      workspace: {
        ...workspace,
        estimates: [{
          id: '66666666-6666-4666-8666-666666666666',
          version: 1,
          supersedesEstimateId: null,
          currency: 'EUR',
          subtotalAmount: 100,
          discountAmount: 0,
          taxAmount: 24,
          totalAmount: 124,
          validUntil: null,
          note: null,
          aggregateVersion: 2,
          issuedAt: '2026-08-27T08:00:00.000Z',
          createdAt: '2026-08-27T08:00:00.000Z',
        }],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Record in-person approval' }))
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith({
      command: 'record_approval',
      payload: expect.objectContaining({
        estimate_id: '66666666-6666-4666-8666-666666666666',
        decision: 'accepted',
        decision_source: 'in_person',
      }),
    }))
  })

  it('resolves serial-scanner events through the canonical catalog lookup', async () => {
    const onCatalogBarcodeLookup = vi.fn().mockResolvedValue({
      key: '55555555-5555-4555-8555-555555555555',
      kind: 'part',
      retailProductId: '55555555-5555-4555-8555-555555555555',
      retailVariantId: null,
      serviceId: null,
      nameSnapshot: 'Scanned display',
      skuSnapshot: 'SKU-SCAN-123',
      description: null,
      unitCostSnapshot: null,
      unitPriceSnapshot: 50,
      vatRateSnapshot: null,
    })
    renderActions({ tab: 'partsLabour', connectivity: 'online', onCatalogBarcodeLookup })

    act(() => {
      emitCompatEvent('barcode_scanned_serial', {
        barcode: 'SKU-SCAN-123',
        source: 'serial',
        timestamp: '2026-08-27T08:00:00.000Z',
      })
    })

    await waitFor(() => expect(onCatalogBarcodeLookup).toHaveBeenCalledWith('SKU-SCAN-123'))
    expect(screen.getByRole('textbox', { name: 'SKU' })).toHaveValue('SKU-SCAN-123')
    expect(screen.getByRole('textbox', { name: 'Line name' })).toHaveValue('Scanned display')
  })

  it('does not consume scanner events outside the parts and labour workspace', async () => {
    const onCatalogBarcodeLookup = vi.fn()
    renderActions({ tab: 'overview', connectivity: 'online', onCatalogBarcodeLookup })

    act(() => {
      emitCompatEvent('barcode_scanned_serial', {
        barcode: 'SKU-SCAN-123',
        source: 'serial',
        timestamp: '2026-08-27T08:00:00.000Z',
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onCatalogBarcodeLookup).not.toHaveBeenCalled()
  })

  it('validates a one-shot photo against the settings policy before staging it', async () => {
    const props = renderActions({ tab: 'photos' })
    const input = screen.getByLabelText('Add photo')
    fireEvent.change(input, { target: { files: [new File(['x'], 'device.gif', { type: 'image/gif' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/file type is not allowed/i)
    expect(props.onStagePhoto).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { files: [new File(['x'], 'device.jpg', { type: 'image/jpeg' })] } })
    await waitFor(() => expect(props.onStagePhoto).toHaveBeenCalledTimes(1))
  })
})

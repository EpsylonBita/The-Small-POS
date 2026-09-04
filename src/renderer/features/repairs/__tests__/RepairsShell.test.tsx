import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../../../locales/en.json'
import type {
  RepairAttachmentSnapshot,
  RepairConflictSnapshot,
  RepairListItemSnapshot,
  RepairWorkspaceSnapshot,
} from '../contracts'
import { RepairsShell } from '../RepairsShell'

const repairs: RepairListItemSnapshot[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    displayNumber: 'R-ATH-26-000001',
    aliases: ['R-OFF-A1B2-000001'],
    status: 'ready',
    priority: 'high',
    intakeMode: 'standard',
    safeDeviceLabel: 'Apple iPhone 15',
    dueAt: '2026-08-20T10:00:00.000Z',
    readyAt: '2026-08-21T10:00:00.000Z',
    authoritativeVersion: 4,
    optimisticVersion: 5,
    syncState: 'queued',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
  },
]

const workspace: RepairWorkspaceSnapshot = {
  scopeToken: 'opaque-scope-token',
  source: 'authoritative_with_local_changes',
  repair: {
    id: repairs[0].id,
    displayNumber: repairs[0].displayNumber,
    status: 'ready',
    priority: 'high',
    title: 'Screen replacement',
    intakeMode: 'standard',
    isAnonymous: false,
    assignedStaffId: null,
    dueAt: repairs[0].dueAt,
    completedAt: null,
    deliveredAt: null,
    version: 5,
    createdAt: repairs[0].createdAt,
    updatedAt: repairs[0].updatedAt,
    customerId: '22222222-2222-4222-8222-222222222222',
    customerDeviceId: '33333333-3333-4333-8333-333333333333',
    intakeNotes: 'Cracked display',
    diagnosis: 'Display assembly damaged',
    currency: 'EUR',
    reopenedFromRepairId: null,
  },
  aliases: repairs[0].aliases,
  customer: { id: '22222222-2222-4222-8222-222222222222', displayName: 'Alex Customer' },
  device: {
    id: '33333333-3333-4333-8333-333333333333',
    label: 'Work phone',
    deviceType: 'phone',
    manufacturer: 'Apple',
    model: 'iPhone 15',
    variant: null,
    storageCapacity: '128 GB',
    color: 'Black',
    serialMasked: '••••1234',
    imeiMasked: '••••5678',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
  },
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
    cancel: false,
    manageAttachments: true,
    collectPayments: false,
    refundPayments: false,
    fiscalize: false,
    overrideDeliveryBalance: false,
  },
  allowedTransitions: ['delivered'],
  pendingChanges: [{ kind: 'transition_status', occurredAt: '2026-08-21T10:00:00.000Z' }],
  syncState: 'queued',
  needsRefetch: false,
}

const attachments: RepairAttachmentSnapshot[] = [{
  id: '44444444-4444-4444-8444-444444444444',
  attachmentType: 'diagnostic',
  retentionState: 'active',
  mimeType: 'image/jpeg',
  byteSize: 8_192,
  createdAt: '2026-08-19T10:00:00.000Z',
}]

const conflicts: RepairConflictSnapshot[] = [{
  conflictId: '55555555-5555-4555-8555-555555555555',
  repairId: repairs[0].id,
  expectedVersion: 4,
  currentVersion: 5,
  displayNumber: repairs[0].displayNumber,
  status: 'ready',
  updatedAt: '2026-08-21T10:00:00.000Z',
  allowedTransitions: ['delivered'],
  createdAt: '2026-08-21T10:00:00.000Z',
}]

afterEach(() => cleanup())

function renderShell(overrides: Partial<React.ComponentProps<typeof RepairsShell>> = {}) {
  const instance = i18next.createInstance()
  void instance.init({ lng: 'en', resources: { en: { translation: en } } })
  return render(
    <I18nextProvider i18n={instance}>
      <RepairsShell
        repairs={repairs}
        workspace={workspace}
        attachments={attachments}
        conflicts={conflicts}
        isLoading={false}
        isOffline
        quickServiceEnabled
        notificationState="queued_after_sync"
        onRefresh={vi.fn()}
        onSelectRepair={vi.fn()}
        onNewRepair={vi.fn()}
        onQuickService={vi.fn()}
        onResolveConflict={vi.fn()}
        {...overrides}
      />
    </I18nextProvider>,
  )
}

describe('RepairsShell', () => {
  it('renders a single accessible workspace heading and safe searchable list identity', () => {
    renderShell()

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Repairs' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search repairs' })).toBeVisible()
    expect(screen.getAllByText('R-ATH-26-000001').length).toBeGreaterThan(0)
    expect(screen.getByText(/R-OFF-A1B2-000001/)).toBeVisible()
    expect(screen.queryByText(repairs[0].id)).not.toBeInTheDocument()
  })

  it('exposes all eight tabs with arrow-key navigation', () => {
    renderShell()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(8)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Diagnosis' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Diagnosis' })).toBeVisible()
  })

  it('keeps unsafe integrations visibly locked and reports offline-ready honestly', () => {
    renderShell()
    expect(screen.getByRole('status')).toHaveTextContent('Ready status is queued for sync.')
    expect(screen.getByRole('status')).toHaveTextContent('No customer notification has been sent yet.')

    fireEvent.click(screen.getByRole('tab', { name: 'Parts & labour' }))
    expect(screen.getByText(/catalog lookup remains locked/i)).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    expect(screen.getByRole('button', { name: /open attachment/i })).toBeDisabled()
    expect(screen.getByText('image/jpeg')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }))
    expect(screen.getByText(/payments require an online connection/i)).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Communication' }))
    expect(screen.getByText(/Messaging actions require an online connection/i)).toBeVisible()
  })

  it('opens an existing attachment only while online', () => {
    const onOpenAttachment = vi.fn()
    renderShell({ isOffline: false, connectivity: 'online', onOpenAttachment })

    fireEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    fireEvent.click(screen.getByRole('button', { name: /open attachment/i }))

    expect(onOpenAttachment).toHaveBeenCalledWith(attachments[0].id)
    expect(screen.queryByText(/Opening existing attachments remains locked/i)).not.toBeInTheDocument()
  })

  it('offers only server acceptance or rebase for a visible conflict', () => {
    renderShell()
    const conflictRegion = screen.getByRole('region', { name: 'Sync conflicts' })
    expect(within(conflictRegion).getByText('R-ATH-26-000001')).toBeVisible()
    expect(within(conflictRegion).getByRole('button', { name: 'Use server version' })).toBeVisible()
    expect(within(conflictRegion).getByRole('button', { name: 'Rebase my changes' })).toBeVisible()
    expect(conflictRegion).not.toHaveTextContent(conflicts[0].conflictId)
  })

  it('connects canonical catalog lookup and the native non-fiscal print actions in the live workspace', async () => {
    const onPrintRepair = vi.fn().mockResolvedValue(undefined)
    const onCatalogSearch = vi.fn().mockResolvedValue([])
    renderShell({
      isOffline: false,
      connectivity: 'online',
      hasActiveShift: true,
      onExecuteCommand: vi.fn().mockResolvedValue(undefined),
      onStagePhoto: vi.fn().mockResolvedValue(undefined),
      onCatalogSearch,
      onCatalogBarcodeLookup: vi.fn().mockResolvedValue(null),
      onPrintRepair,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Print intake' }))
    await waitFor(() => expect(onPrintRepair).toHaveBeenCalledWith('repair_intake'))
    fireEvent.click(screen.getByRole('button', { name: 'Print label' }))
    await waitFor(() => expect(onPrintRepair).toHaveBeenCalledWith('repair_label'))

    fireEvent.click(screen.getByRole('tab', { name: 'Parts & labour' }))
    expect(screen.getByRole('searchbox', { name: 'Catalog search' })).toBeEnabled()
    expect(screen.queryByText(/catalog lookup remains locked/i)).not.toBeInTheDocument()
  })

  it('mounts the server-authoritative POS settlement surface for an accepted estimate', async () => {
    const moneyService = {
      getSettlement: vi.fn().mockResolvedValue({
        repair_id: repairs[0].id,
        currency: 'EUR',
        total_minor: 10000,
        paid_minor: 4000,
        refunded_minor: 0,
        balance_minor: 6000,
        orders: [],
        payments: [],
        adjustments: [],
        fiscal_commands: [],
      }),
      createOrRefreshSettlement: vi.fn(),
      recordPayment: vi.fn(),
      recordRefund: vi.fn(),
      fiscalize: vi.fn(),
      deliver: vi.fn(),
    }
    const acceptedWorkspace: RepairWorkspaceSnapshot = {
      ...workspace,
      estimates: [{
        id: '66666666-6666-4666-8666-666666666666',
        version: 1,
        supersedesEstimateId: null,
        currency: 'EUR',
        subtotalAmount: 100,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: 100,
        validUntil: null,
        note: null,
        aggregateVersion: 6,
        issuedAt: '2026-08-21T09:00:00.000Z',
        createdAt: '2026-08-21T09:00:00.000Z',
      }],
      approvals: [{
        id: '77777777-7777-4777-8777-777777777777',
        estimateId: '66666666-6666-4666-8666-666666666666',
        estimateVersion: 1,
        decision: 'accepted',
        decisionSource: 'in_person',
        currency: 'EUR',
        approvedTotalAmount: 100,
        note: null,
        decidedAt: '2026-08-21T09:01:00.000Z',
        aggregateVersion: 7,
        createdAt: '2026-08-21T09:01:00.000Z',
      }],
      capabilities: {
        ...workspace.capabilities,
        collectPayments: true,
        refundPayments: true,
        fiscalize: true,
      },
    }
    renderShell({
      workspace: acceptedWorkspace,
      isOffline: false,
      connectivity: 'online',
      hasActiveShift: true,
      repairDepositSupported: true,
      moneyService,
      onMoneyBusyChange: vi.fn(),
      onAuthoritativeRefresh: vi.fn().mockResolvedValue(undefined),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }))

    expect(await screen.findByRole('region', { name: 'Repair payments' })).toBeVisible()
    expect(await screen.findByText('€60.00')).toBeVisible()
    expect(moneyService.getSettlement).toHaveBeenCalledWith(repairs[0].id)
  })
})

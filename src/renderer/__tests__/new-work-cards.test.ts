import { describe, expect, it } from 'vitest'
import { hasLaunchableNewWork, resolveDirectNewWorkCard, resolveNewWorkCards } from '../new-work-cards'
import { resolveTauriPrimaryActions } from '../primary-actions'

function cards(overrides: Partial<Parameters<typeof resolveNewWorkCards>[0]> & {
  modules: string[]
}) {
  const { modules, ...rest } = overrides
  return resolveNewWorkCards({
    hasOrdersModule: modules.includes('orders'),
    hasDeliveryModule: modules.includes('delivery'),
    hasTablesModule: modules.includes('tables'),
    hasRoomsModule: modules.includes('rooms'),
    hasServicesModule: modules.includes('appointments'),
    primaryActions: resolveTauriPrimaryActions(modules, true),
    isShiftActive: true,
    ...rest,
  })
}

const ids = (list: ReturnType<typeof resolveNewWorkCards>) => list.map((card) => card.id)

describe('resolveNewWorkCards — the (+) shows what this business can do', () => {
  it('retail with delivery: sale (pickup) + delivery, nothing else', () => {
    expect(ids(cards({ modules: ['orders', 'delivery'] }))).toEqual(['delivery', 'pickup'])
  })

  it('appointments-only business: only the appointment card', () => {
    expect(ids(cards({ modules: ['appointments'] }))).toEqual(['service'])
  })

  it('electronics repair shop that also sells: sale + repair (+ quick service)', () => {
    expect(ids(cards({ modules: ['orders', 'repairs'] }))).toEqual([
      'pickup',
      'repair',
      'quick_service',
    ])
  })

  it('a creperie with orders + delivery + tables keeps the familiar order cards, no repair', () => {
    expect(ids(cards({ modules: ['orders', 'delivery', 'tables'] }))).toEqual([
      'delivery',
      'pickup',
      'table',
    ])
  })

  it('numbers the visible cards consecutively for the grid spans', () => {
    const list = cards({ modules: ['orders', 'delivery', 'tables', 'rooms', 'appointments'] })
    expect(list.map((card) => card.visibleIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('without a cash shift only the appointment card stays launchable', () => {
    const list = cards({ modules: ['orders', 'delivery', 'appointments', 'repairs'], isShiftActive: false })
    const byId = Object.fromEntries(list.map((card) => [card.id, card]))
    expect(byId.service.enabled).toBe(true)
    for (const id of ['delivery', 'pickup', 'repair', 'quick_service'] as const) {
      expect(byId[id].enabled).toBe(false)
      expect(byId[id].disabledReasonKey).toBe('orders.startShiftFirst')
    }
    expect(hasLaunchableNewWork(list)).toBe(true)
  })

  it('reports nothing launchable for a sales-only store without a shift', () => {
    expect(hasLaunchableNewWork(cards({ modules: ['orders'], isShiftActive: false }))).toBe(false)
  })
})

describe('resolveDirectNewWorkCard — one kind of work needs no picker', () => {
  // Founder, 24/09/2026: «όταν είναι μόνο ένα module δεν χρειάζεται επιλογή».
  it.each([
    [['orders'], 'pickup'],
    [['tables'], 'table'],
    [['delivery'], 'delivery'],
    [['rooms'], 'room'],
    [['appointments'], 'service'],
  ])('opens %j straight away as the %s card', (modules, cardId) => {
    expect(resolveDirectNewWorkCard(cards({ modules }), true)?.id).toBe(cardId)
  })

  it('keeps the picker when there is a choice to make', () => {
    expect(resolveDirectNewWorkCard(cards({ modules: ['orders', 'tables'] }), true)).toBeUndefined()
    expect(resolveDirectNewWorkCard(cards({ modules: ['orders', 'repairs'] }), true)).toBeUndefined()
    expect(resolveDirectNewWorkCard(cards({ modules: ['menu'] }), true)).toBeUndefined()
  })

  it('waits until the repair settings answered', () => {
    expect(resolveDirectNewWorkCard(cards({ modules: ['orders'] }), false)).toBeUndefined()
  })

  it('never opens a card that cannot start', () => {
    expect(
      resolveDirectNewWorkCard(cards({ modules: ['orders'], isShiftActive: false }), true),
    ).toBeUndefined()
  })
})

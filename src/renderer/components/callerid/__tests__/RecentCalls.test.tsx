import { readFileSync } from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  recentCalls: vi.fn(),
  recordCallAction: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  useTheme: vi.fn(() => ({ resolvedTheme: 'light', setTheme: () => {} })),
}))

vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBridge: () => ({
    callerid: {
      getStatus: mocks.getStatus,
      recentCalls: mocks.recentCalls,
      recordCallAction: mocks.recordCallAction,
    },
  }),
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}))

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: mocks.useTheme,
}))

import i18n from '../../../../lib/i18n'
import { localeBundles } from '../../../../locales/bundles'
import { CashierGateContext } from '../../../contexts/cashier-gate-context'
import { I18nContext } from '../../../contexts/i18n-state'
import { UTILITY_RAIL_CALLS_SLOT_ID } from '../../UtilityRail'
import { RecentCallsHost, recentCallTimeLabel } from '../RecentCalls'

const KNOWN = {
  id: 'row-known',
  occurredAt: '2026-11-23T19:42:00.000Z',
  presentation: 'allowed',
  number: '6970000101',
  customerId: 'customer-1',
  customerName: 'Μαρία Π.',
  orderStarted: true,
}
const NEW_NUMBER = {
  id: 'row-new',
  occurredAt: '2026-11-23T19:15:00.000Z',
  presentation: 'allowed',
  number: '2100000142',
  customerId: null,
  customerName: null,
  orderStarted: false,
}
const WITHHELD = {
  id: 'row-withheld',
  occurredAt: '2026-11-23T18:58:00.000Z',
  presentation: 'restricted',
  number: null,
  customerId: null,
  customerName: null,
  orderStarted: false,
}
const NO_NUMBER = {
  id: 'row-none',
  occurredAt: '2026-11-22T12:00:00.000Z',
  presentation: 'unknown',
  number: null,
  customerId: null,
  customerName: null,
  orderStarted: false,
}

const tr = (key: string, options?: Record<string, unknown>) =>
  i18n.t(`callerid.recentCalls.${key}`, options) as string

function renderHost(options: { locked?: boolean | null } = {}) {
  const onSearchCustomer = vi.fn()
  const view = render(
    <I18nextProvider i18n={i18n}>
      {/* The glass window reads the till's own language context for its close button. */}
      <I18nContext.Provider
        value={{ language: i18n.language, setLanguage: async () => {}, t: i18n.t }}
      >
        {/* The rail's slot: the real rail also holds Health, which this test does not need. */}
        <div data-testid="rail">
          <div id={UTILITY_RAIL_CALLS_SLOT_ID} className="contents" />
        </div>
        <CashierGateContext.Provider value={options.locked ?? false}>
          <RecentCallsHost onSearchCustomer={onSearchCustomer} />
        </CashierGateContext.Provider>
      </I18nContext.Provider>
    </I18nextProvider>,
  )
  return { ...view, onSearchCustomer }
}

const railButton = () => screen.findByRole('button', { name: tr('title') })

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('el')
  })
  mocks.getStatus.mockReset().mockResolvedValue({ status: 'listening', callsDetected: 0 })
  mocks.recentCalls.mockReset().mockResolvedValue({
    retentionDays: 30,
    calls: [KNOWN, NEW_NUMBER, WITHHELD, NO_NUMBER],
  })
  mocks.recordCallAction.mockReset()
  mocks.onEvent.mockReset()
  mocks.useTheme.mockClear()
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

describe('the «Πρόσφατες κλήσεις» button', () => {
  it('sits in the rail of a till that records calls, and reads nothing until it is pressed', async () => {
    renderHost()

    const button = await railButton()
    expect(within(screen.getByTestId('rail')).getByRole('button')).toBe(button)
    expect(button).toHaveAttribute('aria-label', 'Πρόσφατες κλήσεις')
    // Touch-first: a name for assistive tech, no native tooltip, no hover style.
    expect(button).not.toHaveAttribute('title')
    expect(button.className).not.toMatch(/hover:/)
    expect(button.className).toMatch(/h-12 w-12/)
    expect(button.className).toMatch(/active:scale-95/)
    // No read of the record, and no ear on the call event the popup owns.
    expect(mocks.recentCalls).not.toHaveBeenCalled()
    expect(
      mocks.onEvent.mock.calls.filter(([channel]) => /caller/i.test(String(channel))),
    ).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is absent on a till without a Caller ID source: its rail keeps three buttons', async () => {
    mocks.getStatus.mockResolvedValue({ status: 'stopped', callsDetected: 0 })
    renderHost()

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled())
    expect(within(screen.getByTestId('rail')).queryByRole('button')).toBeNull()
    expect(mocks.recentCalls).not.toHaveBeenCalled()
    // It mounts none of the list there: the app shell's own tests render the
    // host without a theme, and a till without the plugin must cost nothing.
    expect(mocks.useTheme).not.toHaveBeenCalled()
  })

  it('appears once the listener has started, without anyone asking', async () => {
    vi.useFakeTimers()
    mocks.getStatus
      .mockResolvedValueOnce({ status: 'stopped', callsDetected: 0 })
      .mockResolvedValue({ status: 'listening', callsDetected: 0 })
    renderHost()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(within(screen.getByTestId('rail')).queryByRole('button')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(within(screen.getByTestId('rail')).getByRole('button')).toBeInTheDocument()
    // Found: the checks stop.
    const asked = mocks.getStatus.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000)
    })
    expect(mocks.getStatus).toHaveBeenCalledTimes(asked)
  })

  it('has its place at the top of the rail, above the three fixed places', () => {
    // Founder 31/10: expenses, then the heart, then the theme. Founder 23/11:
    // a till that records calls gets the phone above them.
    const rail = readFileSync(path.resolve(__dirname, '..', '..', 'UtilityRail.tsx'), 'utf8')
    const calls = rail.indexOf('id={UTILITY_RAIL_CALLS_SLOT_ID}')
    const expenses = rail.indexOf('id={UTILITY_RAIL_EXPENSES_SLOT_ID}')
    const health = rail.indexOf('<SyncStatusIndicator layout="rail"')
    const theme = rail.indexOf('data-utility-rail-theme')
    expect(calls).toBeGreaterThan(0)
    expect([calls, expenses, health, theme]).toEqual(
      [calls, expenses, health, theme].sort((a, b) => a - b),
    )
  })

  it('leaves the rail while the cashier gate is locked', async () => {
    renderHost({ locked: true })

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled())
    await act(async () => {})
    expect(within(screen.getByTestId('rail')).queryByRole('button')).toBeNull()
  })
})

describe('the «Πρόσφατες κλήσεις» list', () => {
  it('shows each call in plain words, newest first, with one action per row', async () => {
    renderHost()
    fireEvent.click(await railButton())

    const dialog = await screen.findByRole('dialog')
    const rows = await within(dialog).findAllByTestId('recent-call')
    expect(mocks.recentCalls).toHaveBeenCalledTimes(1)
    expect(rows.map((row) => row.getAttribute('data-call-state'))).toEqual([
      'known',
      'new',
      'restricted',
      'unknown',
    ])

    // A known customer: the name, the number, the green state word, and what staff did.
    expect(rows[0]).toHaveTextContent('Μαρία Π.')
    expect(rows[0]).toHaveTextContent('6970000101')
    const known = within(rows[0]).getByText('Γνωστός πελάτης')
    expect(known.className).toBe('text-(--pos-s-ok)')
    expect(within(rows[0]).getByTestId('recent-call-order-started')).toHaveTextContent(
      'Ξεκίνησε παραγγελία',
    )
    // A stranger: the number is the title, with the amber state word.
    expect(within(rows[1]).getByText('2100000142').tagName).toBe('P')
    expect(within(rows[1]).getByText('Νέος αριθμός').className).toBe('text-(--pos-s-warn)')
    expect(within(rows[1]).queryByTestId('recent-call-order-started')).toBeNull()
    // No number: said in words, and nothing to search.
    expect(rows[2]).toHaveTextContent('Απόκρυψη αριθμού')
    expect(rows[2]).toHaveTextContent('Ο καλών δεν έδειξε τον αριθμό του')
    expect(within(rows[2]).queryByRole('button')).toBeNull()
    expect(rows[3]).toHaveTextContent('Χωρίς αριθμό')
    expect(within(rows[3]).queryByRole('button')).toBeNull()

    // State words are plain coloured words: no chip, no fill, no border.
    for (const word of [known, within(rows[1]).getByText('Νέος αριθμός')]) {
      expect(word.className).not.toMatch(/\b(bg-|border|rounded|px-|ring)/)
    }
    // The one action is the popup's own, a search, on a full-size touch target.
    for (const row of rows.slice(0, 2)) {
      const actions = within(row).getAllByRole('button')
      expect(actions).toHaveLength(1)
      expect(actions[0]).toHaveTextContent('Αναζήτηση')
      expect(actions[0].className).toMatch(/pos-raised/)
      expect(actions[0].className).toMatch(/min-h-touch/)
      expect(actions[0].className).not.toMatch(/hover:/)
      expect(actions[0]).not.toHaveAttribute('title')
    }

    expect(dialog).toHaveTextContent('4 κλήσεις')
    expect(dialog).toHaveTextContent(
      'Οι κλήσεις κρατιούνται 30 ημέρες, μόνο σε αυτό το ταμείο.',
    )
    // «Σήμερα» is the Z's day on a till; the list does not use the word.
    expect(dialog.textContent).not.toMatch(/Σήμερα|Today/i)
    // No codes, ids or server words in front of staff.
    expect(dialog.textContent).not.toMatch(
      /row-|customer-1|restricted|unknown|allowed|order_started|\b(?:server|sync|queue)\b/i,
    )
  })

  it('hands a row to the same customer search a call opens, then closes', async () => {
    const { onSearchCustomer } = renderHost()
    fireEvent.click(await railButton())
    const rows = await screen.findAllByTestId('recent-call')

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Αναζήτηση' }))

    expect(onSearchCustomer).toHaveBeenCalledTimes(1)
    const request = onSearchCustomer.mock.calls[0][0]
    expect(request).toMatchObject({
      displayPhone: '2100000142',
      canonicalPhone: '2100000142',
      lookupPhone: '2100000142',
    })
    expect(request.requestKey).toMatch(/^recent-call:row-new:\d+$/)
    expect(() => request.onDisplayed()).not.toThrow()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Searching is not an order: nothing is written to the call record.
    expect(mocks.recordCallAction).not.toHaveBeenCalled()
  })

  it('reads again each time it opens, and never in between', async () => {
    renderHost()
    fireEvent.click(await railButton())
    await screen.findAllByTestId('recent-call')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.actions.close') as string }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.recentCalls).toHaveBeenCalledTimes(1)

    mocks.recentCalls.mockResolvedValue({ retentionDays: 30, calls: [NEW_NUMBER] })
    fireEvent.click(await railButton())

    expect(await screen.findAllByTestId('recent-call')).toHaveLength(1)
    expect(mocks.recentCalls).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toHaveTextContent('1 κλήση')
  })

  it('says so when no call has been recorded yet', async () => {
    mocks.recentCalls.mockResolvedValue({ retentionDays: 30, calls: [] })
    renderHost()
    fireEvent.click(await railButton())

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Δεν έχει καταγραφεί καμία κλήση ακόμη.')).toBeVisible()
    expect(within(dialog).queryByTestId('recent-call')).toBeNull()
    expect(dialog).toHaveTextContent('Οι κλήσεις κρατιούνται 30 ημέρες')
  })

  it('never shows an empty list it could not read: it says so and offers one retry', async () => {
    mocks.recentCalls.mockRejectedValueOnce(new Error('database is locked'))
    renderHost()
    fireEvent.click(await railButton())

    const dialog = await screen.findByRole('dialog')
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Οι κλήσεις δεν διαβάστηκαν. Δοκιμάστε ξανά.')
    expect(dialog.textContent).not.toMatch(/database|locked|error/i)
    expect(within(dialog).queryByText('Δεν έχει καταγραφεί καμία κλήση ακόμη.')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Δοκιμή ξανά' }))

    expect(await within(dialog).findAllByTestId('recent-call')).toHaveLength(4)
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })
})

describe('the time of a call', () => {
  const now = new Date(2026, 10, 23, 21, 0, 0)

  it('is the hour alone on the same calendar day, and carries its date on another', () => {
    expect(recentCallTimeLabel(new Date(2026, 10, 23, 9, 5).toISOString(), now, 'el')).toBe('09:05')
    expect(recentCallTimeLabel(new Date(2026, 10, 22, 23, 50).toISOString(), now, 'el')).toMatch(
      /^22\/11 23:50$/,
    )
    // After midnight the earlier calls of the same Z day keep their date: no "today".
    const afterMidnight = new Date(2026, 10, 24, 0, 30)
    expect(
      recentCallTimeLabel(new Date(2026, 10, 23, 23, 50).toISOString(), afterMidnight, 'el'),
    ).toMatch(/^23\/11 23:50$/)
  })
})

describe('the list in every language of the till', () => {
  const keys = [
    'title',
    'loading',
    'count_one',
    'count_other',
    'knownCustomer',
    'newNumber',
    'withheld',
    'withheldHint',
    'noNumber',
    'noNumberHint',
    'orderStarted',
    'search',
    'empty',
    'loadFailed',
    'retry',
    'retention',
  ]

  it.each(['el', 'en', 'de', 'fr', 'it', 'sq'] as const)('%s has every text of the list', (language) => {
    const block = (localeBundles[language] as { callerid?: { recentCalls?: Record<string, string> } })
      .callerid?.recentCalls
    expect(Object.keys(block ?? {}).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect(block?.[key]?.trim().length, `${language}.${key}`).toBeGreaterThan(0)
    }
    expect(block?.count_one).toContain('{{count}}')
    expect(block?.count_other).toContain('{{count}}')
    expect(block?.retention).toContain('{{days}}')
    if (language !== 'en') {
      // A translation, not the English text left in place.
      const english = localeBundles.en.callerid.recentCalls as Record<string, string>
      for (const key of keys) {
        expect(block?.[key], `${language}.${key}`).not.toBe(english[key])
      }
    }
  })
})

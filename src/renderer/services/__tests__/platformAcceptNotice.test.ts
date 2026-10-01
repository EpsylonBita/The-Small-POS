/**
 * The cashier's notice after an accept the order's platform took with a
 * shorter preparation time (founder decision, 01/10/2026: shorten it and say
 * so). The server's answer to this till's accept says so
 * (`platform_ack.preparation_time`); the native accept passes it on as
 * `order_platform_ack`; the renderer tells the cashier with the server's own
 * numbers and holds no rule of its own about any platform's limit.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import i18next, { type TFunction } from 'i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { emitCompatEvent } from '../../../lib/event-bridge'
import en from '../../../locales/en.json'
import el from '../../../locales/el.json'
import sq from '../../../locales/sq.json'
import {
  ACCEPT_ANSWER_WAIT_MS,
  describeShortenedPreparationTime,
  noticeShortenedPreparationTime,
  ORDER_PLATFORM_ACK_CHANNEL,
  readShortenedPreparationTime,
} from '../platformAcceptNotice'

const shortenedAck = {
  platform: 'efood',
  action: 'approved',
  success: true,
  preparation_time: { requested_minutes: 30, sent_minutes: 27, max_minutes: 27, shortened: true },
}

let t: TFunction

beforeAll(async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, el: { translation: el }, sq: { translation: sq } },
    interpolation: { escapeValue: false },
  })
  t = instance.t.bind(instance) as TFunction
})

afterEach(() => {
  vi.useRealTimers()
})

describe('readShortenedPreparationTime', () => {
  it('reads the numbers of an accept the platform took with a shorter time', () => {
    expect(readShortenedPreparationTime(shortenedAck)).toEqual({
      platform: 'efood',
      requestedMinutes: 30,
      sentMinutes: 27,
      maxMinutes: 27,
    })
  })

  it.each([
    ['a time the platform took as asked', { ...shortenedAck, preparation_time: { requested_minutes: 20, sent_minutes: 20, max_minutes: 27, shortened: false } }],
    ['a refused accept', { ...shortenedAck, success: false }],
    ['another action', { ...shortenedAck, action: 'ready' }],
    ['no preparation time (another platform)', { platform: 'wolt', action: 'approved', success: true }],
    ['numbers missing', { ...shortenedAck, preparation_time: { shortened: true } }],
    ['a released server that sends nothing', undefined],
  ])('shows nothing for %s', (_label, ack) => {
    expect(readShortenedPreparationTime(ack)).toBeNull()
  })
})

describe('describeShortenedPreparationTime', () => {
  it('says what was chosen, what was sent and the most the platform takes, with its name', () => {
    const notice = readShortenedPreparationTime(shortenedAck)!

    expect(describeShortenedPreparationTime(notice, t)).toBe(
      'Efood takes at most 27 min for this order, so 27 min was sent instead of 30 min. '
      + 'If you need longer, change it in the Efood app.',
    )
  })

  it('is translated, Albanian with the informal ti', async () => {
    const notice = readShortenedPreparationTime(shortenedAck)!
    const greek = (await i18next.createInstance().init({
      lng: 'el',
      resources: { el: { translation: el } },
      interpolation: { escapeValue: false },
    })) as TFunction
    const albanian = (await i18next.createInstance().init({
      lng: 'sq',
      resources: { sq: { translation: sq } },
      interpolation: { escapeValue: false },
    })) as TFunction

    expect(describeShortenedPreparationTime(notice, greek)).toBe(
      'Το Efood δέχεται έως 27 λεπ. για αυτή την παραγγελία, οπότε στάλθηκαν 27 λεπ. αντί για 30 λεπ. '
      + 'Αν χρειάζεστε περισσότερο χρόνο, αλλάξτε τον στην εφαρμογή του Efood.',
    )
    expect(describeShortenedPreparationTime(notice, albanian)).toContain('Nëse të duhet më shumë kohë, ndryshoje')
  })
})

describe('noticeShortenedPreparationTime', () => {
  it('tells the cashier once, for the order this till accepted', () => {
    const notify = vi.fn()
    noticeShortenedPreparationTime('order-1', t, { notify })

    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, { orderId: 'order-2', platformAck: shortenedAck })
    expect(notify).not.toHaveBeenCalled()

    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, { orderId: 'order-1', platformAck: shortenedAck })
    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, { orderId: 'order-1', platformAck: shortenedAck })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('27 min was sent instead of 30 min'))
  })

  it('says nothing when the platform took the time as asked', () => {
    const notify = vi.fn()
    noticeShortenedPreparationTime('order-1', t, { notify })

    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, {
      orderId: 'order-1',
      platformAck: { ...shortenedAck, preparation_time: { requested_minutes: 20, sent_minutes: 20, max_minutes: 27, shortened: false } },
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('stops listening for an accept that failed', () => {
    const notify = vi.fn()
    const stop = noticeShortenedPreparationTime('order-1', t, { notify })
    stop()

    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, { orderId: 'order-1', platformAck: shortenedAck })
    expect(notify).not.toHaveBeenCalled()
  })

  it('stops waiting once the accept\'s answer is overdue', () => {
    vi.useFakeTimers()
    const notify = vi.fn()
    noticeShortenedPreparationTime('order-1', t, { notify })

    vi.advanceTimersByTime(ACCEPT_ANSWER_WAIT_MS)
    emitCompatEvent(ORDER_PLATFORM_ACK_CHANNEL, { orderId: 'order-1', platformAck: shortenedAck })
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('the accept answer path, end to end in source', () => {
  const posTauri = path.resolve(__dirname, '..', '..', '..', '..')
  const read = (...segments: string[]) => readFileSync(path.join(posTauri, ...segments), 'utf8')

  it('the native event, its bridge mapping and the renderer channel are one name', () => {
    const rust = read('src-tauri', 'src', 'commands', 'orders.rs')
    expect(rust).toContain('const ORDER_PLATFORM_ACK_EVENT: &str = "order_platform_ack";')
    // Only the accept's own PATCH passes its answer on.
    expect(rust).toMatch(/pub async fn order_approve\([\s\S]*?spawn_immediate_order_accept_patch\(/)
    expect(read('src', 'lib', 'event-bridge.ts')).toContain(`'order_platform_ack': '${ORDER_PLATFORM_ACK_CHANNEL}'`)
  })

  it('the Orders screen starts listening before its accept goes out', () => {
    const dashboard = read('src', 'renderer', 'components', 'OrderDashboard.tsx')
    const handler = dashboard.slice(dashboard.indexOf('const handleApproveOrder = async'))
    const listen = handler.indexOf('noticeShortenedPreparationTime(orderId, t)')
    const accept = handler.indexOf('await approveOrder(orderId, estimatedTime)')
    expect(listen).toBeGreaterThan(-1)
    expect(accept).toBeGreaterThan(listen)
  })

  it('every locale words the notice with the server\'s numbers', () => {
    for (const locale of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
      const messages = JSON.parse(read('src', 'locales', `${locale}.json`))
      const text: string = messages.orderApprovalPanel.preparationShortened
      for (const value of ['{{platform}}', '{{requested}}', '{{sent}}', '{{max}}']) {
        expect(text, `${locale} ${value}`).toContain(value)
      }
    }
  })
})

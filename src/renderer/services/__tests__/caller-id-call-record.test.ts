import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bridge: null as unknown,
  getBridgeThrows: false,
}))

vi.mock('../../../lib', () => ({
  getBridge: () => {
    if (mocks.getBridgeThrows) throw new Error('no bridge')
    return mocks.bridge
  },
}))

import {
  callActionForSearchRequest,
  callRecordReadable,
  loadRecentCalls,
  recentCallSearchRequest,
  recordCallerIdOrderStarted,
  tillRecordsCalls,
  type RecentCall,
} from '../caller-id-call-record'

const LINE_ID = '018f7684-1436-7d3d-a3f8-58b1bf600dbd'
const OCCURRED_AT = '2026-11-23T19:10:00.250Z'
const POPUP_KEY = `call:${LINE_ID}:${Date.parse(OCCURRED_AT)}:allowed:01234567`

const popupRequest = (requestKey = POPUP_KEY) => ({
  displayPhone: '210 123 4567',
  canonicalPhone: '2101234567',
  lookupPhone: '2101234567',
  requestKey,
  onDisplayed: () => {},
})

const call = (over: Partial<RecentCall> = {}): RecentCall => ({
  id: '3f6c1a52-0d0e-4a53-9f0e-1f1c5a3b7d10',
  occurredAt: OCCURRED_AT,
  presentation: 'allowed',
  number: '2101234567',
  customerId: null,
  customerName: null,
  orderStarted: false,
  ...over,
})

beforeEach(() => {
  mocks.bridge = null
  mocks.getBridgeThrows = false
})

describe('which recorded call a customer search belongs to', () => {
  it("names a popup's call by its number and the event's own time", () => {
    expect(callActionForSearchRequest(popupRequest())).toEqual({
      number: '2101234567',
      occurredAt: OCCURRED_AT,
    })
  })

  it('reads the key the call notification really builds', () => {
    // `callerIdEventKey` is private to the hook, and the hook is a file this
    // feature must not change. If its key changes shape, this fails and the
    // parser above has to follow; until then a marked order would silently
    // stop being recorded.
    const hook = readFileSync(
      path.resolve(__dirname, '..', '..', 'hooks', 'useCallerIdNotifications.ts'),
      'utf8',
    )
    const key = hook.slice(hook.indexOf('function callerIdEventKey'))
    expect(key).toMatch(
      /return \[\s*'call',\s*event\.lineId,\s*timeKey,\s*event\.presentation,\s*numberSuffix,\s*\]\.join\(':'\)/,
    )
    expect(key).toMatch(/const occurredAt = Date\.parse\(event\.timestamp\)/)
    expect(key).toMatch(/\? String\(occurredAt\)/)
    expect(hook).toMatch(/requestKey: eventKey,/)
    expect(hook).toMatch(/const canonicalPhone = accepted\.event\.callerNumber\.trim\(\)/)
  })

  it('names a row of the list by its id', () => {
    const request = recentCallSearchRequest(call(), 42)
    expect(request).toMatchObject({
      displayPhone: '2101234567',
      canonicalPhone: '2101234567',
      lookupPhone: '2101234567',
      requestKey: 'recent-call:3f6c1a52-0d0e-4a53-9f0e-1f1c5a3b7d10:42',
    })
    expect(callActionForSearchRequest(request)).toEqual({
      callId: '3f6c1a52-0d0e-4a53-9f0e-1f1c5a3b7d10',
    })
  })

  it('names nothing for a search it cannot place', () => {
    for (const request of [
      null,
      undefined,
      popupRequest('event:abc@ht813'),
      popupRequest(`call:${LINE_ID}:${Date.parse(OCCURRED_AT)}:restricted:private`),
      popupRequest(`call:${LINE_ID}:2026-11-23T19:10:00Z:allowed:01234567`),
      popupRequest('recent-call:'),
      popupRequest(''),
      { ...popupRequest(), canonicalPhone: ' ', displayPhone: '' },
    ]) {
      expect(callActionForSearchRequest(request)).toBeNull()
    }
  })
})

describe('the search a row of the list opens', () => {
  it('searches by the national number, as a call does', () => {
    expect(recentCallSearchRequest(call({ number: '+302101234567' }), 1)).toMatchObject({
      displayPhone: '+302101234567',
      canonicalPhone: '+302101234567',
      lookupPhone: '2101234567',
    })
  })

  it('gives every opening its own key, so the same row can be searched twice', () => {
    expect(recentCallSearchRequest(call(), 1)?.requestKey).not.toBe(
      recentCallSearchRequest(call(), 2)?.requestKey,
    )
  })

  it('opens nothing for a call without a number', () => {
    expect(recentCallSearchRequest(call({ presentation: 'restricted', number: null }))).toBeNull()
    expect(recentCallSearchRequest(call({ presentation: 'unknown', number: null }))).toBeNull()
    expect(recentCallSearchRequest(call({ number: '12' }))).toBeNull()
  })
})

describe('noting that staff went on to an order', () => {
  it("marks the popup's call with the customer staff chose", () => {
    const recordCallAction = vi.fn().mockResolvedValue({ recorded: true })
    mocks.bridge = { callerid: { recordCallAction } }

    recordCallerIdOrderStarted(popupRequest(), { id: 'customer-2' })

    expect(recordCallAction).toHaveBeenCalledExactlyOnceWith({
      number: '2101234567',
      occurredAt: OCCURRED_AT,
      customerId: 'customer-2',
    })
  })

  it("marks the list's row, with no customer when staff went on without one", () => {
    const recordCallAction = vi.fn().mockResolvedValue({ recorded: true })
    mocks.bridge = { callerid: { recordCallAction } }

    recordCallerIdOrderStarted(recentCallSearchRequest(call(), 7), null)

    expect(recordCallAction).toHaveBeenCalledExactlyOnceWith({
      callId: '3f6c1a52-0d0e-4a53-9f0e-1f1c5a3b7d10',
    })
  })

  it('never throws and never leaves a rejection behind, whatever the till answers', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const bridges: unknown[] = [
        null,
        {},
        { callerid: null },
        { callerid: {} },
        { callerid: { recordCallAction: 'not a function' } },
        { callerid: { recordCallAction: () => { throw new Error('database is locked') } } },
        { callerid: { recordCallAction: () => Promise.reject(new Error('database is locked')) } },
        { callerid: { recordCallAction: () => undefined } },
        { callerid: { recordCallAction: () => ({ recorded: false }) } },
      ]
      for (const bridge of bridges) {
        mocks.bridge = bridge
        expect(() => recordCallerIdOrderStarted(popupRequest(), { id: 'customer-1' })).not.toThrow()
        expect(() => recordCallerIdOrderStarted(null, null)).not.toThrow()
      }
      mocks.getBridgeThrows = true
      expect(() => recordCallerIdOrderStarted(popupRequest(), { id: 'customer-1' })).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('asks the till nothing for a search it cannot place', () => {
    const recordCallAction = vi.fn()
    mocks.bridge = { callerid: { recordCallAction } }
    recordCallerIdOrderStarted(popupRequest('event:abc@ht813'), { id: 'customer-1' })
    expect(recordCallAction).not.toHaveBeenCalled()
  })
})

describe('reading the list', () => {
  it('keeps the rows the till sent and drops what it cannot read', async () => {
    const recentCalls = vi.fn().mockResolvedValue({
      retentionDays: 30,
      calls: [
        { id: 'a', occurredAt: OCCURRED_AT, presentation: 'allowed', number: '2101234567', customerId: 'c-1', customerName: 'Μαρία Π.', orderStarted: true },
        { id: 'b', occurredAt: OCCURRED_AT, presentation: 'restricted', number: null, customerId: null, customerName: null, orderStarted: false },
        // A number-less "allowed" row cannot be searched: it reads as unknown.
        { id: 'c', occurredAt: OCCURRED_AT, presentation: 'allowed', number: ' ', customerId: null, customerName: null, orderStarted: false },
        { id: 'd', occurredAt: 'not a time', presentation: 'allowed', number: '2101234567' },
        { occurredAt: OCCURRED_AT, presentation: 'allowed', number: '2101234567' },
        null,
        'row',
      ],
    })
    mocks.bridge = { callerid: { recentCalls } }

    const result = await loadRecentCalls()

    expect(recentCalls).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(result.retentionDays).toBe(30)
    expect(result.calls).toEqual([
      { id: 'a', occurredAt: OCCURRED_AT, presentation: 'allowed', number: '2101234567', customerId: 'c-1', customerName: 'Μαρία Π.', orderStarted: true },
      { id: 'b', occurredAt: OCCURRED_AT, presentation: 'restricted', number: null, customerId: null, customerName: null, orderStarted: false },
      { id: 'c', occurredAt: OCCURRED_AT, presentation: 'unknown', number: null, customerId: null, customerName: null, orderStarted: false },
    ])
  })

  it('fails loudly instead of showing an empty list it did not read', async () => {
    mocks.bridge = { callerid: {} }
    await expect(loadRecentCalls()).rejects.toThrow()
    for (const reply of [null, undefined, {}, { calls: 'none' }, []]) {
      mocks.bridge = { callerid: { recentCalls: vi.fn().mockResolvedValue(reply) } }
      await expect(loadRecentCalls()).rejects.toThrow()
    }
    mocks.bridge = { callerid: { recentCalls: vi.fn().mockRejectedValue(new Error('db lock')) } }
    await expect(loadRecentCalls()).rejects.toThrow()
  })
})

describe('whether this till records calls', () => {
  const recentCalls = vi.fn()

  it.each([
    [{ status: 'listening', callsDetected: 0 }, true],
    [{ status: 'stopped', callsDetected: 3 }, true],
    [{ status: 'error', callsDetected: 1 }, true],
    [{ status: 'stopped', callsDetected: 0 }, false],
    // A till without the plugin can sit in an error state it never leaves.
    [{ status: 'error', callsDetected: 0 }, false],
    [{ status: 'registering' }, false],
    [null, false],
    [undefined, false],
  ])('reads %j as %s', async (status, expected) => {
    mocks.bridge = { callerid: { recentCalls, getStatus: vi.fn().mockResolvedValue(status) } }
    await expect(tillRecordsCalls()).resolves.toBe(expected)
  })

  it('reads any failure as no, and asks nothing of a build that cannot read the record', async () => {
    mocks.bridge = { callerid: { recentCalls, getStatus: vi.fn().mockRejectedValue(new Error('ipc')) } }
    await expect(tillRecordsCalls()).resolves.toBe(false)

    const getStatus = vi.fn().mockResolvedValue({ status: 'listening' })
    mocks.bridge = { callerid: { getStatus } }
    expect(callRecordReadable()).toBe(false)
    await expect(tillRecordsCalls()).resolves.toBe(false)
    expect(getStatus).not.toHaveBeenCalled()

    mocks.getBridgeThrows = true
    expect(callRecordReadable()).toBe(false)
    await expect(tillRecordsCalls()).resolves.toBe(false)
  })
})

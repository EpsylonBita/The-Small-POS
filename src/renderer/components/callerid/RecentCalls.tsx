import { useCallback, useEffect, useRef, useState } from 'react'
import { PhoneIncoming } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../contexts/theme-context'
import type { CallerIdCustomerSearchRequest } from '../../hooks/useCallerIdNotifications'
import {
  callRecordReadable,
  loadRecentCalls,
  recentCallSearchRequest,
  tillRecordsCalls,
  type RecentCall,
  type RecentCalls,
} from '../../services/caller-id-call-record'
import { formatDate, formatTime } from '../../utils/format'
import { UtilityRailCallsSlot } from '../UtilityRail'
import { LiquidGlassModal } from '../ui/pos-glass-components'

/**
 * «Πρόσφατες κλήσεις» (founder, 23/11/2026): the calls this till recorded,
 * behind a phone button in the right rail. It reads the till's own record
 * when it opens and never between; it does not listen for calls, so it cannot
 * stand before a call's popup. A row's one action is the popup's own: search
 * the customer.
 */

/** The listener may still be starting when staff sign in. */
const RECORDING_RECHECK_DELAYS_MS = [5_000, 30_000, 120_000]

/**
 * Whether to show the button: a till without a Caller ID source keeps its
 * three rail buttons. Read from the listener's state in memory; once true it
 * stays true for the session, so a listener that restarts hides nothing.
 */
function useTillRecordsCalls(): boolean {
  const [records, setRecords] = useState(false)
  useEffect(() => {
    if (records || !callRecordReadable()) return
    let cancelled = false
    const check = () => {
      void tillRecordsCalls().then((yes) => {
        if (yes && !cancelled) setRecords(true)
      })
    }
    check()
    const timers = RECORDING_RECHECK_DELAYS_MS.map((delay) => setTimeout(check, delay))
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      window.removeEventListener('focus', check)
    }
  }, [records])
  return records
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; result: RecentCalls }

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/**
 * The hour of a call, with its date when the call is from another calendar
 * day. No "today": on a till the day is the Z's, not the calendar's.
 */
export function recentCallTimeLabel(occurredAt: string, now: Date, locale?: string): string {
  const at = new Date(occurredAt)
  const time = formatTime(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locale)
  return sameLocalDay(at, now)
    ? time
    : `${formatDate(at, { day: '2-digit', month: '2-digit' }, locale)} ${time}`
}

function RecentCallRow({
  call,
  now,
  onSearch,
}: {
  call: RecentCall
  now: Date
  onSearch: (call: RecentCall) => void
}) {
  const { t, i18n } = useTranslation()
  const known = Boolean(call.customerId)
  const title =
    call.presentation === 'restricted'
      ? t('callerid.recentCalls.withheld')
      : call.presentation === 'unknown'
        ? t('callerid.recentCalls.noNumber')
        : call.customerName || call.number
  return (
    <li
      className="flex min-h-14 items-center gap-4 border-b border-(--modal-glass-card-border) py-2 last:border-b-0"
      data-testid="recent-call"
      data-call-state={
        call.presentation !== 'allowed' ? call.presentation : known ? 'known' : 'new'
      }
    >
      <time
        dateTime={call.occurredAt}
        className="w-28 shrink-0 text-base tabular-nums"
      >
        {recentCallTimeLabel(call.occurredAt, now, i18n.language)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">{title}</p>
        <p className="text-sm text-(--pos-s-muted)">
          {call.presentation === 'restricted' && t('callerid.recentCalls.withheldHint')}
          {call.presentation === 'unknown' && t('callerid.recentCalls.noNumberHint')}
          {call.presentation === 'allowed' && (
            <>
              {call.customerName && <span className="tabular-nums">{call.number} · </span>}
              {/* Colour only on the state word: a plain word, no chip. */}
              <span className={known ? 'text-(--pos-s-ok)' : 'text-(--pos-s-warn)'}>
                {t(known ? 'callerid.recentCalls.knownCustomer' : 'callerid.recentCalls.newNumber')}
              </span>
            </>
          )}
          {call.orderStarted && (
            <>
              {' · '}
              <span className="text-(--pos-s-fg)" data-testid="recent-call-order-started">
                {t('callerid.recentCalls.orderStarted')}
              </span>
            </>
          )}
        </p>
      </div>
      {call.presentation === 'allowed' && call.number && (
        <button
          type="button"
          onClick={() => onSearch(call)}
          className="pos-raised min-h-touch shrink-0 rounded-xl px-4 text-base font-medium"
        >
          {t('callerid.recentCalls.search')}
        </button>
      )}
    </li>
  )
}

function RecentCallsModal({
  isOpen,
  onClose,
  onSearch,
}: {
  isOpen: boolean
  onClose: () => void
  onSearch: (call: RecentCall) => void
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<ListState>({ phase: 'loading' })
  const [now, setNow] = useState(() => new Date())
  const readRef = useRef(0)

  const read = useCallback(() => {
    const thisRead = readRef.current + 1
    readRef.current = thisRead
    setState({ phase: 'loading' })
    setNow(new Date())
    loadRecentCalls().then(
      (result) => {
        if (readRef.current === thisRead) setState({ phase: 'ready', result })
      },
      () => {
        if (readRef.current === thisRead) setState({ phase: 'failed' })
      },
    )
  }, [])

  // One read per opening: the list is a look back, not a live view.
  useEffect(() => {
    if (isOpen) read()
    // A reply for a closed list is dropped.
    return () => {
      readRef.current += 1
    }
  }, [isOpen, read])

  const calls = state.phase === 'ready' ? state.result.calls : []

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('callerid.recentCalls.title')}
      size="lg"
    >
      <div className="liquid-glass-modal-text space-y-3" data-testid="recent-calls">
        {state.phase === 'loading' && (
          <p role="status" className="text-(--pos-s-muted)">
            {t('callerid.recentCalls.loading')}
          </p>
        )}
        {state.phase === 'failed' && (
          <div className="space-y-3">
            <p role="alert">{t('callerid.recentCalls.loadFailed')}</p>
            <button
              type="button"
              onClick={read}
              className="pos-raised min-h-touch rounded-xl px-4 text-base font-medium"
            >
              {t('callerid.recentCalls.retry')}
            </button>
          </div>
        )}
        {state.phase === 'ready' && calls.length === 0 && (
          <p>{t('callerid.recentCalls.empty')}</p>
        )}
        {state.phase === 'ready' && calls.length > 0 && (
          <>
            <p className="text-sm text-(--pos-s-muted)">
              {t('callerid.recentCalls.count', { count: calls.length })}
            </p>
            <ul className="pos-glass-form-card max-h-[55vh] overflow-y-auto py-1">
              {calls.map((call) => (
                <RecentCallRow key={call.id} call={call} now={now} onSearch={onSearch} />
              ))}
            </ul>
          </>
        )}
        {state.phase === 'ready' && (
          <p className="text-sm text-(--pos-s-muted)">
            {t('callerid.recentCalls.retention', { days: state.result.retentionDays })}
          </p>
        )}
      </div>
    </LiquidGlassModal>
  )
}

/**
 * The rail's phone button and the list behind it. Renders nothing on a till
 * that does not record calls, and nothing in a build whose bridge cannot read
 * the record: such a till mounts none of the list, so it asks nothing of the
 * theme, the language or the rail.
 */
export function RecentCallsHost({
  onSearchCustomer,
}: {
  onSearchCustomer: (request: CallerIdCustomerSearchRequest) => void
}) {
  const records = useTillRecordsCalls()
  return records ? <RecentCallsButtonAndList onSearchCustomer={onSearchCustomer} /> : null
}

function RecentCallsButtonAndList({
  onSearchCustomer,
}: {
  onSearchCustomer: (request: CallerIdCustomerSearchRequest) => void
}) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const [isOpen, setIsOpen] = useState(false)

  const search = useCallback(
    (call: RecentCall) => {
      const request = recentCallSearchRequest(call)
      if (!request) return
      // The list closes first: the search is the same window a call opens,
      // and it waits its turn behind a search that is already open.
      setIsOpen(false)
      onSearchCustomer(request)
    },
    [onSearchCustomer],
  )

  return (
    <>
      <UtilityRailCallsSlot>
        <button
          type="button"
          data-utility-rail-calls
          onClick={() => setIsOpen(true)}
          className={`flex h-12 w-12 items-center justify-center rounded-xl transition-transform focus:outline-hidden active:scale-95 ${resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-black'}`}
          aria-label={t('callerid.recentCalls.title')}
        >
          <PhoneIncoming className="h-5 w-5" aria-hidden="true" />
        </button>
      </UtilityRailCallsSlot>
      <RecentCallsModal isOpen={isOpen} onClose={() => setIsOpen(false)} onSearch={search} />
    </>
  )
}

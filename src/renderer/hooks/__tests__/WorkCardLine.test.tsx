import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkCardLine, type WorkCardState } from '../useWorkCardStatus'
import el from '../../../locales/el.json'
import en from '../../../locales/en.json'
import de from '../../../locales/de.json'
import fr from '../../../locales/fr.json'
import itLocale from '../../../locales/it.json'
import sq from '../../../locales/sq.json'
vi.mock('../useTerminalSettings', () => ({ default: () => ({ getSetting: () => null }) }))
vi.mock('../../utils/api-helpers', () => ({ posApiGet: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options: { time: string }) => String((en.workCard as Record<string, string>)[key.split('.')[1]]).replace('{{time}}', options.time),
  i18n: { language: 'en' },
}) }))
afterEach(cleanup)

const ID = '11111111-1111-4111-8111-111111111111'
const status = (state: WorkCardState, offline = false) => ({ scope: 'main', offline, data: {
  enabled: true as const, mode: 'dry_run' as const, attention_count: 0,
  staff: [{ staff_id: ID, state, punch: 'start' as const, at: null, sent_at: '2026-10-31T09:23:00Z', protocol: null, action_required: null, at_risk: false }],
} })
const locales = [el, en, de, fr, itLocale, sq]
describe('work card lines and translations', () => {
  it('uses matching vocabulary keys and interpolation in every language', () => {
    for (const locale of locales) {
      expect(Object.keys(locale.workCard).sort()).toEqual(Object.keys(en.workCard).sort())
      expect(locale.workCard.sent).toContain('{{time}}')
      expect(locale.workCard.attention).toContain('{{count}}')
      expect(locale.workCard.dry_run).not.toBe(locale.workCard.sent)
      for (const text of Object.values(locale.workCard)) expect(text).not.toMatch(/\uFFFD/)
    }
    expect(en.workCard.dry_run).toBe('Work card: test, not sent')
  })
  it('renders each state, actual send time, and the offline line on a solid surface', () => {
    for (const state of ['sent', 'pending', 'dry_run', 'late', 'missing_exit', 'needs_action'] as const) {
      const view = render(<WorkCardLine status={status(state)} staffId={ID} />)
      const text = en.workCard[state].replace('{{time}}', new Date('2026-10-31T09:23:00Z').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }))
      expect(screen.getByText(text)).toBeTruthy()
      view.unmount()
    }
    const view = render(<WorkCardLine status={status('pending', true)} staffId={ID} />)
    expect(screen.getByText(en.workCard.offline)).toBeTruthy()
    view.unmount()
    render(<WorkCardLine status={status('none')} staffId={ID} />)
    expect(screen.queryByTestId('work-card-status')).toBeNull()
  })
})

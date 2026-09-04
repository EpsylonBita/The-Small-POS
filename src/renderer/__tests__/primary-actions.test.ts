import { describe, expect, it } from 'vitest'
import { resolveTauriPrimaryActions } from '../primary-actions'
import {
  POS_COMING_SOON_MODULES,
  POS_IMPLEMENTED_MODULES,
} from '../../shared/constants/pos-modules'
import en from '../../locales/en.json'
import el from '../../locales/el.json'
import de from '../../locales/de.json'
import fr from '../../locales/fr.json'
import italian from '../../locales/it.json'

describe('Tauri primary action contract', () => {
  it('uses the terminal-filtered module set and exposes the implemented repair workflow', () => {
    expect(resolveTauriPrimaryActions(['orders', 'repairs'], true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'new_sale', enabled: true }),
        expect.objectContaining({ id: 'new_repair', enabled: true, availability: 'ready' }),
        expect.objectContaining({ id: 'quick_service', enabled: true, availability: 'ready' }),
      ]),
    )
  })

  it('marks repairs implemented only in the Tauri module registry', () => {
    expect(POS_COMING_SOON_MODULES.has('repairs')).toBe(false)
    expect(POS_IMPLEMENTED_MODULES.has('repairs')).toBe(true)
  })

  it.each([en, el, de, fr, italian])('translates every rendered shared action key', (locale) => {
    const actions = resolveTauriPrimaryActions(['orders', 'appointments', 'repairs'], true)
    const translations = (locale as unknown as {
      primaryActions?: Record<string, string | { comingSoon?: string }>
    }).primaryActions
    expect(translations).toBeDefined()
    if (!translations) return
    for (const action of actions) {
      const labelKey = (action as unknown as { labelKey?: string }).labelKey
      expect(labelKey).toEqual(expect.any(String))
      if (!labelKey) continue
      const key = labelKey.replace('primaryActions.', '')
      expect(translations[key]).toEqual(expect.any(String))
    }
    expect(translations.trigger).toEqual(expect.any(String))
    expect((translations.status as { comingSoon?: string } | undefined)?.comingSoon).toEqual(expect.any(String))
  })
})

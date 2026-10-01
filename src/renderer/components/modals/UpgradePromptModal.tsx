import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { getFallbackModuleMetadata } from '../../../shared/services/moduleMetadataFallback'
import type { ModuleId } from '../../../shared/types/modules'
import { getDisplayPurchaseGuidance } from '@shared/modules/display-purchase-guidance'
import { launchPurchaseDisplay, launchPriceText, isPurchaseOrganizationId, type LaunchPurchaseDisplay } from '@shared/services/launchPurchaseDisplay'
import { generateModulePurchaseUrl } from '@shared/services/upsellUrlService'
import type { PublicLaunchCatalogDTO } from '@shared/types/launchCatalog'
import { normalizeModuleId } from '../../../shared/constants/pos-modules'
import { resolveViewModuleId } from '../../utils/module-view-access'
import { posApiFetch } from '../../utils/api-helpers'
import { openExternalUrl } from '../../utils/external-url'
import { readLaunchPurchaseContext } from '../../services/launchPurchaseEntry'
import { onEvent, offEvent } from '../../../lib'
import { DisplayPurchaseGuidance } from '../modules/DisplayPurchaseGuidance'

interface UpgradePromptModalProps { isOpen: boolean; onClose: () => void; moduleId?: string; requiredPlan?: string }

const UpgradePromptModal: React.FC<UpgradePromptModalProps> = ({ isOpen, onClose, moduleId }) => {
  const { t, i18n } = useTranslation()
  const feature = normalizeModuleId(resolveViewModuleId(moduleId || '')) || moduleId || ''
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState<{ feature: string; offer: LaunchPurchaseDisplay; context: Awaited<ReturnType<typeof readLaunchPurchaseContext>> } | null>(null)
  const lifecycle = useRef({ key: '', generation: 0, mounted: true, closing: false, busy: false })
  const key = `${isOpen}:${feature}`
  if (lifecycle.current.key !== key) {
    lifecycle.current.key = key; lifecycle.current.generation += 1
    lifecycle.current.closing = false; lifecycle.current.busy = false
  }
  useEffect(() => {
    lifecycle.current.mounted = true
    return () => { lifecycle.current.mounted = false; lifecycle.current.generation += 1 }
  }, [])
  useEffect(() => {
    const changed = () => {
      lifecycle.current.generation += 1; lifecycle.current.busy = false
      setLoaded(null); setBusy(false); setReload(value => value + 1)
    }
    onEvent('terminal-settings-updated', changed)
    return () => { offEvent('terminal-settings-updated', changed) }
  }, [])
  useEffect(() => {
    let live = true
    const generation = ++lifecycle.current.generation
    setLoaded(null); setError(false); setBusy(false); setLoading(false)
    lifecycle.current.busy = false
    if (!isOpen || !feature || feature === 'ai_assistant' || feature === 'plugin_integrations') return
    setLoading(true)
    const current = () => live && lifecycle.current.mounted && !lifecycle.current.closing && lifecycle.current.generation === generation
    void (async () => {
      try {
        const context = await readLaunchPurchaseContext()
        if (!isPurchaseOrganizationId(context.organizationId) || !current()) return
        const response = await posApiFetch<PublicLaunchCatalogDTO>('/api/modules/launch-catalog', { method: 'GET' })
        const fresh = await readLaunchPurchaseContext()
        const offer = response.success ? launchPurchaseDisplay(response.data, feature) : null
        if (current() && context.key === fresh.key && offer) setLoaded({ feature, offer, context })
      } catch { /* The unavailable state offers an explicit retry. */ }
      finally { if (current()) setLoading(false) }
    })()
    return () => { live = false }
  }, [isOpen, feature, reload])
  const offer = loaded?.feature === feature ? loaded.offer : null
  const metadata = feature ? getFallbackModuleMetadata(feature as ModuleId) : null
  const guidance = getDisplayPurchaseGuidance(feature)
  const openPurchase = async () => {
    if (!loaded || !offer || !isOpen || lifecycle.current.closing || lifecycle.current.busy) return
    const generation = lifecycle.current.generation
    const current = () => lifecycle.current.mounted && !lifecycle.current.closing && lifecycle.current.generation === generation
    lifecycle.current.busy = true; setBusy(true); setError(false)
    try {
      const fresh = await readLaunchPurchaseContext()
      if (!current()) return
      if (!isPurchaseOrganizationId(fresh.organizationId) || fresh.key !== loaded.context.key) {
        setLoaded(null); setReload(value => value + 1); return
      }
      const url = generateModulePurchaseUrl(fresh.adminUrl, feature, {
        organizationId: fresh.organizationId, billingCycle: cycle, source: 'pos_tauri', context: 'locked_module',
      })
      const opened = await openExternalUrl(url)
      if (current() && !opened) setError(true)
    } catch { if (current()) setError(true) }
    finally { if (current()) { lifecycle.current.busy = false; setBusy(false) } }
  }
  return (
    <LiquidGlassModal isOpen={isOpen} onClose={onClose}
      onCloseIntent={() => { lifecycle.current.closing = true; lifecycle.current.generation += 1 }}
      title={t('modules.launchPurchase.title')} size="md" className="!max-w-lg" closeOnBackdrop closeOnEscape>
      <div className="space-y-5">
        <h3 className="text-xl font-bold">{metadata?.name || feature || t('modules.unknownModule', { defaultValue: 'This feature' })}</h3>
        {guidance ? <p>{t(guidance.summaryKey)}</p> : metadata?.description ? <p>{metadata.description}</p> : null}
        {guidance && <DisplayPurchaseGuidance moduleId={feature} />}
        {offer ? <section className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 space-y-3">
          <h4 className="font-semibold">{offer.name}</h4>
          <div className="flex gap-3" role="group" aria-label={t('modules.launchPurchase.cycle')}>
            {(['monthly', 'annual'] as const).map(value => <button key={value} type="button" aria-pressed={cycle === value}
              onClick={() => setCycle(value)} className={liquidGlassModalButton(cycle === value ? 'primary' : 'secondary', 'sm')}>
              {t(`modules.launchPurchase.${value}`)}
            </button>)}
          </div>
          <p className="text-2xl font-bold">{launchPriceText(offer, cycle, i18n?.language)} / {t(`modules.launchPurchase.${cycle}`)}</p>
          {offer.includes.length > 0 && <p>{t('modules.launchPurchase.includes', { features: offer.includes.join(', ') })}</p>}
          {offer.includedIn.length > 0 && <p>{t('modules.launchPurchase.alsoIncluded', { offers: offer.includedIn.join(', ') })}</p>}
          {offer.resources && <p>{t('modules.launchPurchase.resources', { branches: offer.resources.branches, terminals: offer.resources.posTerminals })}</p>}
          {offer.staffLimit !== undefined && <p>{offer.staffLimit === null ? t('modules.launchPurchase.staffIncluded') : t('modules.launchPurchase.staffLimit', { count: offer.staffLimit })}</p>}
        </section> : <p role="status">{t(loading ? 'modules.launchPurchase.loading' : 'modules.launchPurchase.unavailable')}</p>}
        <p className="text-sm">{t('modules.launchPurchase.confirmInBrowser')}</p>
        {error && <p role="alert">{t('modules.launchPurchase.openFailed')}</p>}
        {offer ? <button type="button" disabled={busy} onClick={() => void openPurchase()} className={liquidGlassModalButton('primary', 'lg')}>
          {t('modules.launchPurchase.open')}
        </button> : <button type="button" disabled={loading} onClick={() => setReload(value => value + 1)} className={liquidGlassModalButton('secondary', 'md')}>
          {t('modules.launchPurchase.retry')}
        </button>}
      </div>
    </LiquidGlassModal>
  )
}
export default UpgradePromptModal

import { useTranslation } from 'react-i18next'
import { getDisplayPurchaseGuidance } from '@shared/modules/display-purchase-guidance'

export function DisplayPurchaseGuidance({ moduleId, compact = false }: { moduleId: string; compact?: boolean }) {
  const { t } = useTranslation()
  const guidance = getDisplayPurchaseGuidance(moduleId)
  if (!guidance) return null

  return (
    <section data-testid={`display-purchase-guidance-${guidance.moduleId}`} aria-label={t(guidance.titleKey)} className="space-y-3 rounded-xl border border-white/10 p-4 text-sm">
      <h5 className="liquid-glass-modal-text font-semibold">{t(guidance.titleKey)}</h5>
      {compact ? <p className="liquid-glass-modal-text-muted leading-6">{t(guidance.compactRequirementKey)}</p> : guidance.sections.map(section => (
        <div key={section.titleKey} className="space-y-2">
          <h6 className="liquid-glass-modal-text font-medium">{t(section.titleKey)}</h6>
          {section.bodyKeys.map(key => <p key={key} className="liquid-glass-modal-text-muted leading-6">{t(key)}</p>)}
        </div>
      ))}
    </section>
  )
}

import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, ChefHat, HandPlatter, type LucideIcon } from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import { isActiveLocalKitchenOrder, overlayKitchenStatus, readCanonicalKitchenStatus } from '../../services/KdsLocalOrders';
import {
  readLocalPreparationPhase,
  type LocalPreparationPhase,
  type LocalPreparationSnapshot,
} from '../../services/KdsLocalPhaseStore';

/**
 * Local kitchen handoff stage on the central order views (dashboard cards and
 * Orders page rows). Display only: the stage comes from this terminal's KDS
 * marks and never changes canonical order status, payment, filters or lanes.
 * "Collected" means a waiter picked the order up from the kitchen, not that the
 * order is paid or closed.
 */

/** The kitchen stage to show on an order row; only while its canonical status is active. */
export function selectActiveKitchenStage(
  snapshot: LocalPreparationSnapshot,
  order: unknown,
): LocalPreparationPhase | undefined {
  if (!order || typeof order !== 'object') return undefined;
  const record = order as Record<string, unknown>;
  if (!isActiveLocalKitchenOrder(record)) return undefined;
  const phase = readLocalPreparationPhase(snapshot, order);
  if (!phase || phase === 'collected') return phase;
  const stage = overlayKitchenStatus(readCanonicalKitchenStatus(record), phase);
  return stage === 'preparing' || stage === 'ready' ? stage : undefined;
}

const STAGE_ICONS: Record<LocalPreparationPhase, LucideIcon> = {
  preparing: ChefHat,
  ready: BellRing,
  collected: HandPlatter,
};

// Amber / emerald / neutral zinc, readable on the cream light card and the dark card.
const STAGE_TONES: Record<LocalPreparationPhase, { light: string; dark: string }> = {
  preparing: {
    light: 'bg-amber-100 text-amber-800 border-amber-300',
    dark: 'bg-amber-500/15 text-amber-200 border-amber-400/40',
  },
  ready: {
    light: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    dark: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40',
  },
  collected: {
    light: 'bg-zinc-100 text-zinc-700 border-zinc-300',
    dark: 'bg-zinc-500/20 text-zinc-200 border-zinc-400/35',
  },
};

// `sm` matches the OrderCard status pill, `md` the Orders page row pill.
const SIZES = {
  sm: { badge: 'gap-1 px-2 py-0.5 text-[10px] sm:text-xs font-semibold', icon: 'h-3 w-3' },
  md: { badge: 'gap-1.5 px-3 py-1.5 text-[13px] leading-none font-semibold', icon: 'h-3.5 w-3.5' },
} as const;

export interface KitchenStageBadgeProps {
  phase: LocalPreparationPhase;
  size?: keyof typeof SIZES;
  className?: string;
}

export const KitchenStageBadge = memo<KitchenStageBadgeProps>(({ phase, size = 'sm', className = '' }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const Icon = STAGE_ICONS[phase];
  if (!Icon) return null;

  const label =
    phase === 'preparing'
      ? t('orders.kitchenStage.preparing', 'Kitchen: preparing')
      : phase === 'ready'
        ? t('orders.kitchenStage.ready', 'Kitchen: ready for pickup')
        : t('orders.kitchenStage.collected', 'Collected from kitchen');
  const tone = resolvedTheme === 'light' ? STAGE_TONES[phase].light : STAGE_TONES[phase].dark;

  return (
    <span
      data-testid="kitchen-stage-badge"
      data-kitchen-stage={phase}
      className={`inline-flex w-fit min-w-0 max-w-full items-center rounded-full border whitespace-nowrap ${SIZES[size].badge} ${tone} ${className}`}
    >
      <Icon aria-hidden="true" className={`shrink-0 ${SIZES[size].icon}`} strokeWidth={2.25} />
      <span className="truncate">{label}</span>
    </span>
  );
});

KitchenStageBadge.displayName = 'KitchenStageBadge';
export default KitchenStageBadge;

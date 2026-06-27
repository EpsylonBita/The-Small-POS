import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Lock, Sparkles } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { liquidGlassModalButton } from '../../styles/designSystem';
import { getFallbackModuleMetadata } from '../../../shared/services/moduleMetadataFallback';
import { useTheme } from '../../contexts/theme-context';
import type { ModuleId } from '../../../shared/types/modules';

interface UpgradePromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  moduleId?: string;
  requiredPlan?: string;
}

const UpgradePromptModal: React.FC<UpgradePromptModalProps> = ({
  isOpen,
  onClose,
  moduleId,
  requiredPlan = 'Professional',
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Use local fallback metadata when the synced module payload is unavailable here.
  const moduleMetadata = moduleId ? getFallbackModuleMetadata(moduleId as ModuleId) : null;
  const moduleName = moduleMetadata?.name || moduleId || t('modules.unknownModule', { defaultValue: 'This feature' });
  const moduleDescription = moduleMetadata?.description || '';

  const handleUpgradeClick = () => {
    console.log('Upgrade requested for module:', moduleId, 'to plan:', requiredPlan);
    alert(t('modules.upgradeComingSoon', {
      defaultValue: 'Upgrade functionality coming soon! Contact your administrator to upgrade your plan.',
    }));
  };

  const handleLearnMoreClick = () => {
    console.log('Learn more requested for module:', moduleId);
    alert(t('modules.learnMoreComingSoon', {
      defaultValue: 'Visit our website or contact support to learn more about premium features.',
    }));
  };

  const benefits = [
    t('modules.benefits.feature1', { defaultValue: 'Access advanced features and tools' }),
    t('modules.benefits.feature2', { defaultValue: 'Priority customer support' }),
    t('modules.benefits.feature3', { defaultValue: 'Unlimited usage and storage' }),
    t('modules.benefits.feature4', { defaultValue: 'Regular updates and new features' }),
  ];

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modules.upgradeRequired', { defaultValue: 'Upgrade Required' })}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="space-y-6">
        <div className="flex flex-col items-center text-center">
          <div
            className={`mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border shadow-lg ${
              isDark
                ? 'border-amber-400/35 bg-amber-400/15 text-amber-200 shadow-[0_18px_42px_rgba(251,191,36,0.14)]'
                : 'border-amber-500/30 bg-amber-100 text-amber-700 shadow-[0_18px_42px_rgba(245,158,11,0.14)]'
            }`}
          >
            <Lock className="h-8 w-8" />
          </div>
          <h3 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {moduleName}
          </h3>
          {moduleDescription && (
            <p className={`mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {moduleDescription}
            </p>
          )}
        </div>

        <div className={`rounded-2xl border p-4 ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-100'}`}>
          <p className={`text-center ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            {t('modules.upgradeMessage', {
              plan: requiredPlan,
              defaultValue: `This feature requires the ${requiredPlan} plan to access.`,
            })}
          </p>
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-yellow-500" />
            <h4 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('modules.benefits.title', { defaultValue: "What you'll get:" })}
            </h4>
          </div>
          <ul className="space-y-2">
            {benefits.map((benefit, index) => (
              <li key={index} className="flex items-start gap-2">
                <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-500" />
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  {benefit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div
          className={`rounded-2xl border p-4 ${
            isDark
              ? 'border-amber-400/25 bg-gradient-to-br from-amber-400/14 to-white/[0.04]'
              : 'border-amber-200 bg-gradient-to-br from-amber-50 to-white'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex-1 text-center">
              <div className={`text-xs uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('modules.currentPlan', { defaultValue: 'Current Plan' })}
              </div>
              <div className={`font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Starter
              </div>
            </div>
            <div className={`px-3 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>-&gt;</div>
            <div className="flex-1 text-center">
              <div className={`text-xs uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('modules.requiredPlan', { defaultValue: 'Required Plan' })}
              </div>
              <div className={`font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                {requiredPlan}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            onClick={handleUpgradeClick}
            className={`flex-1 ${liquidGlassModalButton('primary', 'lg')} flex items-center justify-center gap-2`}
          >
            <Sparkles className="h-5 w-5" />
            {t('modules.actions.upgradeNow', { defaultValue: 'Upgrade Now' })}
          </button>
          <button
            onClick={handleLearnMoreClick}
            className={`flex-1 ${liquidGlassModalButton('secondary', 'md')} flex items-center justify-center`}
          >
            {t('modules.actions.learnMore', { defaultValue: 'Learn More' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default UpgradePromptModal;

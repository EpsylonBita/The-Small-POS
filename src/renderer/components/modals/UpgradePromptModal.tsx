import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Sparkles, Check } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { liquidGlassModalButton } from '../../styles/designSystem';
import { getModuleMetadata } from '../../../shared/services/moduleRegistry';
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

  // Get module metadata for display
  const moduleMetadata = moduleId ? getModuleMetadata(moduleId as ModuleId) : null;
  const moduleName = moduleMetadata?.name || moduleId || t('modules.unknownModule', { defaultValue: 'This feature' });
  const moduleDescription = moduleMetadata?.description || '';

  const handleUpgradeClick = () => {
    console.log('🚀 Upgrade requested for module:', moduleId, 'to plan:', requiredPlan);
    alert(t('modules.upgradeComingSoon', { 
      defaultValue: 'Upgrade functionality coming soon! Contact your administrator to upgrade your plan.' 
    }));
  };

  const handleLearnMoreClick = () => {
    console.log('📚 Learn more requested for module:', moduleId);
    alert(t('modules.learnMoreComingSoon', { 
      defaultValue: 'Visit our website or contact support to learn more about premium features.' 
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
        {/* Header Section with Lock Icon */}
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg">
            <Lock className="w-8 h-8 text-white" />
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

        {/* Upgrade Message */}
        <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-gray-100'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <p className={`text-center ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            {t('modules.upgradeMessage', { 
              plan: requiredPlan,
              defaultValue: `This feature requires the ${requiredPlan} plan to access.`
            })}
          </p>
        </div>

        {/* Benefits Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-yellow-500" />
            <h4 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('modules.benefits.title', { defaultValue: "What you'll get:" })}
            </h4>
          </div>
          <ul className="space-y-2">
            {benefits.map((benefit, index) => (
              <li key={index} className="flex items-start gap-2">
                <Check className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  {benefit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Plan Comparison */}
        <div className={`p-4 rounded-xl bg-gradient-to-br ${isDark ? 'from-blue-500/20 to-purple-500/10' : 'from-blue-50 to-purple-50'} border ${isDark ? 'border-blue-500/30' : 'border-blue-200'}`}>
          <div className="flex items-center justify-between">
            <div className="text-center flex-1">
              <div className={`text-xs uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('modules.currentPlan', { defaultValue: 'Current Plan' })}
              </div>
              <div className={`font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Starter
              </div>
            </div>
            <div className={`px-3 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>→</div>
            <div className="text-center flex-1">
              <div className={`text-xs uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('modules.requiredPlan', { defaultValue: 'Required Plan' })}
              </div>
              <div className="font-semibold text-blue-500">
                {requiredPlan}
              </div>
            </div>
          </div>
        </div>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={handleUpgradeClick}
            className={`flex-1 ${liquidGlassModalButton('primary', 'lg')} flex items-center justify-center gap-2`}
          >
            <Sparkles className="w-5 h-5" />
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

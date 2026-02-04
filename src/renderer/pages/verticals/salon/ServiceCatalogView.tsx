import React, { memo, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useServices } from '../../../hooks/useServices';
import { Scissors, Clock, Search, Plus, Edit2, Trash2, Loader2, RefreshCw } from 'lucide-react';
import type { Service, ServiceCategory } from '../../../services/ServicesService';
import { formatCurrency } from '../../../utils/format';

export const ServiceCatalogView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();

  // Get branchId and organizationId from terminal config (same pattern as AppointmentsView)
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);

  // Load config from multiple sources
  useEffect(() => {
    const loadConfig = async () => {
      let bid = localStorage.getItem('branch_id');
      let oid = localStorage.getItem('organization_id');

      if ((!bid || !oid) && window.electron?.ipcRenderer) {
        try {
          if (!bid) {
            const branchResult = await window.electron.ipcRenderer.invoke('terminal-config:get-branch-id');
            if (branchResult) {
              bid = branchResult;
              localStorage.setItem('branch_id', bid as string);
            }
          }
          if (!oid) {
            const orgResult = await window.electron.ipcRenderer.invoke('terminal-config:get-organization-id');
            if (orgResult) {
              oid = orgResult;
              localStorage.setItem('organization_id', oid as string);
            }
          }
          if (!bid || !oid) {
            const settings = await window.electron.ipcRenderer.invoke('terminal-config:get-settings');
            if (!bid) {
              bid = settings?.['terminal.branch_id'] || settings?.terminal?.branch_id || null;
              if (bid) localStorage.setItem('branch_id', bid);
            }
            if (!oid) {
              oid = settings?.['terminal.organization_id'] || settings?.terminal?.organization_id || null;
              if (oid) localStorage.setItem('organization_id', oid);
            }
          }
        } catch (err) {
          console.warn('[ServiceCatalogView] Failed to get terminal config:', err);
        }
      }

      console.log('[ServiceCatalogView] Loaded config - branchId:', bid, 'orgId:', oid);
      setBranchId(bid);
      setLocalOrgId(oid);
    };

    loadConfig();

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      console.log('[ServiceCatalogView] Config updated:', data);
      if (data.branch_id) {
        setBranchId(data.branch_id);
        localStorage.setItem('branch_id', data.branch_id);
      }
      if (data.organization_id) {
        setLocalOrgId(data.organization_id);
        localStorage.setItem('organization_id', data.organization_id);
      }
    };

    window.electron?.ipcRenderer?.on('terminal-config-updated', handleConfigUpdate);
    return () => {
      window.electron?.ipcRenderer?.removeListener('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  const effectiveOrgId = organizationId || localOrgId || '';

  const [activeTab, setActiveTab] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatPrice = (amount: number) => formatCurrency(amount);

  // Fetch services using the hook
  const {
    services,
    categories,
    stats,
    isLoading,
    error,
    refetch,
  } = useServices({
    branchId: branchId || '',
    organizationId: effectiveOrgId,
    enableRealtime: true,
  });

  // Build tabs from categories
  const tabs = useMemo(() => {
    const categoryTabs = categories.map(cat => ({
      id: cat.id,
      name: cat.name,
    }));
    return [{ id: 'all', name: t('common.all', { defaultValue: 'All' }) }, ...categoryTabs];
  }, [categories, t]);

  // Filter services
  const filteredServices = useMemo(() => {
    return services.filter(s => {
      const matchesTab = activeTab === 'all' || s.categoryId === activeTab;
      const matchesSearch = !searchTerm ||
        s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(searchTerm.toLowerCase());
      return matchesTab && matchesSearch;
    });
  }, [services, activeTab, searchTerm]);

  // Get count per category
  const getCategoryCount = (categoryId: string) => {
    if (categoryId === 'all') return services.length;
    return services.filter(s => s.categoryId === categoryId).length;
  };

  // Show loading or error state
  if (!branchId || !effectiveOrgId) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {t('serviceCatalog.selectBranch', { defaultValue: 'Please select a branch to view services' })}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        {/* Stats */}
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('serviceCatalog.stats.totalServices', { defaultValue: 'Total Services' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.totalServices}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('serviceCatalog.stats.activeServices', { defaultValue: 'Active' })}
            </div>
            <div className={`text-xl font-bold text-green-500`}>{stats.activeServices}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('serviceCatalog.stats.avgPrice', { defaultValue: 'Avg Price' })}
            </div>
            <div className={`text-xl font-bold text-blue-500`}>{formatPrice(stats.avgPrice)}</div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className={`p-2 rounded-lg ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('serviceCatalog.searchPlaceholder', { defaultValue: 'Search services...' })}
              className={`pl-10 pr-4 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
            />
          </div>
          <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="w-4 h-4" />
            {t('serviceCatalog.addService', { defaultValue: 'Add Service' })}
          </button>
        </div>
      </div>

      {/* Category Tabs */}
      <div className={`flex gap-1 p-1 rounded-xl mb-4 overflow-x-auto ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white shadow-sm'
                : isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            {tab.name}
            <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${
              activeTab === tab.id ? 'bg-white/20' : isDark ? 'bg-gray-700' : 'bg-gray-200'
            }`}>
              {getCategoryCount(tab.id)}
            </span>
          </button>
        ))}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className={`w-8 h-8 animate-spin ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
        </div>
      )}

      {/* Error State */}
      {error && !isLoading && (
        <div className={`flex-1 flex flex-col items-center justify-center ${isDark ? 'text-red-400' : 'text-red-500'}`}>
          <p>{error}</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-500 hover:underline">
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      )}

      {/* Services Grid */}
      {!isLoading && !error && (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServices.map(service => (
              <div
                key={service.id}
                onClick={() => setSelectedService(service)}
                className={`p-4 rounded-xl cursor-pointer transition-all hover:scale-[1.02] ${
                  !service.isActive ? 'opacity-60' : ''
                } ${
                  selectedService?.id === service.id ? 'ring-2 ring-blue-500' : ''
                } ${isDark ? 'bg-gray-800 hover:bg-gray-750' : 'bg-white shadow-sm hover:shadow-md'}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="p-2 rounded-lg bg-blue-500/10">
                    <Scissors className="w-5 h-5 text-blue-500" />
                  </div>
                  <span className={`px-2 py-1 rounded text-xs ${
                    service.isActive
                      ? 'bg-green-500/10 text-green-500'
                      : 'bg-gray-500/10 text-gray-500'
                  }`}>
                    {service.isActive
                      ? t('serviceCatalog.status.active', { defaultValue: 'Active' })
                      : t('serviceCatalog.status.inactive', { defaultValue: 'Inactive' })
                    }
                  </span>
                </div>

                <h3 className={`font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{service.name}</h3>
                <p className={`text-sm mb-3 line-clamp-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {service.description || t('serviceCatalog.noDescription', { defaultValue: 'No description' })}
                </p>

                {/* Category Badge */}
                {service.category && (
                  <div className={`inline-block px-2 py-0.5 rounded text-xs mb-2 ${isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                    {service.category.name}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="flex items-center gap-1">
                      <Clock className={`w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
                      <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{service.durationMinutes}min</span>
                    </span>
                  </div>
                  <span className="text-lg font-bold text-blue-500">{formatPrice(service.price)}</span>
                </div>

                {/* Quick Actions */}
                <div className="flex gap-2 mt-3 pt-3 border-t" style={{ borderColor: isDark ? '#374151' : '#e5e7eb' }}>
                  <button className={`flex-1 py-1.5 rounded-lg text-sm flex items-center justify-center gap-1 ${
                    isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                    <Edit2 className="w-3 h-3" />
                    {t('common.edit', { defaultValue: 'Edit' })}
                  </button>
                  <button className={`py-1.5 px-3 rounded-lg text-sm flex items-center justify-center text-red-500 ${
                    isDark ? 'bg-red-500/10 hover:bg-red-500/20' : 'bg-red-50 hover:bg-red-100'
                  }`}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {filteredServices.length === 0 && (
            <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {t('serviceCatalog.noServices', { defaultValue: 'No services found' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

ServiceCatalogView.displayName = 'ServiceCatalogView';
export default ServiceCatalogView;

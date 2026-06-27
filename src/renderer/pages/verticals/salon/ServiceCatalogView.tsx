import React, { memo, useState, useEffect, useMemo, useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useServices } from '../../../hooks/useServices';
import { Scissors, Clock, Search, Plus, Edit2, Trash2, Loader2, RefreshCw, X } from 'lucide-react';
import { servicesService, type Service } from '../../../services/ServicesService';
import { formatCurrency } from '../../../utils/format';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../../utils/moneyInput';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

type ServiceModalMode = 'create' | 'edit';

interface ServiceDraft {
  name: string;
  description: string;
  categoryId: string;
  price: string;
  durationMinutes: string;
  isActive: boolean;
}

const EMPTY_SERVICE_DRAFT: ServiceDraft = {
  name: '',
  description: '',
  categoryId: '',
  price: '',
  durationMinutes: '30',
  isActive: true,
};

function draftFromService(service: Service): ServiceDraft {
  return {
    name: service.name,
    description: service.description || '',
    categoryId: service.categoryId || '',
    price: service.price > 0 ? service.price.toFixed(2) : '',
    durationMinutes: String(service.durationMinutes || 30),
    isActive: service.isActive,
  };
}

export const ServiceCatalogView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();

  // Get branchId and organizationId from terminal config (same pattern as AppointmentsView)
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
        setLocalOrgId(cached.organizationId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
        setLocalOrgId(refreshed.organizationId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  const effectiveOrgId = organizationId || localOrgId || '';

  const [activeTab, setActiveTab] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [serviceModalMode, setServiceModalMode] = useState<ServiceModalMode | null>(null);
  const [serviceDraft, setServiceDraft] = useState<ServiceDraft>(EMPTY_SERVICE_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Refs + stable title ids so the portaled modals can declare labelled dialog
  // semantics and join the topmost-[role="dialog"] Escape stack used across the POS.
  const serviceDialogRef = useRef<HTMLFormElement>(null);
  const serviceTitleId = useId();
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const deleteTitleId = useId();

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

  const servicePrice = parseMoneyInputValue(serviceDraft.price);
  const serviceDuration = Number.parseInt(serviceDraft.durationMinutes, 10);
  const canSubmitService =
    serviceDraft.name.trim().length > 0 &&
    Number.isFinite(servicePrice) &&
    servicePrice >= 0 &&
    Number.isFinite(serviceDuration) &&
    serviceDuration >= 1;

  const openCreateService = () => {
    setSelectedService(null);
    setServiceDraft(EMPTY_SERVICE_DRAFT);
    setServiceModalMode('create');
  };

  const openEditService = (service: Service, event?: React.MouseEvent) => {
    event?.stopPropagation();
    setSelectedService(service);
    setServiceDraft(draftFromService(service));
    setServiceModalMode('edit');
  };

  const closeServiceModal = useCallback(() => {
    if (isSaving) return;
    setServiceModalMode(null);
    setServiceDraft(EMPTY_SERVICE_DRAFT);
  }, [isSaving]);

  const openDeleteService = (service: Service, event?: React.MouseEvent) => {
    event?.stopPropagation();
    setDeleteTarget(service);
  };

  const closeDeleteModal = useCallback(() => {
    if (isSaving) return;
    setDeleteTarget(null);
  }, [isSaving]);

  // Escape closes the topmost open Services modal, mirroring the app-level POS modals.
  // Each handler is gated on its own open-state and only reacts when its panel is the
  // frontmost [role="dialog"], so if add/edit and delete ever stack the frontmost one
  // closes first. Both route through the close-only callbacks above and never the submit
  // or delete handlers, so Escape can never save a service or delete one.
  useEffect(() => {
    if (!serviceModalMode) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== serviceDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeServiceModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [serviceModalMode, closeServiceModal]);

  useEffect(() => {
    if (!deleteTarget) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== deleteDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeDeleteModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [deleteTarget, closeDeleteModal]);

  const handleSubmitService = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!serviceDraft.name.trim()) {
      toast.error(t('serviceCatalog.validation.nameRequired', { defaultValue: 'Service name is required' }));
      return;
    }
    if (!Number.isFinite(servicePrice) || servicePrice < 0) {
      toast.error(t('serviceCatalog.validation.priceInvalid', { defaultValue: 'Enter a valid price' }));
      return;
    }
    if (!Number.isFinite(serviceDuration) || serviceDuration < 1) {
      toast.error(t('serviceCatalog.validation.durationInvalid', { defaultValue: 'Enter a duration of at least 1 minute' }));
      return;
    }

    setIsSaving(true);
    try {
      const input = {
        name: serviceDraft.name,
        description: serviceDraft.description,
        durationMinutes: serviceDuration,
        price: servicePrice,
        categoryId: serviceDraft.categoryId || null,
        isActive: serviceDraft.isActive,
      };

      if (serviceModalMode === 'edit' && selectedService) {
        await servicesService.updateService(selectedService.id, input);
        toast.success(t('serviceCatalog.toast.updated', { defaultValue: 'Service updated' }));
      } else {
        await servicesService.createService(input);
        toast.success(t('serviceCatalog.toast.created', { defaultValue: 'Service created' }));
      }

      setServiceModalMode(null);
      setServiceDraft(EMPTY_SERVICE_DRAFT);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('serviceCatalog.toast.saveFailed', { defaultValue: 'Failed to save service' }));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteService = async () => {
    if (!deleteTarget) return;

    setIsSaving(true);
    try {
      await servicesService.deleteService(deleteTarget.id);
      toast.success(t('serviceCatalog.toast.deleted', { defaultValue: 'Service deleted' }));
      if (selectedService?.id === deleteTarget.id) {
        setSelectedService(null);
      }
      setDeleteTarget(null);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('serviceCatalog.toast.deleteFailed', { defaultValue: 'Failed to delete service' }));
    } finally {
      setIsSaving(false);
    }
  };

  // Show loading or error state
  if (!branchId || !effectiveOrgId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'bg-black text-zinc-400' : 'bg-[#fdfaf5] text-gray-500'}`}>
        {t('serviceCatalog.selectBranch', { defaultValue: 'Please select a branch to view services' })}
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col p-4 ${isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'}`}>
      <motion.div variants={pageMotionItem} className="mb-4 min-w-0">
        <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('navigation.menu.service_catalog', { defaultValue: 'Services' })}
        </h1>
      </motion.div>

      {/* Header */}
      <motion.div variants={pageMotionItem} className={`rounded-2xl border p-4 mb-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Stats */}
          <motion.div variants={pageMotionContainer} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border border-t-2 ${isDark ? 'bg-black border-zinc-800 border-t-zinc-500' : 'bg-white border-gray-200 border-t-zinc-400'}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                {t('serviceCatalog.stats.totalServices', { defaultValue: 'Total Services' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.totalServices}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border border-t-2 ${isDark ? 'bg-black border-zinc-800 border-t-emerald-400' : 'bg-white border-gray-200 border-t-emerald-500'}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                {t('serviceCatalog.stats.activeServices', { defaultValue: 'Active' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}>{stats.activeServices}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border border-t-2 ${isDark ? 'bg-black border-zinc-800 border-t-amber-400' : 'bg-white border-gray-200 border-t-amber-500'}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                {t('serviceCatalog.stats.avgPrice', { defaultValue: 'Avg Price' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>{formatPrice(stats.avgPrice)}</div>
            </motion.div>
          </motion.div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isLoading}
              aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-transform active:scale-95 disabled:opacity-60 ${isDark ? 'bg-zinc-900 text-zinc-300 border-zinc-700 active:bg-zinc-800' : 'bg-gray-100 text-gray-600 border-gray-300 active:bg-gray-200'}`}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <div className="relative">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t('serviceCatalog.searchPlaceholder', { defaultValue: 'Search services...' })}
                className={`pl-10 pr-4 py-2 rounded-xl border min-w-[260px] ${isDark ? 'bg-zinc-900 text-zinc-100 border-zinc-700' : 'bg-white text-gray-900 border-gray-200'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
              />
            </div>
            <button
              type="button"
              onClick={openCreateService}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-yellow-500 bg-yellow-400 text-black font-medium transition-transform active:bg-yellow-500 active:scale-95"
            >
              <Plus className="w-4 h-4" />
              {t('serviceCatalog.addService', { defaultValue: 'Add Service' })}
            </button>
          </div>
        </div>
      </motion.div>

      {/* Category Tabs */}
      <motion.div variants={pageMotionContainer} className={`flex gap-1 p-1 rounded-2xl mb-4 overflow-x-auto scrollbar-hide border ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-100 border-gray-200'}`}>
        {tabs.map(tab => (
          <motion.button
            variants={pageMotionItem}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-yellow-400 text-black shadow-sm'
                : isDark ? 'text-zinc-400 active:text-zinc-100 active:bg-zinc-800' : 'text-gray-600 active:text-gray-900 active:bg-white'
            }`}
          >
            {tab.name}
            <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs ${
              activeTab === tab.id
                ? 'bg-black/15'
                : isDark ? 'bg-zinc-800' : 'bg-gray-200'
            }`}>
              {getCategoryCount(tab.id)}
            </span>
          </motion.button>
        ))}
      </motion.div>

      {/* Loading State */}
      {isLoading && (
        <motion.div variants={pageMotionItem} className="flex-1 flex items-center justify-center">
          <Loader2 className={`w-8 h-8 animate-spin ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
        </motion.div>
      )}

      {/* Error State */}
      {error && !isLoading && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex flex-col items-center justify-center ${isDark ? 'text-red-400' : 'text-red-500'}`}>
          <p>{error}</p>
          <button
            type="button"
            onClick={() => refetch()}
            className={`mt-3 px-3 py-1.5 rounded-xl border text-sm ${
              isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-200 active:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 active:bg-gray-100'
            }`}
          >
            {t('common.actions.retry', { defaultValue: 'Retry' })}
          </button>
        </motion.div>
      )}

      {/* Services Grid */}
      {!isLoading && !error && (
        <motion.div variants={pageMotionItem} className="flex-1 overflow-y-auto scrollbar-hide">
          <motion.div variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServices.map(service => (
              <motion.div
                variants={pageMotionItem}
                key={service.id}
                onClick={() => setSelectedService(service)}
                className={`p-4 rounded-2xl cursor-pointer transition-all border ${
                  !service.isActive ? 'opacity-60' : ''
                } ${
                  selectedService?.id === service.id ? (isDark ? 'ring-2 ring-zinc-500' : 'ring-2 ring-gray-400') : ''
                } ${isDark ? 'bg-zinc-950 border-zinc-800 active:bg-zinc-900' : 'bg-white border-gray-200 active:bg-gray-50'}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`p-2 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-100 border-gray-200'}`}>
                    <Scissors className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
                  </div>
                  <span className={`px-2 py-1 rounded text-xs ${
                    service.isActive
                      ? isDark ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                      : isDark ? 'bg-zinc-800 text-zinc-400 border border-zinc-700' : 'bg-gray-100 text-gray-500 border border-gray-200'
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
                  <div className={`inline-block px-2 py-0.5 rounded text-xs mb-2 ${isDark ? 'bg-zinc-900 text-zinc-300 border border-zinc-800' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                    {service.category.name}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="flex items-center gap-1">
                      <Clock className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
                      <span className={isDark ? 'text-zinc-300' : 'text-gray-600'}>{service.durationMinutes} {t('common.minutes', { defaultValue: 'min' })}</span>
                    </span>
                  </div>
                  <span className={`text-lg font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{formatPrice(service.price)}</span>
                </div>

                {/* Quick Actions */}
                <div className={`flex gap-2 mt-3 pt-3 border-t ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                  <button
                    type="button"
                    onClick={(event) => openEditService(service, event)}
                    className={`flex-1 py-1.5 rounded-xl text-sm flex items-center justify-center gap-1 ${
                    isDark ? 'bg-zinc-900 text-zinc-300 border border-zinc-700 active:bg-zinc-800' : 'bg-gray-100 text-gray-600 border border-gray-300 active:bg-gray-200'
                  }`}
                  >
                    <Edit2 className="w-3 h-3" />
                    {t('common.edit', { defaultValue: 'Edit' })}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => openDeleteService(service, event)}
                    aria-label={t('serviceCatalog.delete.title', { defaultValue: 'Delete Service' })}
                    className={`py-1.5 px-3 rounded-xl text-sm flex items-center justify-center text-red-500 ${
                    isDark ? 'bg-red-500/10 active:bg-red-500/20' : 'bg-red-50 active:bg-red-100'
                  }`}
                  >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              </motion.div>
            ))}
          </motion.div>

          {filteredServices.length === 0 && (
            <motion.div variants={pageMotionItem} className={`text-center py-12 rounded-2xl border ${isDark ? 'bg-zinc-950 border-zinc-800 text-zinc-500' : 'bg-white border-gray-200 text-gray-400'}`}>
              <Scissors className="w-10 h-10 mx-auto mb-3 opacity-60" />
              <p>{t('serviceCatalog.noServices', { defaultValue: 'No services found' })}</p>
            </motion.div>
          )}
        </motion.div>
      )}

      {serviceModalMode && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            aria-label={t('common.close', { defaultValue: 'Close' })}
            onClick={closeServiceModal}
          />
          <motion.form
            ref={serviceDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={serviceTitleId}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            onSubmit={handleSubmitService}
            className={`relative z-10 w-full max-w-lg rounded-2xl border shadow-2xl backdrop-blur-2xl ring-1 ${
              isDark ? 'bg-zinc-900/70 border-white/10 ring-white/10 text-zinc-100' : 'bg-white/75 border-white/60 ring-white/50 text-gray-900'
            }`}
          >
            <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 id={serviceTitleId} className="text-lg font-semibold">
                {serviceModalMode === 'edit'
                  ? t('serviceCatalog.editTitle', { defaultValue: 'Edit Service' })
                  : t('serviceCatalog.addTitle', { defaultValue: 'Add Service' })}
              </h2>
              <button
                type="button"
                onClick={closeServiceModal}
                disabled={isSaving}
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition-transform active:scale-95 ${isDark ? 'text-zinc-300 active:bg-white/10' : 'text-gray-600 active:bg-black/5'}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[70vh] space-y-4 overflow-y-auto scrollbar-hide px-5 py-4">
              <label className="block">
                <span className={`mb-1 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('serviceCatalog.fields.name', { defaultValue: 'Name' })}
                </span>
                <input
                  value={serviceDraft.name}
                  onChange={(event) => setServiceDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t('serviceCatalog.fields.namePlaceholder', { defaultValue: 'Service name' })}
                  className={`w-full rounded-xl border px-3 py-2 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/70 border-gray-200/70 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-yellow-400`}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={`mb-1 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                    {t('serviceCatalog.fields.price', { defaultValue: 'Price' })}
                  </span>
                  <input
                    inputMode="decimal"
                    value={serviceDraft.price}
                    onChange={(event) => setServiceDraft((current) => ({ ...current, price: formatMoneyInputWithCents(event.target.value) }))}
                    placeholder="0,00"
                    className={`w-full rounded-xl border px-3 py-2 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/70 border-gray-200/70 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-yellow-400`}
                  />
                </label>

                <label className="block">
                  <span className={`mb-1 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                    {t('serviceCatalog.fields.duration', { defaultValue: 'Duration (minutes)' })}
                  </span>
                  <input
                    inputMode="numeric"
                    value={serviceDraft.durationMinutes}
                    onChange={(event) => setServiceDraft((current) => ({ ...current, durationMinutes: event.target.value.replace(/[^0-9]/g, '') }))}
                    className={`w-full rounded-xl border px-3 py-2 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/70 border-gray-200/70 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-yellow-400`}
                  />
                </label>
              </div>

              <label className="block">
                <span className={`mb-1 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('serviceCatalog.fields.category', { defaultValue: 'Category' })}
                </span>
                <select
                  value={serviceDraft.categoryId}
                  onChange={(event) => setServiceDraft((current) => ({ ...current, categoryId: event.target.value }))}
                  className={`w-full rounded-xl border px-3 py-2 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/70 border-gray-200/70 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-yellow-400`}
                >
                  <option value="">{t('serviceCatalog.fields.noCategory', { defaultValue: 'No category' })}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className={`mb-1 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('serviceCatalog.fields.description', { defaultValue: 'Description' })}
                </span>
                <textarea
                  value={serviceDraft.description}
                  onChange={(event) => setServiceDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder={t('serviceCatalog.fields.descriptionPlaceholder', { defaultValue: 'Optional description' })}
                  rows={3}
                  className={`w-full resize-none rounded-xl border px-3 py-2 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/70 border-gray-200/70 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-yellow-400`}
                />
              </label>

              <label className="flex items-center justify-between gap-3">
                <span className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('serviceCatalog.fields.active', { defaultValue: 'Active' })}
                </span>
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    checked={serviceDraft.isActive}
                    onChange={(event) => setServiceDraft((current) => ({ ...current, isActive: event.target.checked }))}
                    className="sr-only peer"
                  />
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-8 w-14 shrink-0 rounded-full border p-1 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-yellow-400/60 ${isDark ? 'border-white/15 bg-zinc-700/70' : 'border-gray-300 bg-gray-300/80'} peer-checked:border-yellow-400/60 peer-checked:bg-yellow-400/90 after:content-[''] after:absolute after:top-1 after:start-1 after:h-6 after:w-6 after:rounded-full after:bg-white after:shadow-md after:transition-transform peer-checked:after:translate-x-6`}
                  />
                </span>
              </label>
            </div>

            <div className={`flex justify-end gap-3 border-t px-5 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
              <button
                type="button"
                onClick={closeServiceModal}
                disabled={isSaving}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-transform active:scale-95 ${isDark ? 'bg-red-500/25 text-red-200 border-red-400/40 active:bg-red-500/35' : 'bg-red-500/20 text-red-900 border-red-500/50 active:bg-red-500/30'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="submit"
                disabled={!canSubmitService || isSaving}
                className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-transform active:scale-95 ${isDark ? 'bg-green-500/25 text-green-200 border-green-500/45 active:bg-green-500/35' : 'bg-green-500/25 text-green-900 border-green-600/50 active:bg-green-500/35'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {isSaving ? t('common.saving', { defaultValue: 'Saving...' }) : t('common.actions.save', { defaultValue: 'Save' })}
              </button>
            </div>
          </motion.form>
        </div>
      )}

      {deleteTarget && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            aria-label={t('common.close', { defaultValue: 'Close' })}
            onClick={closeDeleteModal}
          />
          <motion.div
            ref={deleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={deleteTitleId}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className={`relative z-10 w-full max-w-md rounded-2xl border p-5 shadow-2xl backdrop-blur-2xl ring-1 ${
              isDark ? 'bg-zinc-900/70 border-white/10 ring-white/10 text-zinc-100' : 'bg-white/75 border-white/60 ring-white/50 text-gray-900'
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              <Trash2 className="h-5 w-5 shrink-0 text-red-500" />
              <h2 id={deleteTitleId} className="text-lg font-semibold">
                {t('serviceCatalog.delete.title', { defaultValue: 'Delete Service' })}
              </h2>
            </div>
            <p className={`mb-5 text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('serviceCatalog.delete.message', {
                defaultValue: 'Delete {{name}}? This cannot be undone.',
                name: deleteTarget.name,
              })}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={isSaving}
                className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-medium transition-transform active:scale-95 ${isDark ? 'border-white/15 bg-white/5 text-zinc-200 active:bg-white/10' : 'border-black/10 bg-black/5 text-gray-700 active:bg-black/10'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={handleDeleteService}
                disabled={isSaving}
                className="inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-transform active:scale-95 active:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving
                  ? t('common.saving', { defaultValue: 'Saving...' })
                  : t('serviceCatalog.delete.confirm', { defaultValue: 'Delete' })}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
});

ServiceCatalogView.displayName = 'ServiceCatalogView';
export default ServiceCatalogView;

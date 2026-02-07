import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Ticket,
  RefreshCw,
  Search,
  CheckCircle,
  XCircle,
  Percent,
  DollarSign,
  Calendar,
  Copy,
  Check,
  Plus,
  Edit3,
  Trash2,
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import {
  posApiDelete,
  posApiGet,
  posApiPatch,
  posApiPost,
} from '../utils/api-helpers';
import { formatCurrency, formatDate } from '../utils/format';

interface Coupon {
  id: string;
  code: string;
  name?: string | null;
  description?: string | null;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  usage_limit?: number | null;
  usage_count: number;
  min_order_amount?: number | null;
  expires_at?: string | null;
  is_active: boolean;
  branch_id?: string | null;
}

interface CouponFormState {
  code: string;
  name: string;
  description: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: string;
  usage_limit: string;
  min_order_amount: string;
  expires_at: string;
  is_active: boolean;
}

type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>;

const EMPTY_FORM: CouponFormState = {
  code: '',
  name: '',
  description: '',
  discount_type: 'percentage',
  discount_value: '10',
  usage_limit: '',
  min_order_amount: '',
  expires_at: '',
  is_active: true,
};

function getIpcInvoke(): IpcInvoke | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  if (typeof w?.electronAPI?.invoke === 'function') {
    return w.electronAPI.invoke.bind(w.electronAPI);
  }
  if (typeof w?.electronAPI?.ipcRenderer?.invoke === 'function') {
    return w.electronAPI.ipcRenderer.invoke.bind(w.electronAPI.ipcRenderer);
  }
  if (typeof w?.electron?.ipcRenderer?.invoke === 'function') {
    return w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer);
  }
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCoupon(raw: unknown): Coupon {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(source.id ?? ''),
    code: String(source.code ?? '').toUpperCase(),
    name: typeof source.name === 'string' ? source.name : null,
    description: typeof source.description === 'string' ? source.description : null,
    discount_type: source.discount_type === 'fixed' ? 'fixed' : 'percentage',
    discount_value: asNumber(source.discount_value, 0),
    usage_limit: asNullableNumber(source.usage_limit),
    usage_count: asNumber(source.usage_count, 0),
    min_order_amount: asNullableNumber(source.min_order_amount),
    expires_at: typeof source.expires_at === 'string' ? source.expires_at : null,
    is_active: source.is_active !== false,
    branch_id: typeof source.branch_id === 'string' ? source.branch_id : null,
  };
}

function toDateTimeLocalValue(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function readApiError(result: any, fallback: string): string {
  return (
    result?.error ||
    result?.data?.error ||
    result?.data?.message ||
    fallback
  );
}

const CouponsPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showActiveOnly, setShowActiveOnly] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [form, setForm] = useState<CouponFormState>(EMPTY_FORM);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('api:fetch-from-admin', '/api/pos/coupons');
        if (result?.success && !result?.data?.error) {
          const rows = Array.isArray(result?.data?.coupons) ? result.data.coupons : [];
          setCoupons(rows.map(normalizeCoupon));
          return;
        }
        throw new Error(readApiError(result, 'Failed to load coupons'));
      }

      const result = await posApiGet<{ coupons?: unknown[]; error?: string }>('pos/coupons');
      if (!result.success || result.data?.error) {
        throw new Error(result.error || result.data?.error || 'Failed to load coupons');
      }
      const rows = Array.isArray(result.data?.coupons) ? result.data.coupons : [];
      setCoupons(rows.map(normalizeCoupon));
    } catch (error) {
      console.error('Failed to fetch coupons:', error);
      toast.error(t('coupons.errors.loadFailed', 'Failed to load coupons'));
      setCoupons([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  const copyCode = async (code: string, id: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      toast.success(t('coupons.codeCopied', 'Code copied!'));
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      toast.error(t('coupons.errors.copyFailed', 'Failed to copy code'));
    }
  };

  const isExpired = (expiresAt?: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  const isUsedUp = (coupon: Coupon) => {
    if (!coupon.usage_limit) return false;
    return coupon.usage_count >= coupon.usage_limit;
  };

  const openCreateModal = () => {
    setEditingCoupon(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const openEditModal = (coupon: Coupon) => {
    setEditingCoupon(coupon);
    setForm({
      code: coupon.code,
      name: coupon.name || '',
      description: coupon.description || '',
      discount_type: coupon.discount_type,
      discount_value: String(coupon.discount_value ?? 0),
      usage_limit: coupon.usage_limit ? String(coupon.usage_limit) : '',
      min_order_amount: coupon.min_order_amount ? String(coupon.min_order_amount) : '',
      expires_at: toDateTimeLocalValue(coupon.expires_at),
      is_active: coupon.is_active,
    });
    setShowModal(true);
  };

  const closeModal = () => {
    if (saving) return;
    setShowModal(false);
    setEditingCoupon(null);
    setForm(EMPTY_FORM);
  };

  const handleSaveCoupon = async () => {
    const code = form.code.trim().toUpperCase();
    if (!code) {
      toast.error(t('coupons.errors.codeRequired', 'Coupon code is required'));
      return;
    }

    const discountValue = Number(form.discount_value);
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      toast.error(t('coupons.errors.invalidDiscount', 'Discount value is invalid'));
      return;
    }
    if (form.discount_type === 'percentage' && discountValue > 100) {
      toast.error(t('coupons.errors.invalidPercentage', 'Percentage cannot be greater than 100'));
      return;
    }

    const usageLimit = form.usage_limit.trim() ? Number(form.usage_limit) : null;
    if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
      toast.error(t('coupons.errors.invalidUsageLimit', 'Usage limit must be an integer greater than 0'));
      return;
    }

    const minOrderAmount = form.min_order_amount.trim() ? Number(form.min_order_amount) : 0;
    if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) {
      toast.error(t('coupons.errors.invalidMinOrder', 'Minimum order amount is invalid'));
      return;
    }

    let expiresAtIso: string | null = null;
    if (form.expires_at.trim()) {
      const parsed = new Date(form.expires_at);
      if (Number.isNaN(parsed.getTime())) {
        toast.error(t('coupons.errors.invalidExpiry', 'Expiration date is invalid'));
        return;
      }
      expiresAtIso = parsed.toISOString();
    }

    setSaving(true);
    try {
      const invoke = getIpcInvoke();
      if (editingCoupon) {
        const payload = {
          code,
          name: form.name.trim() || null,
          description: form.description.trim() || null,
          discount_type: form.discount_type,
          discount_value: discountValue,
          usage_limit: usageLimit,
          min_order_amount: minOrderAmount,
          expires_at: expiresAtIso,
          is_active: form.is_active,
        };

        if (invoke) {
          const result = await invoke(
            'api:fetch-from-admin',
            `/api/pos/coupons/${editingCoupon.id}`,
            { method: 'PATCH', body: payload }
          );
          if (!result?.success || result?.data?.error) {
            throw new Error(readApiError(result, 'Failed to update coupon'));
          }
        } else {
          const result = await posApiPatch<{ error?: string }>(`pos/coupons/${editingCoupon.id}`, payload);
          if (!result.success || result.data?.error) {
            throw new Error(result.error || result.data?.error || 'Failed to update coupon');
          }
        }
      } else {
        const payload = {
          code,
          name: form.name.trim() || undefined,
          description: form.description.trim() || undefined,
          discount_type: form.discount_type,
          discount_value: discountValue,
          usage_limit: usageLimit ?? undefined,
          min_order_amount: minOrderAmount,
          expires_at: expiresAtIso || undefined,
        };

        if (invoke) {
          const result = await invoke('api:fetch-from-admin', '/api/pos/coupons', {
            method: 'POST',
            body: payload,
          });
          if (!result?.success || result?.data?.error) {
            throw new Error(readApiError(result, 'Failed to create coupon'));
          }
        } else {
          const result = await posApiPost<{ error?: string }>('pos/coupons', payload);
          if (!result.success || result.data?.error) {
            throw new Error(result.error || result.data?.error || 'Failed to create coupon');
          }
        }
      }

      toast.success(
        editingCoupon
          ? t('coupons.updated', 'Coupon updated')
          : t('coupons.created', 'Coupon created')
      );
      closeModal();
      await fetchCoupons();
    } catch (error) {
      console.error('Failed to save coupon:', error);
      toast.error(error instanceof Error ? error.message : t('coupons.errors.saveFailed', 'Failed to save coupon'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (coupon: Coupon) => {
    setProcessingId(coupon.id);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke(
          'api:fetch-from-admin',
          `/api/pos/coupons/${coupon.id}`,
          { method: 'PATCH', body: { is_active: !coupon.is_active } }
        );
        if (!result?.success || result?.data?.error) {
          throw new Error(readApiError(result, 'Failed to update coupon status'));
        }
      } else {
        const result = await posApiPatch<{ error?: string }>(`pos/coupons/${coupon.id}`, {
          is_active: !coupon.is_active,
        });
        if (!result.success || result.data?.error) {
          throw new Error(result.error || result.data?.error || 'Failed to update coupon status');
        }
      }

      setCoupons((prev) =>
        prev.map((item) =>
          item.id === coupon.id
            ? { ...item, is_active: !coupon.is_active }
            : item
        )
      );
      toast.success(
        !coupon.is_active
          ? t('coupons.activated', 'Coupon activated')
          : t('coupons.deactivated', 'Coupon deactivated')
      );
    } catch (error) {
      console.error('Failed to update coupon status:', error);
      toast.error(error instanceof Error ? error.message : t('coupons.errors.updateFailed', 'Failed to update coupon'));
    } finally {
      setProcessingId(null);
    }
  };

  const handleDelete = async (coupon: Coupon) => {
    if (!window.confirm(t('coupons.confirmDelete', 'Delete this coupon? This cannot be undone.'))) {
      return;
    }

    setProcessingId(coupon.id);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke(
          'api:fetch-from-admin',
          `/api/pos/coupons/${coupon.id}`,
          { method: 'DELETE' }
        );
        if (!result?.success || result?.data?.error) {
          throw new Error(readApiError(result, 'Failed to delete coupon'));
        }
      } else {
        const result = await posApiDelete<{ error?: string }>(`pos/coupons/${coupon.id}`);
        if (!result.success || result.data?.error) {
          throw new Error(result.error || result.data?.error || 'Failed to delete coupon');
        }
      }

      setCoupons((prev) => prev.filter((item) => item.id !== coupon.id));
      toast.success(t('coupons.deleted', 'Coupon deleted'));
    } catch (error) {
      console.error('Failed to delete coupon:', error);
      toast.error(error instanceof Error ? error.message : t('coupons.errors.deleteFailed', 'Failed to delete coupon'));
    } finally {
      setProcessingId(null);
    }
  };

  const filteredCoupons = coupons.filter((coupon) => {
    const matchesSearch =
      !searchTerm ||
      coupon.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (coupon.name || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesActive =
      !showActiveOnly || (coupon.is_active && !isExpired(coupon.expires_at) && !isUsedUp(coupon));
    return matchesSearch && matchesActive;
  });

  const activeCoupons = coupons.filter((coupon) => coupon.is_active && !isExpired(coupon.expires_at) && !isUsedUp(coupon));

  if (loading && coupons.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/20">
            <Ticket className="w-6 h-6 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('coupons.title', 'Coupons')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('coupons.subtitle', 'Manage discount codes for this branch')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openCreateModal}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-cyan-500 text-white hover:bg-cyan-600 transition-colors inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('coupons.create', 'New Coupon')}
          </button>
          <button
            onClick={() => setShowActiveOnly((prev) => !prev)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showActiveOnly
                ? 'bg-cyan-500 text-white'
                : isDark ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-700'
            }`}
          >
            {t('coupons.activeOnly', 'Active Only')}
          </button>
          <button
            onClick={fetchCoupons}
            className={`p-2 rounded-lg ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'} border`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('coupons.activeCoupons', 'Active Coupons')}
              </p>
              <p className="text-xl font-bold">{activeCoupons.length}</p>
            </div>
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'} border`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20">
              <Ticket className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('coupons.totalCoupons', 'Total Coupons')}
              </p>
              <p className="text-xl font-bold">{coupons.length}</p>
            </div>
          </div>
        </motion.div>
      </div>

      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-4 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border`}>
        <Search className="w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('coupons.search', 'Search coupons...')}
          className="flex-1 bg-transparent outline-none text-sm"
        />
      </div>

      {filteredCoupons.length === 0 ? (
        <div className={`p-8 rounded-xl text-center ${isDark ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'} border`}>
          <Ticket className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('coupons.noCoupons', 'No Coupons Found')}</h3>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('coupons.noCouponsDesc', 'Create your first coupon to start offering discounts.')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCoupons.map((coupon, idx) => {
            const expired = isExpired(coupon.expires_at);
            const usedUp = isUsedUp(coupon);
            const isValid = coupon.is_active && !expired && !usedUp;
            const busy = processingId === coupon.id;

            return (
              <motion.div
                key={coupon.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04 }}
                className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'} border ${!isValid ? 'opacity-70' : ''}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-lg text-cyan-500">{coupon.code}</span>
                      <button
                        onClick={() => copyCode(coupon.code, coupon.id)}
                        className={`p-1 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      >
                        {copiedId === coupon.id ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    </div>
                    {coupon.name && (
                      <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {coupon.name}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEditModal(coupon)}
                      disabled={busy}
                      className={`p-1.5 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'} disabled:opacity-50`}
                      title={t('common.edit', 'Edit')}
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleToggleActive(coupon)}
                      disabled={busy}
                      className={`p-1.5 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'} disabled:opacity-50`}
                      title={coupon.is_active ? t('common.deactivate', 'Deactivate') : t('common.activate', 'Activate')}
                    >
                      {coupon.is_active ? (
                        <XCircle className="w-4 h-4 text-yellow-500" />
                      ) : (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(coupon)}
                      disabled={busy}
                      className={`p-1.5 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'} disabled:opacity-50`}
                      title={t('common.delete', 'Delete')}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </button>
                  </div>
                </div>

                <div className="mb-3">
                  {isValid ? (
                    <span className="px-2 py-0.5 text-xs bg-green-500/20 text-green-500 rounded inline-flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {t('common.active', 'Active')}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-500 rounded inline-flex items-center gap-1">
                      <XCircle className="w-3 h-3" />
                      {expired ? t('coupons.expired', 'Expired') : usedUp ? t('coupons.usedUp', 'Used Up') : t('common.inactive', 'Inactive')}
                    </span>
                  )}
                </div>

                {coupon.description && (
                  <p className={`text-sm mb-3 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                    {coupon.description}
                  </p>
                )}

                <div className="flex items-center gap-4 mb-3">
                  <div className="flex items-center gap-1">
                    {coupon.discount_type === 'percentage' ? (
                      <Percent className="w-4 h-4 text-cyan-500" />
                    ) : (
                      <DollarSign className="w-4 h-4 text-cyan-500" />
                    )}
                    <span className="font-bold text-lg">
                      {coupon.discount_type === 'percentage'
                        ? `${coupon.discount_value}%`
                        : formatMoney(coupon.discount_value)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2 text-sm">
                  {(coupon.min_order_amount ?? 0) > 0 && (
                    <div className="flex justify-between">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                        {t('coupons.minOrder', 'Min Order')}
                      </span>
                      <span>{formatMoney(coupon.min_order_amount || 0)}</span>
                    </div>
                  )}
                  {coupon.usage_limit && (
                    <div className="flex justify-between">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                        {t('coupons.usage', 'Usage')}
                      </span>
                      <span>{coupon.usage_count} / {coupon.usage_limit}</span>
                    </div>
                  )}
                  {coupon.expires_at && (
                    <div className="flex justify-between items-center">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                        {t('coupons.expires', 'Expires')}
                      </span>
                      <span className={`flex items-center gap-1 ${expired ? 'text-red-500' : ''}`}>
                        <Calendar className="w-3 h-3" />
                        {formatDate(coupon.expires_at)}
                      </span>
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={closeModal}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`w-full max-w-lg rounded-2xl shadow-2xl ${isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-gray-700/30">
              <h3 className="text-lg font-semibold">
                {editingCoupon ? t('coupons.editCoupon', 'Edit Coupon') : t('coupons.createCoupon', 'Create Coupon')}
              </h3>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.code', 'Code')} *</span>
                  <input
                    value={form.code}
                    onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                    placeholder="SAVE10"
                  />
                </label>
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.discountType', 'Discount Type')}</span>
                  <select
                    value={form.discount_type}
                    onChange={(e) => setForm((prev) => ({ ...prev, discount_type: e.target.value as 'percentage' | 'fixed' }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                  >
                    <option value="percentage">{t('coupons.percentage', 'Percentage')}</option>
                    <option value="fixed">{t('coupons.fixed', 'Fixed Amount')}</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.discountValue', 'Discount Value')} *</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.discount_value}
                    onChange={(e) => setForm((prev) => ({ ...prev, discount_value: e.target.value }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                  />
                </label>
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.minOrder', 'Min Order')}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.min_order_amount}
                    onChange={(e) => setForm((prev) => ({ ...prev, min_order_amount: e.target.value }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                    placeholder="0"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.usageLimit', 'Usage Limit')}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.usage_limit}
                    onChange={(e) => setForm((prev) => ({ ...prev, usage_limit: e.target.value }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                    placeholder={t('common.optional', 'Optional')}
                  />
                </label>
                <label className="text-sm">
                  <span className="block mb-1">{t('coupons.expires', 'Expires')}</span>
                  <input
                    type="datetime-local"
                    value={form.expires_at}
                    onChange={(e) => setForm((prev) => ({ ...prev, expires_at: e.target.value }))}
                    className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                  />
                </label>
              </div>

              <label className="text-sm">
                <span className="block mb-1">{t('common.name', 'Name')}</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                />
              </label>

              <label className="text-sm">
                <span className="block mb-1">{t('common.description', 'Description')}</span>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  className={`w-full px-3 py-2 rounded-lg border resize-none ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
                />
              </label>

              {editingCoupon && (
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                  />
                  {t('common.active', 'Active')}
                </label>
              )}
            </div>

            <div className="p-5 border-t border-gray-700/30 flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={saving}
                className={`px-4 py-2 rounded-lg ${isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'} disabled:opacity-50`}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleSaveCoupon}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-cyan-500 text-white hover:bg-cyan-600 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                {editingCoupon ? t('common.save', 'Save') : t('common.create', 'Create')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default CouponsPage;

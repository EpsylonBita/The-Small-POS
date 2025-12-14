import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { useFeatures } from '../../hooks/useFeatures';
import type { ZReportData } from '../../types/reports';
import { exportZReportToCSV, exportArrayToCSV, exportStaffOrdersToCSV } from '../../utils/reportExport';
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { POSGlassTooltip } from '../ui/POSGlassTooltip';
import { VarianceBadge } from '../ui/VarianceBadge';

interface ZReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchId: string;
  date?: string; // yyyy-mm-dd
}

const ZReportModal: React.FC<ZReportModalProps> = ({ isOpen, onClose, branchId, date }) => {
  const { clearShift } = useShift();
  const { t } = useTranslation();
  const { isFeatureEnabled, isMobileWaiter, parentTerminalId } = useFeatures();
  const canExecuteZReport = isFeatureEnabled('zReportExecution');
  const [activeTab, setActiveTab] = useState<'summary' | 'details'>('summary');
  const [selectedDate, setSelectedDate] = useState<string>(date || new Date().toISOString().slice(0, 10));
  const [zReport, setZReport] = useState<ZReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const [staffSortBy, setStaffSortBy] = useState<'name' | 'role' | 'orders' | 'sales'>('role');

  // NEW: State for expandable orders
  const [expandedStaff, setExpandedStaff] = useState<Set<string>>(new Set());
  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'delivery' | 'dine-in' | 'pickup'>('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<'all' | 'cash' | 'card'>('all');

  // Helpers for symbols
  const getStatusSymbol = (status: string) => {
    if (status === 'completed' || status === 'delivered') return '✓';
    if (status === 'cancelled') return '✗';
    return '○';
  };

  const getPaymentSymbol = (method?: string) => {
    if (method === 'cash') return '💵';
    if (method === 'card') return '💳';
    return '—';
  };

  const filterOrders = (orders: any[] | null | undefined): any[] => {
    if (!orders || !Array.isArray(orders)) return [];
    return orders.filter(o => {
      if (!o) return false;
      const typeMatch = orderTypeFilter === 'all' || o.orderType === orderTypeFilter;
      const paymentMatch = paymentMethodFilter === 'all' || o.paymentMethod === paymentMethodFilter;
      return typeMatch && paymentMatch;
    });
  };

  const staffReportsSorted = useMemo(() => {
    const list: any[] = Array.isArray((zReport as any)?.staffReports) ? [...(zReport as any).staffReports] : [];
    if (!list.length) return list;
    switch (staffSortBy) {
      case 'name':
        return list.sort((a, b) => String(a.staffName || a.staffId).localeCompare(String(b.staffName || b.staffId)));
      case 'role':
        return list.sort((a, b) => String(a.role || '').localeCompare(String(b.role || '')));
      case 'orders':
        return list.sort((a, b) => (Number(b.orders?.count || 0) - Number(a.orders?.count || 0)));
      case 'sales':
        return list.sort((a, b) => (
          Number((b.orders?.totalAmount ?? ((b.orders?.cashAmount || 0) + (b.orders?.cardAmount || 0)))) -
          Number((a.orders?.totalAmount ?? ((a.orders?.cashAmount || 0) + (a.orders?.cardAmount || 0))))
        ));
      default:
        return list;
    }
  }, [zReport, staffSortBy]);

  const daySummary = useMemo(() => {
    const ds: any = (zReport as any)?.daySummary;
    if (ds) return ds;
    if (!zReport) return null;
    // Handle cases where sales object may be missing or incomplete
    const sales = zReport.sales || {};
    return {
      cashTotal: sales.cashSales ?? 0,
      cardTotal: sales.cardSales ?? 0,
      total: sales.totalSales ?? 0,
      totalOrders: sales.totalOrders ?? 0,
    };
  }, [zReport]);

  const exportStaffCSV = () => {
    const rows = staffReportsSorted.map((s: any) => ({
      'Staff Name': s.staffName || s.staffId,
      Role: s.role,
      'Check In': s.checkIn || '',
      'Check Out': s.checkOut || '',
      'Orders Count': s.orders?.count ?? 0,
      'Orders Cash': s.orders?.cashAmount ?? 0,
      'Orders Card': s.orders?.cardAmount ?? 0,
      'Orders Total': s.orders?.totalAmount ?? ((s.orders?.cashAmount || 0) + (s.orders?.cardAmount || 0)),
      'Staff Payments': s.payments?.staffPayments ?? 0,
      Expenses: s.expenses?.total ?? 0,
      'Returned To Drawer': s.returnedToDrawerAmount ?? 0,
      Deliveries: s.driver?.deliveries ?? 0,
      Earnings: s.driver?.earnings ?? 0,
      'Driver Cash': s.driver?.cashCollected ?? 0,
      'Driver Card': s.driver?.cardAmount ?? 0,
    }));
    exportArrayToCSV(rows, `z-report-staff-${selectedDate}`);
  };


  const formatHours = (h?: number) => {
    if (h == null || isNaN(h)) return '';
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${hh}h ${mm.toString().padStart(2, '0')}m`;
  };



  useEffect(() => {
    if (!isOpen || !branchId) return;
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI?.generateZReport?.({ branchId, date: selectedDate });
        if (!mounted) return;
        // IPC handlers wrap response in { success: true, data: ... }
        const report = result?.data || result;
        setZReport(report || null);
      } catch (e: any) {
        if (!mounted) return;
        setError(e?.message || t('modals.zReport.loadFailed'));
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [isOpen, branchId, selectedDate]);

  const title = useMemo(() => t('modals.zReport.title', { date: selectedDate }), [selectedDate, t]);

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="full"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {/* Date selector section */}
      <div className="mb-4">
        <label className="block text-sm font-medium liquid-glass-modal-text mb-2">{t('modals.zReport.selectDate')}</label>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="liquid-glass-modal-input"
          aria-label={t('modals.zReport.selectDate')}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {(['summary', 'details'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`px-3 py-2 rounded-md text-sm font-medium ${activeTab === tab ? 'bg-blue-600 text-white' : 'bg-gray-100/50 dark:bg-gray-800/50 liquid-glass-modal-text'}`}>
            {t(`modals.zReport.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {/* Scrollable Content */}
      <div className="max-h-[55vh] overflow-y-auto mb-4">
        {loading && (
          <div className="py-12 text-center text-sm liquid-glass-modal-text-muted">{t('modals.zReport.loading')}</div>
        )}
        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</div>
        )}

        {!loading && !error && activeTab === 'summary' && zReport && (() => {
          // Safe accessors for nested properties that may be missing
          const sales = zReport.sales || { totalOrders: 0, totalSales: 0, cashSales: 0, cardSales: 0, byType: {} };
          const cashDrawer = zReport.cashDrawer || { totalVariance: 0, totalCashDrops: 0, unreconciledCount: 0, openingTotal: 0, driverCashGiven: 0, driverCashReturned: 0 };
          const expenses = zReport.expenses || { total: 0, staffPaymentsTotal: 0, pendingCount: 0, items: [] };

          return (
          <div className="space-y-4">
            {/* MAIN TOTALS - Big and Clear */}
            <div className="rounded-lg p-5 border-2 liquid-glass-modal-border bg-gradient-to-br from-green-500/20 to-emerald-500/10">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-xs text-gray-300 uppercase tracking-wide">{t('modals.zReport.totalOrders')}</div>
                  <div className="text-3xl font-bold text-green-300 mt-1">{sales.totalOrders}</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-300 uppercase tracking-wide">{t('modals.zReport.totalSales')}</div>
                  <div className="text-3xl font-bold text-green-300 mt-1">${(sales.totalSales ?? 0).toFixed(2)}</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-300 uppercase tracking-wide">{t('modals.zReport.cashSales')}</div>
                  <div className="text-2xl font-bold text-emerald-300 mt-1">${(sales.cashSales ?? 0).toFixed(2)}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {(() => {
                      const ts = sales.totalSales || 0; return ts ? ((sales.cashSales / ts) * 100).toFixed(0) : '0';
                    })()}%
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-300 uppercase tracking-wide">{t('modals.zReport.cardSales')}</div>
                  <div className="text-2xl font-bold text-blue-300 mt-1">${(sales.cardSales ?? 0).toFixed(2)}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {(() => {
                      const ts = sales.totalSales || 0; return ts ? ((sales.cardSales / ts) * 100).toFixed(0) : '0';
                    })()}%
                  </div>
                </div>
              </div>
            </div>

            {/* SALES BREAKDOWN - In-store vs Delivery */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
                <h3 className="font-medium mb-3 text-purple-300 text-sm uppercase tracking-wide">{t('modals.zReport.instore')}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-300">{t('modals.zReport.cash')} ({sales.byType?.instore?.cash?.count ?? 0})</span>
                    <span className="text-purple-200 font-semibold">${(sales.byType?.instore?.cash?.total ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-300">{t('modals.zReport.card')} ({sales.byType?.instore?.card?.count ?? 0})</span>
                    <span className="text-purple-200 font-semibold">${(sales.byType?.instore?.card?.total ?? 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
                <h3 className="font-medium mb-3 text-orange-300 text-sm uppercase tracking-wide">{t('modals.zReport.delivery')}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-300">{t('modals.zReport.cash')} ({sales.byType?.delivery?.cash?.count ?? 0})</span>
                    <span className="text-orange-200 font-semibold">${(sales.byType?.delivery?.cash?.total ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-300">{t('modals.zReport.card')} ({sales.byType?.delivery?.card?.count ?? 0})</span>
                    <span className="text-orange-200 font-semibold">${(sales.byType?.delivery?.card?.total ?? 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* CASH DRAWER - Critical Info */}
            <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
              <h3 className="font-medium mb-3 text-yellow-400 text-sm uppercase tracking-wide">{t('modals.zReport.cashDrawer')}</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.openingTotal')}</div>
                  <div className="text-yellow-300 font-semibold">${(cashDrawer.openingTotal ?? 0).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.totalCashDrops')}</div>
                  <div className="text-yellow-300 font-semibold">${(cashDrawer.totalCashDrops ?? 0).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.driverCashGiven')}</div>
                  <div className="text-yellow-300 font-semibold">${(cashDrawer.driverCashGiven ?? 0).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.driverCashReturned')}</div>
                  <div className="text-yellow-300 font-semibold">${(cashDrawer.driverCashReturned ?? 0).toFixed(2)}</div>
                </div>
                <div className="flex flex-col items-start gap-1 p-2 rounded bg-white/5 border liquid-glass-modal-border">
                  <div className="text-gray-400 text-xs">{t('modals.zReport.totalVariance')}</div>
                  <POSGlassTooltip content={t('modals.staffShift.varianceExplanation', 'Difference between counted cash and expected cash')}>
                    <VarianceBadge variance={cashDrawer.totalVariance ?? 0} size="sm" />
                  </POSGlassTooltip>
                </div>
                <div className={(cashDrawer.unreconciledCount ?? 0) > 0 ? 'p-2 rounded bg-amber-500/20 border border-amber-500/50' : 'p-2 rounded bg-green-500/20 border border-green-500/50'}>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.unreconciledDrawers')}</div>
                  <div className={(cashDrawer.unreconciledCount ?? 0) > 0 ? 'text-amber-300 font-semibold' : 'text-green-300 font-semibold'}>{cashDrawer.unreconciledCount ?? 0}</div>
                </div>
              </div>
            </div>

            {/* EXPENSES */}
            <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
              <h3 className="font-medium mb-3 text-rose-400 text-sm uppercase tracking-wide">{t('modals.zReport.expenses')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.totalExpenses')}</div>
                  <div className="text-rose-300 font-semibold text-lg">${(expenses.total ?? 0).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.staffPaymentsTotal')}</div>
                  <div className="text-rose-300 font-semibold text-lg">${(expenses.staffPaymentsTotal ?? 0).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">{t('modals.zReport.pendingCount')}</div>
                  <div className="text-rose-300 font-semibold text-lg">{expenses.pendingCount ?? 0}</div>
                </div>
              </div>
            </div>

            {/* CASHIERS & DRIVERS - Per Staff Member */}
            {Array.isArray((zReport as any).staffReports) && (zReport as any).staffReports.length > 0 && (
              <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
                <h3 className="font-medium mb-3 text-cyan-400 text-sm uppercase tracking-wide">{t('modals.zReport.staffPerformance')}</h3>
                <div className="flex gap-2 mb-3">
                  <select value={orderTypeFilter} onChange={(e) => setOrderTypeFilter(e.target.value as any)} className="liquid-glass-modal-input text-sm">
                    <option value="all">{t('modals.zReport.filters.allTypes')}</option>
                    <option value="delivery">{t('modals.zReport.filters.delivery')}</option>
                    <option value="dine-in">{t('modals.zReport.filters.dineIn')}</option>
                    <option value="pickup">{t('modals.zReport.filters.pickup')}</option>
                  </select>
                  <select value={paymentMethodFilter} onChange={(e) => setPaymentMethodFilter(e.target.value as any)} className="liquid-glass-modal-input text-sm">
                    <option value="all">{t('modals.zReport.filters.allPayments')}</option>
                    <option value="cash">{t('modals.zReport.filters.cash')}</option>
                    <option value="card">{t('modals.zReport.filters.card')}</option>
                  </select>
                </div>
                <div className="space-y-3">
                  {(zReport as any).staffReports.map((staff: any) => {
                    const isCashier = String(staff.role).toLowerCase() === 'cashier';
                    const isDriver = String(staff.role).toLowerCase() === 'driver';

                    return (
                      <div key={staff.staffShiftId} className="p-4 rounded border liquid-glass-modal-border bg-white/5 dark:bg-gray-900/10">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/10">
                          <div>
                            <div className="font-semibold text-white">{staff.staffName || staff.staffId}</div>
                            <div className="text-xs text-gray-400">{staff.checkIn} - {staff.checkOut || 'Active'}</div>
                          </div>
                          <div className={`px-2 py-1 rounded text-xs font-medium ${isCashier ? 'bg-yellow-500/20 text-yellow-300' :
                            isDriver ? 'bg-indigo-500/20 text-indigo-300' :
                              'bg-gray-500/20 text-gray-300'
                            }`}>
                            {staff.role}
                          </div>
                        </div>

                        {/* CASHIER SPECIFIC */}
                        {isCashier && (
                          <div className="space-y-3">
                            {/* Sales */}
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.orders')}</div>
                                <div className="text-green-300 font-semibold">{staff.orders?.count || 0}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cashSales')}</div>
                                <div className="text-emerald-300 font-semibold">${(staff.orders?.cashAmount || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cardSales')}</div>
                                <div className="text-blue-300 font-semibold">${(staff.orders?.cardAmount || 0).toFixed(2)}</div>
                              </div>
                            </div>

                            {/* Payments & Expenses */}
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.staffPayments')}</div>
                                <div className="text-rose-300 font-semibold">${(staff.payments?.staffPayments || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.expensesShort')}</div>
                                <div className="text-rose-300 font-semibold">${(staff.expenses?.total || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cashToReturn')}</div>
                                <div className="text-yellow-300 font-semibold">${(staff.returnedToDrawerAmount || 0).toFixed(2)}</div>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* DRIVER SPECIFIC */}
                        {isDriver && (
                          <div className="space-y-3">
                            {/* Deliveries & Earnings */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.deliveries')}</div>
                                <div className="text-indigo-300 font-semibold">{staff.driver?.deliveries || 0}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.totalEarnings')}</div>
                                <div className="text-indigo-300 font-semibold">${(staff.driver?.earnings || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cashCollected')}</div>
                                <div className="text-indigo-300 font-semibold">${(staff.driver?.cashCollected || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cardAmount')}</div>
                                <div className="text-indigo-300 font-semibold">${(staff.driver?.cardAmount || 0).toFixed(2)}</div>
                              </div>
                            </div>

                            {/* Driver Payment & Expenses */}
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.staffPayments')}</div>
                                <div className="text-rose-300 font-semibold">${(staff.payments?.staffPayments || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.expensesShort')}</div>
                                <div className="text-rose-300 font-semibold">${(staff.expenses?.total || 0).toFixed(2)}</div>
                              </div>
                              <div className="p-2 rounded bg-white/5">
                                <div className="text-gray-400">{t('modals.zReport.cashToReturn')}</div>
                                <div className="text-indigo-300 font-semibold">${(staff.driver?.cashToReturn || 0).toFixed(2)}</div>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Order Details - Expandable */}
                        {
                          Array.isArray(staff.ordersDetails) && staff.ordersDetails.length > 0 && (
                            <div className="mt-3 border-t border-white/10 pt-3">
                              <button
                                onClick={() => {
                                  const newExpanded = new Set(expandedStaff);
                                  if (newExpanded.has(staff.staffShiftId)) {
                                    newExpanded.delete(staff.staffShiftId);
                                  } else {
                                    newExpanded.add(staff.staffShiftId);
                                  }
                                  setExpandedStaff(newExpanded);
                                }}
                                className="flex items-center gap-2 text-sm text-cyan-300 hover:text-cyan-200"
                              >
                                <span>{expandedStaff.has(staff.staffShiftId) ? '▼' : '▶'}</span>
                                <span>{t('modals.zReport.orderDetails')} ({staff.ordersDetails.length})</span>
                                {staff.ordersTruncated && (
                                  <span className="text-xs text-amber-500 ml-2 animate-pulse">[Truncated]</span>
                                )}
                              </button>

                              {expandedStaff.has(staff.staffShiftId) && (
                                <div className="mt-3">
                                  {staff.ordersTruncated && (
                                    <div className="mb-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-300">
                                      Warning: Only the first 1000 orders are displayed. Export CSV to see all data.
                                    </div>
                                  )}
                                  {/* Header */}
                                  <div className="flex border-b border-white/10 bg-gray-900/50 text-xs font-semibold py-2">
                                    <div className="w-[15%] px-2 text-left text-gray-400">{t('modals.zReport.orderNumber')}</div>
                                    <div className="w-[15%] px-2 text-left text-gray-400">{t('modals.zReport.type')}</div>
                                    <div className="w-[20%] px-2 text-left text-gray-400">{t('modals.zReport.location')}</div>
                                    <div className="w-[15%] px-2 text-right text-gray-400">{t('modals.zReport.amount')}</div>
                                    <div className="w-[10%] px-2 text-center text-gray-400">{t('modals.zReport.payment')}</div>
                                    <div className="w-[10%] px-2 text-center text-gray-400">{t('modals.zReport.status')}</div>
                                    <div className="w-[15%] px-2 text-left text-gray-400">{t('modals.zReport.time')}</div>
                                  </div>
                                  {(() => {
                                    const filteredOrdersList = filterOrders(staff.ordersDetails);
                                    const itemCount = filteredOrdersList.length;
                                    if (itemCount === 0) return null;
                                    return (
                                      <div className="w-full">
                                        {filteredOrdersList.map((order, index) => {
                                          if (!order) return null;
                                          return (
                                            <div key={order.id || index} className="flex border-b border-white/5 items-center hover:bg-white/5 text-xs h-10">
                                              <div className="w-[15%] px-2 text-blue-300 font-mono truncate">{order.orderNumber || '—'}</div>
                                              <div className="w-[15%] px-2 text-gray-300 capitalize truncate">{order.orderType || '—'}</div>
                                              <div className="w-[20%] px-2 text-gray-300 truncate">
                                                {order.orderType === 'delivery'
                                                  ? (order.deliveryAddress || 'N/A')
                                                  : order.orderType === 'dine-in'
                                                    ? `Table ${order.tableNumber || 'N/A'}`
                                                    : '—'}
                                              </div>
                                              <div className="w-[15%] px-2 text-right text-green-300 font-semibold">${(order.amount ?? 0).toFixed(2)}</div>
                                              <div className="w-[10%] px-2 text-center text-lg">{getPaymentSymbol(order.paymentMethod)}</div>
                                              <div className={`w-[10%] px-2 text-center text-lg ${order.status === 'cancelled' ? 'text-red-400' : 'text-green-400'}`}>
                                                {getStatusSymbol(order.status || '')}
                                              </div>
                                              <div className="w-[15%] px-2 text-gray-400 text-xs">
                                                {order.createdAt ? new Date(order.createdAt).toLocaleTimeString() : '—'}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                  {filterOrders(staff.ordersDetails).length === 0 && (
                                    <div className="py-4 text-center text-gray-400 text-sm">
                                      {t('modals.zReport.noOrdersMatchFilter')}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            )}


          </div>
        );
        })()}


        {!loading && !error && activeTab === 'details' && zReport && (() => {
          // Safe accessors for nested properties that may be missing
          const detailsExpenses = zReport.expenses || { total: 0, staffPaymentsTotal: 0, pendingCount: 0, items: [] };

          return (
          <div className="space-y-4 text-sm">
            {/* Drawers Table */}
            <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
              <h3 className="font-medium mb-3 text-yellow-400">{t('modals.zReport.drawers')}</h3>
              {zReport.drawers && zReport.drawers.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs text-white">
                    <thead className="text-left">
                      <tr className="border-b liquid-glass-modal-border">
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.staffName')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.opening')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.cashSales')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.cardSales')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.staffPayments')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.driverCashGiven')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.driverCashReturned')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.drops')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.expected')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.closing')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.variance')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.reconciled')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {zReport.drawers.map(d => (
                        <tr key={d.id} className="border-b liquid-glass-modal-border">
                          <td className="py-2 pr-3 text-blue-300 font-medium">{d.staffName || '-'}</td>
                          <td className="py-2 pr-3 text-white">{d.opening.toFixed(2)}</td>
                          <td className="py-2 pr-3 text-emerald-300">{(d.cashSales ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-emerald-300">{(d.cardSales ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-rose-300">{(d.staffPayments ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-orange-300">{(d.driverCashGiven ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-orange-300">{(d.driverCashReturned ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-yellow-300">{(d.drops ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-white">{(d.expected ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-white">{(d.closing ?? 0).toFixed(2)}</td>
                          <td className={`py-2 pr-3 font-semibold ${((d.variance ?? 0) !== 0) ? 'text-red-400' : 'text-green-400'}`}>{(d.variance ?? 0).toFixed(2)}</td>
                          <td className={`py-2 pr-3 ${d.reconciled ? 'text-green-400' : 'text-amber-400'}`}>{d.reconciled ? t('modals.zReport.yes') : t('modals.zReport.no')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-gray-400">{t('modals.zReport.noDrawers')}</div>
              )}
            </div>

            {/* Expenses */}
            <div className="rounded-lg p-4 border liquid-glass-modal-border bg-white/10 dark:bg-gray-800/20">
              <h3 className="font-medium mb-3 text-rose-400">{t('modals.zReport.expenses')}</h3>
              {detailsExpenses.items && detailsExpenses.items.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs text-white">
                    <thead className="text-left">
                      <tr className="border-b liquid-glass-modal-border">
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.description')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.type')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.staff')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.amount')}</th>
                        <th className="py-2 pr-3 text-gray-300">{t('modals.zReport.createdAt')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailsExpenses.items.map(e => (
                        <tr key={e.id} className="border-b liquid-glass-modal-border">
                          <td className="py-2 pr-3 text-white">{e.description}</td>
                          <td className="py-2 pr-3 text-purple-300">{(e as any).expenseType || '-'}</td>
                          <td className="py-2 pr-3 text-blue-300">{(e as any).staffName || '-'}</td>
                          <td className="py-2 pr-3 text-rose-300 font-semibold">{e.amount.toFixed(2)}</td>
                          <td className="py-2 pr-3 text-gray-400">{e.createdAt || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-gray-400">{t('modals.zReport.noExpenseDetails')}</div>
              )}
            </div>
          </div>
        );
        })()}
      </div>

      {/* Footer - Outside scrollable area */}
      <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t liquid-glass-modal-border">
        <button
          onClick={() => zReport && exportZReportToCSV(zReport, 'z-report')}
          className={liquidGlassModalButton('secondary', 'sm') + ' text-sm'}
          disabled={!zReport}
        >
          {t('modals.zReport.exportCSV')}
        </button>
        <button
          onClick={() => zReport && exportStaffOrdersToCSV((zReport as any).staffReports, `z-report-orders-${new Date().toISOString().split('T')[0]}`)}
          className={liquidGlassModalButton('secondary', 'sm') + ' text-sm'}
          disabled={!zReport}
        >
          {t('modals.zReport.exportOrdersCSV')}
        </button>
        <button
          onClick={() => window.print()}
          className={liquidGlassModalButton('primary', 'sm') + ' text-sm'}
        >
          {t('modals.zReport.print')}
        </button>
        {/* Z-Report Submit Button - disabled for mobile waiter terminals */}
        {canExecuteZReport ? (
          <button
            onClick={async () => {
              setSubmitResult(null);
              setSubmitting(true);
              try {
                const res = await (window as any)?.electronAPI?.submitZReport?.({ branchId, date: selectedDate });
                if (res?.success) {
                  setSubmitResult(t('modals.zReport.submitSuccess'));
                  try { await (window as any).electronAPI?.ipcRenderer?.invoke('auth:logout'); } catch { }
                  try { localStorage.removeItem('pos-user'); } catch { }
                  try { clearShift(); localStorage.removeItem('activeShift'); } catch { }
                  setTimeout(() => { window.location.reload(); }, 600);
                } else {
                  setSubmitResult(t('modals.zReport.submitFailed', { error: res?.error || t('modals.zReport.unknownError') }));
                }
              } catch (e: any) {
                setSubmitResult(e?.message || t('modals.zReport.submissionFailed'));
              } finally {
                setSubmitting(false);
              }
            }}
            className={`px-3 py-2 rounded-md text-sm ${submitting ? 'bg-gray-400 cursor-not-allowed text-white' : liquidGlassModalButton('primary', 'sm')}`}
            disabled={submitting || loading}
            aria-busy={submitting}
          >
            {submitting ? t('modals.zReport.submitting') : t('modals.zReport.submitToAdmin')}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              disabled
              className="px-3 py-2 rounded-md text-sm bg-gray-400 cursor-not-allowed text-white opacity-50"
              title={t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')}
            >
              {t('modals.zReport.submitToAdmin')}
            </button>
            <span className="text-xs text-amber-400">
              {t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')}
            </span>
          </div>
        )}
        {submitResult && <span className="ml-2 text-xs liquid-glass-modal-text-muted">{submitResult}</span>}
      </div>
    </LiquidGlassModal >
  );
};

export default ZReportModal;


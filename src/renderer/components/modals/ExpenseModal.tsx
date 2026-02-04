import React, { useState, useEffect } from 'react';
import { X, FileText, Euro, Plus, Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense } from '../../types';
import toast from 'react-hot-toast';

interface ExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExpenseModal({ isOpen, onClose }: ExpenseModalProps) {
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift } = useShift();

  // Expense state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);

  // UI state
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadExpenses();
      setShowExpenseForm(false);
    }
  }, [isOpen]);

  const loadExpenses = async () => {
    try {
      // Load expenses from the active cashier's shift (not just any shift)
      const branchId = staff?.branchId || localStorage.getItem('branch_id') || '';
      const terminalId = (staff as any)?.terminalId || localStorage.getItem('terminal_id') || '';

      let shiftIdToLoad: string | null = null;

      // First try to get the active cashier shift
      if (branchId && terminalId) {
        const cashierShift = await (window as any).electronAPI.getActiveCashierByTerminal(branchId, terminalId);
        if (cashierShift?.id) {
          shiftIdToLoad = cashierShift.id;
        }
      }

      // Fallback to current user's shift if they're a cashier
      if (!shiftIdToLoad && activeShift?.id && activeShift.role_type === 'cashier') {
        shiftIdToLoad = activeShift.id;
      }

      // Final fallback to any active shift
      if (!shiftIdToLoad && activeShift?.id) {
        shiftIdToLoad = activeShift.id;
      }

      if (!shiftIdToLoad) {
        setExpenses([]);
        return;
      }

      const shiftExpenses = await window.electronAPI.getShiftExpenses(shiftIdToLoad);
      // Ensure we always have an array
      setExpenses(Array.isArray(shiftExpenses) ? shiftExpenses : []);
    } catch (err) {
      console.error('Failed to load expenses:', err);
      setExpenses([]);
    }
  };

  const handleRecordExpense = async () => {
    let shiftIdToUse: string | null = null;
    let cashierShift: any = null;

    try {
      // First, try to get the active cashier shift for this terminal
      const branchId = staff?.branchId || localStorage.getItem('branch_id') || '';
      const terminalId = (staff as any)?.terminalId || localStorage.getItem('terminal_id') || '';

      if (branchId && terminalId) {
        cashierShift = await (window as any).electronAPI.getActiveCashierByTerminal(branchId, terminalId);
        if (cashierShift?.id) {
          shiftIdToUse = cashierShift.id;
        }
      }

      // If no cashier shift found but current user is a cashier, use their shift
      if (!shiftIdToUse && activeShift?.id) {
        // Check if current shift is a cashier shift
        if (activeShift.role_type === 'cashier') {
          shiftIdToUse = activeShift.id;
        }
      }

      // If still no shift and staff exists, try to auto-open a cashier shift
      if (!shiftIdToUse && staff) {
        const openResp = await (window as any).electronAPI.openShift({
          staffId: staff.staffId,
          branchId: staff.branchId,
          terminalId: (staff as any).terminalId,
          roleType: 'cashier',
          openingCash: 0,
        });
        if (openResp?.success && openResp.shiftId) {
          shiftIdToUse = openResp.shiftId as string;
          // Refresh context in the background
          try { await refreshActiveShift(); } catch {}
        }
      }
    } catch (err) {
      console.error('Error finding cashier shift for expense:', err);
    }

    if (!shiftIdToUse || !staff) {
      toast.error(t('modals.expense.noActiveShift', { defaultValue: 'No active shift' }));
      return;
    }

    const amount = parseFloat(expenseAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error(t('modals.expense.invalidAmount', { defaultValue: 'Invalid amount' }));
      return;
    }

    if (!expenseDescription.trim()) {
      toast.error(t('modals.expense.justificationRequired', { defaultValue: 'Justification is required to record an expense' }));
      return;
    }

    setLoading(true);

    try {
      const result = await window.electronAPI.recordExpense({
        shiftId: shiftIdToUse,
        staffId: staff.staffId,
        branchId: staff.branchId,
        expenseType: 'other',
        amount,
        description: expenseDescription,
        receiptNumber: undefined,
      });

      if (result.success) {
        toast.success(t('modals.expense.recordSuccess', { defaultValue: 'Expense recorded successfully' }));
        setExpenseAmount('');
        setExpenseDescription('');
        setShowExpenseForm(false);
        await loadExpenses();
      } else {
        toast.error(result.error || t('modals.expense.recordFailed', { defaultValue: 'Failed to record expense' }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (t('modals.expense.recordFailed', { defaultValue: 'Failed to record expense' })));
    } finally {
      setLoading(false);
    }
  };

  const totalExpenses = Array.isArray(expenses) ? expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0) : 0;

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="liquid-glass-modal-backdrop fixed inset-0 z-[1000]"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] z-[1050] flex flex-col">

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1">
              <h2 className="text-2xl font-bold liquid-glass-modal-text">
                {t('modals.expense.title', { defaultValue: 'Record Expense' })}
              </h2>
              <p className="text-sm liquid-glass-modal-text-muted mt-1">
                {t('modals.expense.subtitle', { defaultValue: 'Record shift expenses' })}
              </p>
            </div>
            <button
              onClick={onClose}
              className="liquid-glass-modal-button p-2 min-h-0 min-w-0 shrink-0"
              aria-label={t('common.actions.close')}
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0">
          <div className="space-y-6">

            {/* Add Expense Form */}
            {showExpenseForm && (
              <div className="liquid-glass-modal-card space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                <h3 className="font-semibold liquid-glass-modal-text flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  {t('modals.expense.newExpense', { defaultValue: 'New Expense' })}
                </h3>

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
                    <Euro className="w-4 h-4 inline mr-1" />
                    {t('modals.expense.amount', { defaultValue: 'Amount' })} *
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.01"
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full p-3 pl-10 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-blue-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted"
                    />
                    <Euro className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 liquid-glass-modal-text-muted" />
                  </div>
                </div>

                {/* Justification Notes */}
                <div>
                  <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
                    <FileText className="w-4 h-4 inline mr-1" />
                    {t('modals.expense.justification', { defaultValue: 'Justification' })} *
                  </label>
                  <textarea
                    value={expenseDescription}
                    onChange={(e) => setExpenseDescription(e.target.value)}
                    placeholder={t('modals.expense.justificationPlaceholder', { defaultValue: 'Enter a justification for this expense...' })}
                    rows={3}
                    required
                    className="w-full p-3 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-blue-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted resize-none"
                  />
                  <p className="text-xs liquid-glass-modal-text-muted mt-1">
                    {t('modals.expense.justificationRequired', { defaultValue: 'Justification is required to record an expense' })}
                  </p>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={handleRecordExpense}
                    disabled={loading || !expenseAmount || parseFloat(expenseAmount) <= 0 || !expenseDescription.trim()}
                    className="flex-1 liquid-glass-modal-button bg-green-600/20 hover:bg-green-600/30 text-green-400 border-green-500/30 gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    {loading ? (t('common.loading', { defaultValue: 'Loading...' })) : (t('modals.expense.recordButton', { defaultValue: 'Record Expense' }))}
                  </button>
                  <button
                    onClick={() => {
                      setShowExpenseForm(false);
                      setExpenseAmount('');
                      setExpenseDescription('');
                    }}
                    className="liquid-glass-modal-button"
                  >
                    {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              </div>
            )}

            {/* Expenses List */}
            <div className="liquid-glass-modal-card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold liquid-glass-modal-text flex items-center gap-2">
                  <Receipt className="w-4 h-4" />
                  {t('modals.expense.expenses', { defaultValue: 'Expenses' })}
                </h3>
                {expenses.length > 0 && (
                  <span className="text-xs liquid-glass-modal-badge">
                    {expenses.length} {t('modals.expense.items', { defaultValue: 'items' })}
                  </span>
                )}
              </div>

              {expenses.length > 0 ? (
                <div className="space-y-3">
                  {expenses.map((expense) => (
                    <div
                      key={expense.id}
                      className="flex items-start justify-between p-3 bg-white/5 dark:bg-white/5 rounded-lg border border-white/10 hover:bg-white/10 transition-colors"
                    >
                      <div className="flex-1">
                        <div className="font-medium liquid-glass-modal-text">{expense.description}</div>
                      </div>
                      <div className="text-right ml-3">
                        <div className="font-bold text-red-400 flex items-center gap-1">
                          <Euro className="w-4 h-4" />
                          {expense.amount.toFixed(2)}
                        </div>
                        {expense.status && (
                          <div className={`text-xs mt-1 ${
                            expense.status === 'approved' ? 'text-green-400' :
                            expense.status === 'rejected' ? 'text-red-400' :
                            'text-yellow-400'
                          }`}>
                            {t(`expense.status.${expense.status}`, { defaultValue: expense.status })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Total */}
                  <div className="flex justify-between items-center pt-4 border-t border-gray-200/50 dark:border-gray-700/50">
                    <span className="font-bold text-lg liquid-glass-modal-text">
                      {t('modals.expense.totalExpenses', { defaultValue: 'Total Expenses' })}:
                    </span>
                    <span className="font-bold text-2xl text-red-400 flex items-center gap-1">
                      <Euro className="w-5 h-5" />
                      {totalExpenses.toFixed(2)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <Receipt className="w-12 h-12 mx-auto mb-3 liquid-glass-modal-text-muted opacity-50" />
                  <p className="text-sm liquid-glass-modal-text-muted">
                    {t('modals.expense.noExpenses', { defaultValue: 'No expenses recorded for this shift' })}
                  </p>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Footer with Add Button */}
        {!showExpenseForm && (
          <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border bg-white/5 dark:bg-black/20">
            <button
              onClick={() => setShowExpenseForm(true)}
              className="w-full liquid-glass-modal-button bg-green-600/20 hover:bg-green-600/30 text-green-400 border-green-500/30 gap-2 py-3"
            >
              <Plus className="w-5 h-5" />
              {t('modals.expense.addButton', { defaultValue: '+ Add Expense' })}
            </button>
          </div>
        )}

      </div>
    </>
  );
}

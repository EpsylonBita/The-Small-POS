
import React, { useState, useEffect } from 'react';
import { X, DollarSign, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense } from '../../types';

import { LiquidGlassModal } from '../ui/pos-glass-components';

interface ExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExpenseModal({ isOpen, onClose }: ExpenseModalProps) {
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift } = useShift();

  // Expense state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseType, setExpenseType] = useState<'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other'>('other');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseReceipt, setExpenseReceipt] = useState('');
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');



  useEffect(() => {
    if (isOpen) {
      loadExpenses();
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
    // Expenses must be charged to the active CASHIER's drawer, not just any shift
    setError('');
    setSuccess('');

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
      // Continue; we'll present the noActiveShift error below if still missing
    }

    if (!shiftIdToUse || !staff) {
      setError(t('modals.expense.noActiveShift'));
      return;
    }

    const amount = parseFloat(expenseAmount);
    if (isNaN(amount) || amount <= 0) {
      setError(t('modals.expense.invalidAmount'));
      return;
    }

    if (!expenseDescription.trim()) {
      setError(t('modals.expense.descriptionRequired'));
      return;
    }

    setLoading(true);

    try {
      const result = await window.electronAPI.recordExpense({
        shiftId: shiftIdToUse,
        staffId: staff.staffId,
        branchId: staff.branchId,
        expenseType,
        amount,
        description: expenseDescription,
        receiptNumber: expenseReceipt || undefined,
      });

      if (result.success) {
        setSuccess(t('modals.expense.recordSuccess'));
        setExpenseAmount('');
        setExpenseDescription('');
        setExpenseReceipt('');
        setShowExpenseForm(false);
        await loadExpenses();
        setTimeout(() => setSuccess(''), 2000);
      } else {
        setError(result.error || t('modals.expense.recordFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.expense.recordFailed'));
    } finally {
      setLoading(false);
    }
  };

  const totalExpenses = Array.isArray(expenses) ? expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0) : 0;

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.expense.title')}
      size="lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="flex-1 overflow-y-auto p-6 space-y-6 pb-24">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="liquid-glass-modal-text font-medium">{error}</p>
          </div>
        )}
        {success && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 animate-in fade-in slide-in-from-top-2 duration-300">
            <p className="liquid-glass-modal-text font-medium">{success}</p>
          </div>
        )}
        <div>
          <div className="flex items-center mb-3">
            <h3 className="font-semibold liquid-glass-modal-text">{t('modals.expense.expenses')}</h3>
          </div>
          {showExpenseForm && (
            <div className="bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border rounded-xl p-4 space-y-3 mb-4">
              <input
                type="text"
                value={expenseDescription}
                onChange={(e) => setExpenseDescription(e.target.value)}
                placeholder={t('modals.expense.descriptionPlaceholder')}
                className="liquid-glass-modal-input"
              />
              <input
                type="number"
                step="0.01"
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
                placeholder={t('modals.expense.amountPlaceholder')}
                className="liquid-glass-modal-input"
              />
              <button
                onClick={handleRecordExpense}
                disabled={loading}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg text-sm transition-all duration-200"
              >
                {t('modals.expense.recordButton')}
              </button>
            </div>
          )}
          {expenses.length > 0 ? (
            <div className="space-y-2">
              {expenses.map((expense) => (
                <div key={expense.id} className="flex items-center justify-between p-3 bg-gray-50/30 dark:bg-gray-800/60 rounded-xl p-3 border liquid-glass-modal-border">
                  <div className="flex-1">
                    <div className="font-medium liquid-glass-modal-text">{expense.description}</div>
                    <div className="liquid-glass-modal-text-muted capitalize text-xs">{expense.expense_type}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold liquid-glass-modal-text">${expense.amount.toFixed(2)}</div>
                    <div className={`text-xs ${
                      expense.status === 'approved' ? 'text-green-400' :
                      expense.status === 'rejected' ? 'text-red-400' :
                      'text-yellow-400'
                    }`}>
                      {t('expense.status.' + expense.status)}
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center pt-3 border-t liquid-glass-modal-border">
                <span className="font-semibold liquid-glass-modal-text">{t('modals.expense.totalExpenses')}:</span>
                <span className="font-bold text-red-400 text-lg">${totalExpenses.toFixed(2)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm liquid-glass-modal-text-muted text-center py-4">{t('modals.expense.noExpenses')}</p>
          )}
        </div>

          {/* Bottom Center Add Expense Button */}
          <div className="sticky bottom-4 inset-x-0 flex justify-center pt-2">
            <button
              onClick={() => setShowExpenseForm(!showExpenseForm)}
              className="px-8 py-4 text-lg rounded-2xl bg-green-600 hover:bg-green-700 text-white font-semibold transition-all duration-200"
            >
              {t('modals.expense.addButton')}
            </button>
          </div>

      </div>
    </LiquidGlassModal>
  );
}

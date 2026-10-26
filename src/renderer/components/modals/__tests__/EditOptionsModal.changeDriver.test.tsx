import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getActive, getBranchId } = vi.hoisted(() => ({
  getActive: vi.fn(),
  getBranchId: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options && typeof options.name === 'string' ? `${key}:${options.name}` : key,
    }),
  };
});
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: (key: string) => key }),
}));
vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib')>()),
  getBridge: () => ({
    drivers: { getActive },
    terminalConfig: { getBranchId },
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { EditOptionsModal } from '../EditOptionsModal';
import { DriverAssignmentModal } from '../DriverAssignmentModal';
import { canChangeOrderDriver } from '../../../utils/driverChange';

const baseProps = {
  isOpen: true,
  orderCount: 1,
  onEditInfo: vi.fn(),
  onEditOrder: vi.fn(),
  onChangeOrderType: vi.fn(),
  onEditPayment: vi.fn(),
  canEditPayment: true,
  onClose: vi.fn(),
};

// Founder request (Tomikro 26/10/2026): "Edit" on a delivered delivery order
// offers "Change driver" and shows who the driver is now.
describe('EditOptionsModal change driver', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers the change for a delivered delivery order and shows the current driver', () => {
    const onChangeDriver = vi.fn();
    render(
      <EditOptionsModal
        {...baseProps}
        canChangeDriver={canChangeOrderDriver({ status: 'delivered', orderType: 'delivery' })}
        currentDriverName="Nikos"
        onChangeDriver={onChangeDriver}
      />,
    );

    const option = screen.getByTestId('edit-options-change-driver');
    expect(option).toHaveTextContent('modals.editOptions.changeDriver');
    expect(screen.getByTestId('edit-options-current-driver')).toHaveTextContent(
      'modals.editOptions.changeDriverCurrent:Nikos',
    );
    fireEvent.click(option);
    expect(onChangeDriver).toHaveBeenCalledTimes(1);
  });

  it('has no driver option for a cancelled order', () => {
    render(
      <EditOptionsModal
        {...baseProps}
        canChangeDriver={canChangeOrderDriver({ status: 'cancelled', orderType: 'delivery' })}
        currentDriverName="Nikos"
        onChangeDriver={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('edit-options-change-driver')).toBeNull();
  });

  it('has no driver option when several orders are edited together', () => {
    render(
      <EditOptionsModal
        {...baseProps}
        orderCount={2}
        canChangeDriver
        onChangeDriver={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('edit-options-change-driver')).toBeNull();
  });
});

describe('DriverAssignmentModal change mode', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the current driver out of reach and hands the chosen one to the parent', async () => {
    getBranchId.mockResolvedValue('branch-1');
    getActive.mockResolvedValue([
      { staffId: 'driver-wrong', staffName: 'Nikos' },
      { staffId: 'driver-right', staffName: 'Giorgos' },
    ]);
    const onDriverAssign = vi.fn();
    const onClose = vi.fn();
    render(
      <DriverAssignmentModal
        isOpen
        mode="change"
        orderCount={1}
        currentDriverId="driver-wrong"
        currentDriverName="Nikos"
        onDriverAssign={onDriverAssign}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('driver-change-current')).toHaveTextContent(
      'modals.driverAssignment.currentDriver:Nikos',
    );
    const current = await screen.findByTestId('driver-option-driver-wrong');
    expect(current).toBeDisabled();
    fireEvent.click(current);
    expect(onDriverAssign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('driver-option-driver-right'));
    await waitFor(() =>
      expect(onDriverAssign).toHaveBeenCalledWith(expect.objectContaining({ id: 'driver-right', name: 'Giorgos' })),
    );
    // The parent closes the picker once the change is saved (it may ask a PIN).
    expect(onClose).not.toHaveBeenCalled();
  });
});

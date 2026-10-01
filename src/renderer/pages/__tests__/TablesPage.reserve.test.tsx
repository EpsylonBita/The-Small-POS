import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  modules: new Set<string>(['tables', 'reservations']),
  navigate: vi.fn(),
  refetch: vi.fn(async () => undefined),
  submit: vi.fn(async () => 'created'),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const stripMotionProps = ({ variants, initial, animate, exit, transition, whileTap, whileHover, layout, ...props }: any) => props;

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: {
    div: React.forwardRef(({ children, ...props }: any, ref: any) => <div ref={ref} {...stripMotionProps(props)}>{children}</div>),
    button: React.forwardRef(({ children, ...props }: any, ref: any) => <button ref={ref} {...stripMotionProps(props)}>{children}</button>),
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: () => undefined }) }));
vi.mock('../../hooks/useFeatures', () => ({ useFeatures: () => ({ isFeatureEnabled: () => true, loading: false }) }));
vi.mock('../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { RESERVATIONS: 'reservations' },
  useAcquiredModules: () => ({ hasModule: (moduleId: string) => mocks.modules.has(moduleId) }),
}));
vi.mock('../../hooks/useTables', () => ({
  useTables: () => ({
    tables: [
      {
        id: 'table-7',
        organizationId: 'org-1',
        branchId: 'branch-1',
        tableNumber: 7,
        capacity: 4,
        status: 'available',
        positionX: null,
        positionY: null,
        shape: null,
        notes: null,
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
    ],
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
    updateTableStatus: vi.fn(async () => true),
  }),
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({
    terminalConfig: {
      getBranchId: async () => 'branch-1',
      getOrganizationId: async () => 'org-1',
    },
  }),
}));
// The release-time guard (item D1) is not under test here; these stubs keep its
// i18n-backed modal and approval hooks from loading.
vi.mock('../../hooks/usePrivilegedActionConfirmation', () => ({
  usePrivilegedActionConfirmation: () => ({
    runWithPrivilegedConfirmation: ({ action }: { action: () => unknown }) => action(),
    confirmationModal: null,
  }),
}));
vi.mock('../../hooks/useTableReleaseGuard', () => ({
  useTableReleaseGuard: () => ({
    guardRelease: async (_table: unknown, apply: () => unknown) => apply(),
    modal: null,
  }),
}));
vi.mock('../../components/tables/TableActionModal', () => ({ TableActionModal: () => null }));
vi.mock('../../components/tables/TableCheckManagerModal', () => ({ TableCheckManagerModal: () => null }));
vi.mock('../../components/tables/ReservationForm', () => ({
  ReservationForm: ({ isOpen, tableId, onSubmit, onCancel }: any) =>
    isOpen ? (
      <div data-testid="reservation-form" data-table-id={tableId}>
        <button
          type="button"
          onClick={() =>
            void onSubmit({
              customerName: 'Maria',
              customerPhone: '6900000000',
              reservationTime: new Date(2026, 8, 24, 19, 30),
              partySize: 4,
              tableId,
            })
          }
        >
          submit-reservation
        </button>
        <button type="button" onClick={onCancel}>
          cancel-reservation
        </button>
      </div>
    ) : null,
}));
vi.mock('../../utils/table-reservation-submit', () => ({ submitTableReservation: mocks.submit }));

import TablesPage from '../TablesPage';

const renderPage = async () => {
  render(
    <MemoryRouter>
      <TablesPage />
    </MemoryRouter>,
  );
  // Let the terminal branch and organization resolve.
  await act(async () => {
    await Promise.resolve();
  });
};

const openTable = () => fireEvent.click(screen.getByText('7'));

afterEach(() => cleanup());

// The Reserve quick action on the sidebar Tables page used to navigate to
// /reservations?tableId=..., which no route or view reads: the modal closed
// and no booking opened (24/09/2026).
describe('TablesPage Reserve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modules = new Set(['tables', 'reservations']);
    mocks.submit.mockResolvedValue('created');
  });

  it('opens the reservation form for the chosen table instead of a dead route', async () => {
    await renderPage();
    openTable();
    fireEvent.click(screen.getByText('tables.actions.newReservation'));

    expect(screen.getByTestId('reservation-form').getAttribute('data-table-id')).toBe('table-7');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('books the table for the terminal branch and refreshes the tables', async () => {
    await renderPage();
    openTable();
    fireEvent.click(screen.getByText('tables.actions.newReservation'));
    fireEvent.click(screen.getByText('submit-reservation'));

    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        editingReservation: null,
        branchId: 'branch-1',
        organizationId: 'org-1',
        data: expect.objectContaining({ tableId: 'table-7', partySize: 4 }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reservationForm.toasts.created');
    expect(screen.queryByTestId('reservation-form')).toBeNull();
  });

  it('keeps the form open and says so when the booking fails', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('TABLE_UNAVAILABLE'));
    await renderPage();
    openTable();
    fireEvent.click(screen.getByText('tables.actions.newReservation'));
    fireEvent.click(screen.getByText('submit-reservation'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('reservationForm.toasts.createFailed'));
    expect(screen.getByTestId('reservation-form')).toBeTruthy();
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it('closes the form on cancel without booking', async () => {
    await renderPage();
    openTable();
    fireEvent.click(screen.getByText('tables.actions.newReservation'));
    fireEvent.click(screen.getByText('cancel-reservation'));

    expect(screen.queryByTestId('reservation-form')).toBeNull();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('offers no Reserve without the Reservations module', async () => {
    mocks.modules = new Set(['tables']);
    await renderPage();
    openTable();

    expect(screen.getByText('tables.actions.newOrder')).toBeTruthy();
    expect(screen.queryByText('tables.actions.newReservation')).toBeNull();
  });
});

import { parseMoneyInputValue } from './moneyInput';

export interface ShiftCheckoutPrintSnapshot {
  snapshotCheckOutTime: string;
  expectedAmount?: number;
  closingAmount?: number;
  varianceAmount?: number;
}

export interface ShiftCheckoutPrintParams {
  shiftId: string;
  roleType?: string;
  terminalName?: string;
  snapshotCheckOutTime?: string;
  expectedAmount?: number;
  closingAmount?: number;
  varianceAmount?: number;
}

export interface ShiftCheckoutPrintBridge {
  terminalConfig: {
    getSetting(category: string, key: string): Promise<unknown>;
  };
  shifts: {
    printCheckout(params: ShiftCheckoutPrintParams): Promise<unknown>;
  };
}

interface BuildShiftCheckoutPrintSnapshotParams {
  shift?: {
    role_type?: string | null;
    opening_cash_amount?: number | null;
    calculation_version?: number | null;
    payment_amount?: number | null;
  } | null;
  shiftSummary?: any;
  closingCash?: string;
  driverActualCash?: string;
  isNonFinancialCheckoutRole?: boolean;
  snapshotCheckOutTime?: string;
}

const DUMMY_SNAPSHOT_TIME = '1970-01-01T00:00:00.000Z';

const hasManualCashInput = (value?: string) => Boolean(value?.trim().length);

const getEffectiveOpeningAmount = (shift: BuildShiftCheckoutPrintSnapshotParams['shift'], summary?: any) =>
  Number(shift?.opening_cash_amount ?? summary?.shift?.opening_cash_amount ?? 0);

const getInheritedStaffExpectedReturns = (summary: any) => {
  const inheritedDrivers = Array.isArray(summary?.transferredDrivers) ? summary.transferredDrivers : [];
  const inheritedWaiters = Array.isArray(summary?.transferredWaiters) ? summary.transferredWaiters : [];

  const totalDrivers = inheritedDrivers.reduce(
    (sum: number, item: any) => sum + Number(item?.net_cash_amount || 0),
    0,
  );
  const totalWaiters = inheritedWaiters.reduce(
    (sum: number, item: any) => sum + Number(item?.net_cash_amount || 0),
    0,
  );

  return totalDrivers + totalWaiters;
};

const getCurrentCashierIssuedFloat = (summary: any) => {
  const recordedGiven = Number(summary?.cashDrawer?.driver_cash_given || 0);
  if (recordedGiven > 0) {
    return recordedGiven;
  }

  const checkoutRows = Array.isArray(summary?.driverDeliveries) ? summary.driverDeliveries : [];
  const inheritedDrivers = Array.isArray(summary?.transferredDrivers) ? summary.transferredDrivers : [];
  const inheritedWaiters = Array.isArray(summary?.transferredWaiters) ? summary.transferredWaiters : [];

  const allStartingAmounts = checkoutRows.reduce(
    (sum: number, row: any) => sum + Number(row?.starting_amount || 0),
    0,
  );
  const inheritedStartingAmounts =
    inheritedDrivers.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0) +
    inheritedWaiters.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0);

  return Math.max(0, allStartingAmounts - inheritedStartingAmounts);
};

const getCashierExpectedBreakdown = (
  summary: any,
  shift: BuildShiftCheckoutPrintSnapshotParams['shift'],
  opening: number,
  expensesTotal?: number,
) => {
  const calculationVersion = Number(shift?.calculation_version ?? 1);
  const sales = Number(summary?.breakdown?.instore?.cashTotal || 0);
  const cashRefunds = Number(summary?.cashRefunds || 0);
  const expenses = expensesTotal ?? Number(summary?.totalExpenses || 0);
  const cashDrops = Number(summary?.cashDrawer?.cash_drops || 0);
  const driverGiven = getCurrentCashierIssuedFloat(summary);
  const driverReturned = Number(summary?.cashDrawer?.driver_cash_returned || 0);
  const inheritedDriverExpectedReturns = getInheritedStaffExpectedReturns(summary);
  const staffPayments = Array.isArray(summary?.staffPayments) ? summary.staffPayments : [];
  const recordedStaffPayments = staffPayments.length > 0
    ? staffPayments.reduce((sum: number, payment: any) => sum + Number(payment?.amount || 0), 0)
    : Number(summary?.cashDrawer?.total_staff_payments || 0);
  const deductedStaffPayments = recordedStaffPayments;
  const expected =
    opening +
    sales -
    cashRefunds -
    expenses -
    deductedStaffPayments -
    cashDrops -
    driverGiven +
    driverReturned +
    inheritedDriverExpectedReturns;

  return {
    calculationVersion,
    expected,
  };
};

function buildSnapshotValues(
  params: BuildShiftCheckoutPrintSnapshotParams,
): Omit<ShiftCheckoutPrintSnapshot, 'snapshotCheckOutTime'> | null {
  const role = (params.shift?.role_type || '').trim().toLowerCase();
  const shiftSummary = params.shiftSummary;
  const shift = params.shift;

  if (!shift) {
    return null;
  }

  if (params.isNonFinancialCheckoutRole || role === 'kitchen') {
    return {};
  }

  if (role === 'cashier' || role === 'manager') {
    const opening = getEffectiveOpeningAmount(shift, shiftSummary);
    const expectedAmount = getCashierExpectedBreakdown(
      shiftSummary,
      shift,
      opening,
      shiftSummary?.totalExpenses || 0,
    ).expected;
    if (!hasManualCashInput(params.closingCash)) {
      return { expectedAmount };
    }

    const closingAmount = parseMoneyInputValue(params.closingCash!.trim());

    if (closingAmount < 0) {
      return null;
    }

    return {
      expectedAmount,
      closingAmount,
      varianceAmount: closingAmount - expectedAmount,
    };
  }

  if (role === 'driver') {
    const deliveries = Array.isArray(shiftSummary?.driverDeliveries) ? shiftSummary.driverDeliveries : [];
    const completedDeliveries = deliveries.filter((delivery: any) => {
      const status = String(delivery?.status || delivery?.order_status || '').toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
    });
    const expectedAmount =
      getEffectiveOpeningAmount(shift, shiftSummary) +
      completedDeliveries.reduce(
        (sum: number, delivery: any) => sum + Number(delivery?.cash_collected || 0),
        0,
      ) -
      Number(shiftSummary?.totalExpenses || 0);
    if (!hasManualCashInput(params.driverActualCash)) {
      return { expectedAmount };
    }

    const closingAmount = parseMoneyInputValue(params.driverActualCash!.trim());

    if (closingAmount < 0) {
      return null;
    }

    return {
      expectedAmount,
      closingAmount,
      varianceAmount: closingAmount - expectedAmount,
    };
  }

  if (role === 'server') {
    const waiterTables = Array.isArray(shiftSummary?.waiterTables) ? shiftSummary.waiterTables : [];
    const opening = getEffectiveOpeningAmount(shift, shiftSummary);
    const cashFromTables = waiterTables.reduce(
      (sum: number, table: any) => sum + Number(table?.cash_amount || 0),
      0,
    );
    const expensesTotal = Number(shiftSummary?.totalExpenses || 0);
    const calculationVersion = Number(shift?.calculation_version ?? 1);
    const paymentAmount = Number(shift?.payment_amount || 0);
    const expectedAmount = calculationVersion >= 2
      ? opening + cashFromTables - expensesTotal
      : opening + cashFromTables - expensesTotal - paymentAmount;
    if (!hasManualCashInput(params.closingCash)) {
      return { expectedAmount };
    }

    const closingAmount = parseMoneyInputValue(params.closingCash!.trim());

    if (closingAmount < 0) {
      return null;
    }

    return {
      expectedAmount,
      closingAmount,
      varianceAmount: closingAmount - expectedAmount,
    };
  }

  if (!hasManualCashInput(params.closingCash)) {
    return {};
  }

  const closingAmount = parseMoneyInputValue(params.closingCash!.trim());
  if (closingAmount < 0) {
    return null;
  }

  return {
    closingAmount,
  };
}

export function canPrintShiftCheckoutSnapshot(
  params: Omit<BuildShiftCheckoutPrintSnapshotParams, 'snapshotCheckOutTime'>,
): boolean {
  return buildSnapshotValues({
    ...params,
    snapshotCheckOutTime: DUMMY_SNAPSHOT_TIME,
  }) !== null;
}

export function buildShiftCheckoutPrintSnapshot(
  params: BuildShiftCheckoutPrintSnapshotParams,
): ShiftCheckoutPrintSnapshot | null {
  const values = buildSnapshotValues(params);
  if (!values) {
    return null;
  }

  return {
    snapshotCheckOutTime: params.snapshotCheckOutTime || new Date().toISOString(),
    ...values,
  };
}

export async function queueShiftCheckoutPrint(params: {
  bridge: ShiftCheckoutPrintBridge;
  shiftId: string;
  roleType?: string;
  snapshot?: ShiftCheckoutPrintSnapshot;
}) {
  let terminalName: string | undefined;

  try {
    const rawTerminalName = await params.bridge.terminalConfig.getSetting('terminal', 'name');
    if (typeof rawTerminalName === 'string' && rawTerminalName.trim()) {
      terminalName = rawTerminalName.trim();
    }
  } catch (_error) {
    terminalName = undefined;
  }

  return params.bridge.shifts.printCheckout({
    shiftId: params.shiftId,
    roleType: params.roleType,
    terminalName,
    ...params.snapshot,
  });
}

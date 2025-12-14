import type { ZReportData, StaffPerformance } from '../types/reports';

export function exportArrayToCSV(data: Record<string, any>[], filename: string) {
  if (!data || data.length === 0) {
    const headers = Object.keys(data?.[0] || { Empty: '' });
    const csv = [headers.join(',')].join('\n');
    downloadCSV(csv, filename);
    return;
  }
  const headers = Object.keys(data[0]);
  const csv = [headers.join(','), ...data.map(r => headers.map(h => JSON.stringify((r as any)[h] ?? '')).join(','))].join('\n');
  downloadCSV(csv, filename);
}

function downloadCSV(csvString: string, filename: string) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportZReportToCSV(zReport: ZReportData, filename: string = 'z-report') {
  if (!zReport) return;
  const rows: Record<string, any>[] = [];

  rows.push({ Section: 'Shifts', Metric: 'Total', Value: zReport.shifts.total });
  rows.push({ Section: 'Shifts', Metric: 'Cashier', Value: zReport.shifts.cashier });
  rows.push({ Section: 'Shifts', Metric: 'Driver', Value: zReport.shifts.driver });

  rows.push({ Section: 'Sales', Metric: 'Total Orders', Value: zReport.sales.totalOrders });
  rows.push({ Section: 'Sales', Metric: 'Total Sales', Value: zReport.sales.totalSales });
  rows.push({ Section: 'Sales', Metric: 'Cash Sales', Value: zReport.sales.cashSales });
  rows.push({ Section: 'Sales', Metric: 'Card Sales', Value: zReport.sales.cardSales });

  rows.push({ Section: 'Cash Drawer', Metric: 'Total Variance', Value: zReport.cashDrawer.totalVariance });
  rows.push({ Section: 'Cash Drawer', Metric: 'Total Cash Drops', Value: zReport.cashDrawer.totalCashDrops });
  rows.push({ Section: 'Cash Drawer', Metric: 'Unreconciled Drawers', Value: zReport.cashDrawer.unreconciledCount });

  rows.push({ Section: 'Expenses', Metric: 'Total', Value: zReport.expenses.total });
  rows.push({ Section: 'Expenses', Metric: 'Pending Count', Value: zReport.expenses.pendingCount });

  rows.push({ Section: 'Driver Earnings', Metric: 'Total Deliveries', Value: zReport.driverEarnings.totalDeliveries });
  rows.push({ Section: 'Driver Earnings', Metric: 'Total Earnings', Value: zReport.driverEarnings.totalEarnings });
  rows.push({ Section: 'Driver Earnings', Metric: 'Unsettled Count', Value: zReport.driverEarnings.unsettledCount });

  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
  downloadCSV(csv, filename);
}

export function exportStaffPerformanceToCSV(staff: StaffPerformance[], filename: string = 'staff-performance') {
  if (!staff?.length) return;
  const rows = staff.map(s => ({
    'Staff ID': s.staffId,
    Name: s.name,
    Role: s.role || '',
    Hours: s.hours ?? '',
    Orders: s.orders ?? '',
    Sales: s.sales ?? '',
    Variance: s.variance ?? '',
    Expenses: s.expenses ?? '',
    Deliveries: s.deliveries ?? ''
  }));
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => JSON.stringify((r as any)[h] ?? '')).join(','))].join('\n');
  downloadCSV(csv, filename);
}


type ZReportStaff = NonNullable<ZReportData['staffReports']>[number];

/**
 * Export detailed orders from staff reports to CSV.
 * Intended for Z-Report staff objects that include 'ordersDetails'.
 */
export function exportStaffOrdersToCSV(
  staffReports: ZReportStaff[],
  filename: string = 'z-report-staff-orders'
) {
  if (!staffReports?.length) return;

  const hasOrders = staffReports.some(s => s.ordersDetails && s.ordersDetails.length > 0);
  if (!hasOrders) {
    console.warn('exportStaffOrdersToCSV: no staff with ordersDetails provided');
    return;
  }

  const rows: Record<string, any>[] = [];

  staffReports.forEach(staff => {
    if (staff.ordersDetails && staff.ordersDetails.length > 0) {
      staff.ordersDetails.forEach((order: any) => {
        rows.push({
          'Staff Name': staff.staffName || staff.staffId,
          'Staff Role': staff.role,
          'Order Number': order.orderNumber,
          'Order Type': order.orderType,
          'Table/Address': order.orderType === 'delivery'
            ? order.deliveryAddress
            : order.orderType === 'dine-in'
              ? `Table ${order.tableNumber}`
              : '—',
          'Amount': order.amount,
          'Payment Method': order.paymentMethod || '—',
          'Status': order.status,
          'Time': order.createdAt
        });
      });
    }
  });

  if (rows.length === 0) {
    console.warn('No orders to export');
    return;
  }

  exportArrayToCSV(rows, filename);
}

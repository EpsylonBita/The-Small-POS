export function generateZReportReceipt(snapshot: any, terminalName?: string, paperWidth: number = 48): string {
  const lines: string[] = [];
  const pad = (s: string = '', len = 32) => {
    const RIGHT = 12;
    const LEFT = Math.max(0, paperWidth - RIGHT);
    const target = len > 20 ? LEFT : RIGHT;
    return s.length > target ? s.slice(0, target) : s + ' '.repeat(Math.max(0, target - s.length));
  };
  const num = (n: any) => (Number(n || 0)).toFixed(2);
  const divider = () => lines.push('-'.repeat(paperWidth));
  const doubleDivider = () => lines.push('='.repeat(paperWidth));

  // Visual symbols for status and payment types
  const statusSymbol = (status: string) => status === 'closed' ? '[OK]' : '[  ]';
  const paymentSymbol = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'cash': return '$';
      case 'card': return '#';
      default: return '*';
    }
  };

  const date = snapshot?.date || new Date().toISOString().slice(0, 10);

  lines.push('*** Z REPORT ***');
  if (terminalName) lines.push(`Terminal: ${terminalName}`);
  lines.push(`Date: ${date}`);
  divider();

  // Terminal Breakdown (Comment 3 enhancement)
  const terminalBreakdown = Array.isArray(snapshot?.terminalBreakdown) ? snapshot.terminalBreakdown : [];
  if (terminalBreakdown.length > 0) {
    lines.push('Terminal Breakdown');
    terminalBreakdown.forEach((t: any) => {
      // Optional marker prefix if type is available
      let prefix = '';
      if (t.type === 'main') prefix = '[M] ';
      else if (t.type === 'mobile_waiter' || t.type === 'waiter') prefix = '[W] ';

      lines.push(`${prefix}${t.name || t.id}`);
      lines.push(pad('  Orders', 20) + pad(String(t.orders || 0), 12));
      lines.push(pad('  Total', 20) + pad(num(t.total), 12));
      lines.push(pad('  $ Cash', 20) + pad(num(t.cash), 12));
      lines.push(pad('  # Card', 20) + pad(num(t.card), 12));
    });
    divider();
  }

  // Shifts
  const shifts = snapshot?.shifts || {};
  lines.push('Shifts');
  lines.push(pad('  Total', 20) + pad(String(shifts.total || 0), 12));
  lines.push(pad('  Cashier', 20) + pad(String(shifts.cashier || 0), 12));
  lines.push(pad('  Driver', 20) + pad(String(shifts.driver || 0), 12));
  divider();

  // Sales summary
  const sales = snapshot?.sales || {};
  lines.push('Sales Summary');
  lines.push(pad('  Orders', 20) + pad(String(sales.totalOrders || 0), 12));
  lines.push(pad('  Total', 20) + pad(num(sales.totalSales), 12));
  lines.push(pad('  Cash', 20) + pad(num(sales.cashSales), 12));
  lines.push(pad('  Card', 20) + pad(num(sales.cardSales), 12));
  divider();

  // By type
  const byType = sales.byType || {};
  const instore = byType.instore || { cash: {}, card: {} };
  const delivery = byType.delivery || { cash: {}, card: {} };
  lines.push('By Order Type');
  lines.push('  In-Store');
  lines.push(pad(`    Cash (${instore.cash.count || 0})`, 20) + pad(num(instore.cash.total), 12));
  lines.push(pad(`    Card (${instore.card.count || 0})`, 20) + pad(num(instore.card.total), 12));
  lines.push('  Delivery');
  lines.push(pad(`    Cash (${delivery.cash.count || 0})`, 20) + pad(num(delivery.cash.total), 12));
  lines.push(pad(`    Card (${delivery.card.count || 0})`, 20) + pad(num(delivery.card.total), 12));
  divider();

  // Cash drawer totals
  const cd = snapshot?.cashDrawer || {};
  lines.push('Cash Drawer Totals');
  lines.push(pad('  Opening Total', 20) + pad(num(cd.openingTotal), 12));
  lines.push(pad('  Driver Given', 20) + pad(num(cd.driverCashGiven), 12));
  lines.push(pad('  Driver Returned', 20) + pad(num(cd.driverCashReturned), 12));
  lines.push(pad('  Variance', 20) + pad(num(cd.totalVariance), 12));
  lines.push(pad('  Cash Drops', 20) + pad(num(cd.totalCashDrops), 12));
  lines.push(pad('  Unreconciled', 20) + pad(String(cd.unreconciledCount || 0), 12));
  divider();

  // Expenses
  const expenses = snapshot?.expenses || {};
  lines.push('Expenses');
  lines.push(pad('  Total', 20) + pad(num(expenses.total), 12));
  lines.push(pad('  Staff Payments', 20) + pad(num(expenses.staffPaymentsTotal), 12));
  lines.push(pad('  Pending', 20) + pad(String(expenses.pendingCount || 0), 12));
  divider();

  // Driver earnings with completed/cancelled breakdown
  const de = snapshot?.driverEarnings || {};
  lines.push('Driver Earnings');
  lines.push(pad('  Total Deliveries', 20) + pad(String(de.totalDeliveries || 0), 12));
  lines.push(pad('    [OK] Completed', 20) + pad(String(de.completedDeliveries || 0), 12));
  lines.push(pad('    [X ] Cancelled', 20) + pad(String(de.cancelledDeliveries || 0), 12));
  lines.push(pad('  Total Earned', 20) + pad(num(de.totalEarnings), 12));
  lines.push(pad('  $ Cash Collected', 20) + pad(num(de.cashCollectedTotal), 12));
  lines.push(pad('  # Card Amount', 20) + pad(num(de.cardAmountTotal), 12));
  lines.push(pad('  Cash to Return', 20) + pad(num(de.cashToReturnTotal), 12));
  divider();

  // Staff personal Z (by shift) with status symbols
  const staffReports = Array.isArray(snapshot?.staffReports) ? snapshot.staffReports : [];
  if (staffReports.length > 0) {
    doubleDivider();
    lines.push('Staff Reports');
    doubleDivider();
    staffReports.forEach((s: any) => {
      const status = statusSymbol(s.shiftStatus || (s.checkOut ? 'closed' : 'active'));
      lines.push(`${status} ${s.staffName || s.staffId} (${s.role})`);
      const checkInTime = s.checkIn ? new Date(s.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
      const checkOutTime = s.checkOut ? new Date(s.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
      lines.push(`  In: ${checkInTime}  Out: ${checkOutTime}`);
      lines.push(pad('  Orders', 20) + pad(String(s.orders?.count || 0), 12));
      lines.push(pad('    $ Cash', 20) + pad(num(s.orders?.cashAmount), 12));
      lines.push(pad('    # Card', 20) + pad(num(s.orders?.cardAmount), 12));
      lines.push(pad('  Payment Received', 20) + pad(num(s.payments?.staffPayments), 12));
      lines.push(pad('  Expenses', 20) + pad(num(s.expenses?.total), 12));
      lines.push(pad('  Returned to Drawer', 20) + pad(num(s.returnedToDrawerAmount), 12));
      if (String(s.role).toLowerCase() === 'driver') {
        lines.push(pad('  Deliveries', 20) + pad(String(s.driver?.deliveries || 0), 12));
        lines.push(pad('    [OK] Completed', 20) + pad(String(s.driver?.completedDeliveries || 0), 12));
        lines.push(pad('    [X ] Cancelled', 20) + pad(String(s.driver?.cancelledDeliveries || 0), 12));
        lines.push(pad('  Earnings', 20) + pad(num(s.driver?.earnings), 12));
        lines.push(pad('  $ Driver Cash', 20) + pad(num(s.driver?.cashCollected), 12));
        lines.push(pad('  # Driver Card', 20) + pad(num(s.driver?.cardAmount), 12));
      }
      divider();
    });
  }

  // Staff Analytics section - detailed staff payments from staff_payments table
  const staffAnalytics = Array.isArray(snapshot?.staffAnalytics) ? snapshot.staffAnalytics : [];
  if (staffAnalytics.length > 0) {
    doubleDivider();
    lines.push('Staff Payments Detail');
    doubleDivider();
    staffAnalytics.forEach((p: any) => {
      const status = statusSymbol(p.shiftStatus || 'active');
      const payType = p.paymentType ? `(${p.paymentType})` : '';
      lines.push(`${status} ${p.staffName || p.staffId} ${payType}`);
      if (p.checkInTime || p.checkOutTime) {
        const checkIn = p.checkInTime ? new Date(p.checkInTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
        const checkOut = p.checkOutTime ? new Date(p.checkOutTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
        lines.push(`  Shift: ${checkIn} - ${checkOut}`);
      }
      lines.push(pad('  Amount Paid', 20) + pad(num(p.amount), 12));
      if (p.notes) {
        lines.push(`  Note: ${p.notes}`);
      }
      divider();
    });

    // Total staff payments
    const totalPayments = staffAnalytics.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    lines.push(pad('Total Staff Payments', 20) + pad(num(totalPayments), 12));
    divider();
  }

  // Drawers list
  const drawers = Array.isArray(snapshot?.drawers) ? snapshot.drawers : [];
  lines.push('Drawers');
  drawers.forEach((d: any, idx: number) => {
    const name = d.staffName || `Drawer ${idx + 1}`;
    lines.push(`  ${name}`);
    lines.push(pad('    Opening', 20) + pad(num(d.opening), 12));
    lines.push(pad('    Cash', 20) + pad(num(d.cashSales), 12));
    lines.push(pad('    Card', 20) + pad(num(d.cardSales), 12));
    lines.push(pad('    Expected', 20) + pad(num(d.expected), 12));
    lines.push(pad('    Closing', 20) + pad(num(d.closing), 12));
    lines.push(pad('    Variance', 20) + pad(num(d.variance), 12));
  });
  divider();

  // Day Summary
  const ds = snapshot?.daySummary || {};
  lines.push('Day Summary');
  lines.push(pad('  Cash Total', 20) + pad(num(ds.cashTotal), 12));
  lines.push(pad('  Card Total', 20) + pad(num(ds.cardTotal), 12));
  lines.push(pad('  Total', 20) + pad(num(ds.total), 12));
  divider();

  lines.push('Submitted to Admin');
  lines.push(new Date().toISOString());
  lines.push('--- END Z REPORT ---');

  return lines.join('\n');
}


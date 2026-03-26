import type { ZReportData } from '../types/reports';

export type ZReportStaffReport = NonNullable<ZReportData['staffReports']>[number];

export interface ResolvedZReportPeriod {
  start?: string;
  end?: string;
}

function pickString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function toNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolveZReportPeriod(
  report?: Pick<ZReportData, 'period' | 'periodStart' | 'periodEnd'> | null
): ResolvedZReportPeriod {
  return {
    start: pickString(report?.period?.start, report?.periodStart),
    end: pickString(report?.period?.end, report?.periodEnd),
  };
}

export function normalizeZReportData(report: ZReportData | null | undefined): ZReportData | null {
  if (!report) {
    return null;
  }

  const period = resolveZReportPeriod(report);
  const normalizedPeriod = period.start || period.end
    ? {
      start: period.start,
      end: period.end,
    }
    : undefined;

  return {
    ...report,
    period: normalizedPeriod,
    periodStart: report.periodStart ?? normalizedPeriod?.start,
    periodEnd: report.periodEnd ?? normalizedPeriod?.end,
  };
}

export function resolveShiftEarnedTotal(staff?: Partial<ZReportStaffReport> | null): number {
  const explicitTotal = staff?.orders?.totalAmount;
  if (typeof explicitTotal === 'number' && Number.isFinite(explicitTotal)) {
    return explicitTotal;
  }

  return toNumber(staff?.orders?.cashAmount) + toNumber(staff?.orders?.cardAmount);
}

export function resolveShiftActivityCount(staff?: Partial<ZReportStaffReport> | null): number {
  const role = String(staff?.role || '').toLowerCase();
  if (role === 'driver') {
    return toNumber(staff?.driver?.deliveries ?? staff?.orders?.count);
  }

  return toNumber(staff?.orders?.count);
}

export function resolveShiftWindow(staff?: Partial<ZReportStaffReport> | null): ResolvedZReportPeriod {
  return {
    start: pickString(staff?.checkIn),
    end: pickString(staff?.checkOut),
  };
}

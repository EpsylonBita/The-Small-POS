import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZReportData } from '../../types/reports';
import { resolveZReportPresentation, resolveZReportTwintTotal, resolveShiftEarnedTotal } from '../zReport';
import { exportZReportToCSV } from '../reportExport';
const report = (patch: Partial<ZReportData> = {}): ZReportData => ({
  date: '2026-10-02', shifts: {total:1,cashier:1,driver:0},
  sales:{totalOrders:1,totalSales:55,cashSales:10,cardSales:20,twintSales:25},
  cashDrawer:{totalVariance:0,totalCashDrops:0,unreconciledCount:0},
  expenses:{total:0,pendingCount:0,items:[]},driverEarnings:{totalDeliveries:0,totalEarnings:0,unsettledCount:0},
  presentation:{deliveryModuleEnabled:false,twintPluginEnabled:false}, ...patch,
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('TWINT Z presentation and CSV',()=>{
  it('keeps TWINT separate and visible after plugin disable, and includes it in legacy shift fallback',()=>{
    const r=report(); expect(resolveZReportTwintTotal(r)).toBe(25);
    expect(resolveZReportPresentation(r)).toEqual({expenses:false,delivery:false,drivers:false,waiters:false,twint:true});
    expect(resolveShiftEarnedTotal({orders:{count:1,cashAmount:10,cardAmount:20,twintAmount:25,totalAmount:undefined as unknown as number}})).toBe(55);
  });
  it('shows an enabled zero TWINT total without requiring QR readiness',()=>{
    const r=report({sales:{totalOrders:0,totalSales:0,cashSales:0,cardSales:0},presentation:{twintPluginEnabled:true,deliveryModuleEnabled:false}});
    expect(resolveZReportTwintTotal(r)).toBe(0);expect(resolveZReportPresentation(r).twint).toBe(true);
  });
  it('retains money when delivery disabled and hides empty driver placeholders',()=>{
    const r=report({staffReports:[{role:'driver',orders:{count:0,cashAmount:0,cardAmount:0,totalAmount:0}} as never]});
    expect(resolveZReportPresentation(r).drivers).toBe(false);
    r.staffReports![0].orders.twintAmount=25;r.staffReports![0].orders.totalAmount=25;
    expect(resolveZReportPresentation(r).drivers).toBe(true);
    r.sales={...r.sales,deliverySales:9} as ZReportData['sales'];
    expect(resolveZReportPresentation(r).delivery).toBe(true);
    r.expenses={total:2,pendingCount:0,items:[]};expect(resolveZReportPresentation(r).expenses).toBe(true);
  });
  it('keeps frozen flags when later live configuration would change',()=>{
    const r=report({presentation:{twintPluginEnabled:true,deliveryModuleEnabled:false},sales:{totalOrders:0,totalSales:0,cashSales:0,cardSales:0}});
    const stored=JSON.parse(JSON.stringify(r));expect(resolveZReportPresentation(stored).twint).toBe(true);
    expect(resolveZReportPresentation({...stored,presentation:{twintPluginEnabled:false}}).twint).toBe(false);
  });
  it('exports distinct mixed amounts and omits empty optional sections',()=>{
    let csv=''; class CaptureBlob {constructor(chunks:string[]){csv=chunks.join('');}}
    vi.stubGlobal('Blob',CaptureBlob);
    Object.defineProperty(URL,'createObjectURL',{value:vi.fn(()=> 'blob:z'),configurable:true,writable:true});
    Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true,writable:true});
    vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
    exportZReportToCSV(report());
    expect(csv).toContain('"Sales","TWINT",25');expect(csv).toContain('"Sales","Card Sales",20');
    expect(csv).not.toContain('"Expenses"');expect(csv).not.toContain('"Driver Earnings"');expect(csv).not.toContain('"Shifts","Driver"');
    exportZReportToCSV(report({sales:{totalOrders:0,totalSales:0,cashSales:0,cardSales:0},presentation:{twintPluginEnabled:true}}));
    expect(csv).toContain('"Sales","TWINT",0');
  });
});

import { useCallback, useEffect, useState } from 'react';
import { getBridge, offEvent, onEvent, type RemoteIncidentReportResponse } from '../../../lib';
import { verifiedSupportReceipt } from '../../services/support/SupportRemedyRunner';
import type { TillHealthReport } from './till-health-model';

const reportKey = (report: TillHealthReport) => report.result.reportId ?? report.result.path;
const byCreation = (left: TillHealthReport, right: TillHealthReport) => Date.parse(right.at) - Date.parse(left.at);

export function useTillHealthReports(scope: string, open: boolean) {
  const [archive, setArchive] = useState<{ scope: string; copies: TillHealthReport[]; unavailable: boolean }>();
  const [recent, setRecent] = useState<{ scope: string; reports: TillHealthReport[] }>();

  useEffect(() => {
    const diagnostics = getBridge().diagnostics;
    if (!scope || !open || typeof diagnostics.listReports !== 'function') return;
    let active = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const rows = await diagnostics.listReports();
        if (!active || current !== request) return;
        setArchive({
          scope,
          copies: rows.map(result => ({
            at: result.createdAt ?? result.lastSentAt ?? '',
            result,
            automatic: false,
          })),
          unavailable: false,
        });
      } catch {
        if (!active || current !== request) return;
        setArchive(previous => ({ scope, copies: previous?.scope === scope ? previous.copies : [], unavailable: true }));
      }
    };
    onEvent('diagnostics-reports-changed', refresh);
    void refresh();
    return () => {
      active = false;
      offEvent('diagnostics-reports-changed', refresh);
    };
  }, [scope, open]);

  const recordReport = useCallback((result: RemoteIncidentReportResponse, at?: string, automatic = false) => {
    if (automatic && !verifiedSupportReceipt(result)) return;
    const report = { result, at: at ?? result.createdAt ?? result.lastSentAt ?? new Date().toISOString(), automatic };
    setRecent(previous => {
      const reports = previous?.scope === scope ? previous.reports : [];
      return { scope, reports: [report, ...reports.filter(item => reportKey(item) !== reportKey(report))].slice(0, 30) };
    });
  }, [scope]);

  const drafts = recent?.scope === scope ? recent.reports : [];
  const draftKeys = new Set(drafts.map(reportKey));
  const saved = (archive?.scope === scope ? archive.copies : []).filter(
    report => !report.result.historical || !draftKeys.has(reportKey(report)),
  );
  const keys = new Set(saved.map(reportKey));
  const current = drafts.filter(report => !keys.has(reportKey(report)));
  const copies = [...saved, ...current.filter(report => report.result.localPrepared && report.result.path)].sort(byCreation);
  return {
    last: [...current, ...saved.filter(report => !report.result.historical)].sort(byCreation)[0] ?? copies[0] ?? null,
    copies,
    historyUnavailable: archive?.scope === scope && archive.unavailable,
    recordReport,
  };
}

import React, { useEffect, useState, useCallback } from 'react';
import { useTheme } from '../contexts/theme-context';
import {
  Activity,
  Wifi,
  WifiOff,
  Printer,
  FileText,
  RefreshCw,
  Download,
  Database,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderOpen,
} from 'lucide-react';
import {
  getBridge,
  offEvent,
  onEvent,
  type DiagnosticsExportOptions,
  type DiagnosticsSystemHealth,
} from '../../lib';

const SystemHealthPage: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const bridge = getBridge();
  const [health, setHealth] = useState<DiagnosticsSystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await bridge.diagnostics.getSystemHealth();
      setHealth(data);
    } catch (err) {
      console.error('Failed to load system health:', err);
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    let disposed = false;

    const handleHealthUpdate = (payload: any) => {
      if (disposed) return;
      // Support both legacy `{ success, data }` and direct health payloads.
      const candidate = payload?.data && payload?.success ? payload.data : payload;
      if (candidate && typeof candidate === 'object') {
        setHealth(candidate as DiagnosticsSystemHealth);
        setLoading(false);
      }
    };

    void refresh();
    onEvent('database-health-update', handleHealthUpdate);

    return () => {
      disposed = true;
      offEvent('database-health-update', handleHealthUpdate);
    };
  }, [refresh]);

  const handleExport = async () => {
    setExporting(true);
    setExportPath(null);
    try {
      const options: DiagnosticsExportOptions = {
        includeLogs: true,
        redactSensitive: false,
      };
      const result = await bridge.diagnostics.export(options);
      if (result?.success && result?.path) {
        setExportPath(result.path);
      }
    } catch (err) {
      console.error('Failed to export diagnostics:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleOpenExportDir = async () => {
    if (!exportPath) return;
    try {
      await bridge.diagnostics.openExportDir(exportPath);
    } catch (error) {
      console.warn('Failed to open diagnostics export folder:', error);
      // fallback: do nothing
    }
  };

  const handleRemoveInvalidOrders = async () => {
    if (!health?.invalidOrders?.details?.length) return;

    try {
      const orderIds = health.invalidOrders.details.map(o => o.order_id);
      const result = await bridge.sync.removeInvalidOrders(orderIds);
      if (result?.success) {
        // Refresh to show updated status
        await refresh();
      }
    } catch (err) {
      console.error('Failed to remove invalid orders:', err);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatCurrency = (n: number) => `€${n.toFixed(2)}`;

  const totalBacklog = health
    ? Object.values(health.syncBacklog).reduce((sum, statuses) => {
        return sum + Object.entries(statuses)
          .filter(([s]) => s !== 'synced' && s !== 'applied')
          .reduce((s, [, c]) => s + c, 0);
      }, 0)
    : 0;

  const cardClass = `rounded-xl border p-4 ${isDark ? 'bg-gray-900/60 border-white/10' : 'bg-white border-gray-200'} shadow-sm`;
  const labelClass = `text-xs font-medium uppercase tracking-wider ${isDark ? 'text-gray-500' : 'text-gray-400'}`;
  const valueClass = `text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`;

  return (
    <div className="h-full overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-blue-500" />
          <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            System Health
          </h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all
              ${isDark ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}
              disabled:opacity-50`}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all
              bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50`}
          >
            <Download className={`w-4 h-4 ${exporting ? 'animate-bounce' : ''}`} />
            {exporting ? 'Exporting...' : 'Export Diagnostics'}
          </button>
        </div>
      </div>

      {/* Export success banner */}
      {exportPath && (
        <div className={`mb-4 p-3 rounded-lg flex items-center gap-3 ${isDark ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
          <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-medium ${isDark ? 'text-green-400' : 'text-green-700'}`}>
              Diagnostics exported successfully
            </p>
            <p className={`text-xs truncate font-mono ${isDark ? 'text-green-500/70' : 'text-green-600/70'}`}>
              {exportPath}
            </p>
          </div>
          <button
            onClick={handleOpenExportDir}
            className={`flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium
              ${isDark ? 'bg-green-500/20 hover:bg-green-500/30 text-green-400' : 'bg-green-100 hover:bg-green-200 text-green-700'}`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open Folder
          </button>
        </div>
      )}

      {!health && loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
        </div>
      ) : health ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Connection Status */}
          <div className={cardClass}>
            <div className={labelClass}>Connection</div>
            <div className="flex items-center gap-2 mt-2">
              {health.isOnline ? (
                <>
                  <Wifi className="w-5 h-5 text-green-500" />
                  <span className={`${valueClass} text-green-500`}>Online</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-5 h-5 text-red-500" />
                  <span className={`${valueClass} text-red-500`}>Offline</span>
                </>
              )}
            </div>
            {health.lastSyncTime && (
              <div className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                <Clock className="w-3 h-3 inline mr-1" />
                Last sync: {new Date(health.lastSyncTime).toLocaleString()}
              </div>
            )}
          </div>

          {/* Sync Backlog */}
          <div className={cardClass}>
            <div className={labelClass}>Sync Backlog</div>
            <div className="flex items-center gap-2 mt-2">
              {totalBacklog === 0 ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  <span className={`${valueClass} text-green-500`}>Clear</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <span className={`${valueClass} text-amber-500`}>{totalBacklog} pending</span>
                </>
              )}
            </div>
            {totalBacklog > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(health.syncBacklog).map(([type, statuses]) => {
                  const pending = Object.entries(statuses)
                    .filter(([s]) => s !== 'synced' && s !== 'applied')
                    .reduce((s, [, c]) => s + c, 0);
                  if (pending === 0) return null;
                  return (
                    <div key={type} className={`text-xs flex justify-between ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      <span>{type}</span>
                      <span className="font-mono">{pending}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pending Orders Validation */}
          <div className={cardClass}>
            <div className={labelClass}>Pending Orders Validation</div>
            <div className="flex items-center gap-2 mt-2">
              {(health.invalidOrders?.count ?? 0) === 0 ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  <span className={`${valueClass} text-green-500`}>All valid</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  <span className={`${valueClass} text-red-500`}>
                    {health.invalidOrders!.count} invalid
                  </span>
                </>
              )}
            </div>
            {(health.invalidOrders?.count ?? 0) > 0 && (
              <>
                <div className={`text-xs mt-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Orders have menu items not found in local cache
                </div>
                <button
                  onClick={handleRemoveInvalidOrders}
                  className={`mt-3 w-full px-3 py-2 rounded-lg text-sm font-medium transition-all
                    bg-red-500 hover:bg-red-600 text-white`}
                >
                  Remove Invalid Orders
                </button>
                <div className="mt-2 space-y-1 max-h-32 overflow-auto">
                  {health.invalidOrders!.details.slice(0, 5).map((order) => (
                    <div key={order.order_id} className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      <div className="flex justify-between">
                        <span className="font-mono">{order.order_id.substring(0, 8)}...</span>
                        <span className="text-red-500">{order.invalid_menu_items.length} items</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Printer Status */}
          <div className={cardClass}>
            <div className={labelClass}>Printers</div>
            <div className="flex items-center gap-2 mt-2">
              <Printer className={`w-5 h-5 ${health.printerStatus.configured ? 'text-green-500' : 'text-gray-400'}`} />
              <span className={valueClass}>
                {health.printerStatus.configured
                  ? `${health.printerStatus.profileCount} configured`
                  : 'Not configured'}
              </span>
            </div>
            {health.printerStatus.defaultProfile && (
              <div className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Default: {health.printerStatus.defaultProfile}
              </div>
            )}
            {health.printerStatus.recentJobs.length > 0 && (
              <div className="mt-2 space-y-1">
                {health.printerStatus.recentJobs.slice(0, 3).map((job) => (
                  <div key={job.id} className={`text-xs flex justify-between ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    <span>{job.entityType}</span>
                    <span className={`font-mono ${
                      job.status === 'printed' ? 'text-green-500'
                        : job.status === 'failed' ? 'text-red-500'
                        : 'text-amber-500'
                    }`}>
                      {job.status}
                      {job.warningCode ? ' ⚠' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Last Z-Report */}
          <div className={cardClass}>
            <div className={labelClass}>Last Z-Report</div>
            {health.lastZReport ? (
              <>
                <div className="flex items-center gap-2 mt-2">
                  <FileText className="w-5 h-5 text-blue-500" />
                  <span className={valueClass}>
                    {formatCurrency(health.lastZReport.totalGrossSales)}
                  </span>
                </div>
                <div className={`text-xs mt-2 space-y-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  <div>Generated: {new Date(health.lastZReport.generatedAt).toLocaleString()}</div>
                  <div>Sync: <span className={`font-mono ${health.lastZReport.syncState === 'applied' ? 'text-green-500' : 'text-amber-500'}`}>{health.lastZReport.syncState}</span></div>
                  <div>Net: {formatCurrency(health.lastZReport.totalNetSales)}</div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 mt-2">
                <FileText className={`w-5 h-5 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
                <span className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  No reports generated
                </span>
              </div>
            )}
          </div>

          {/* Database */}
          <div className={cardClass}>
            <div className={labelClass}>Database</div>
            <div className="flex items-center gap-2 mt-2">
              <Database className="w-5 h-5 text-purple-500" />
              <span className={valueClass}>v{health.schemaVersion}</span>
            </div>
            <div className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Size: {formatBytes(health.dbSizeBytes)}
            </div>
          </div>

          {/* Pending Orders */}
          <div className={cardClass}>
            <div className={labelClass}>Pending Sync Queue</div>
            <div className="flex items-center gap-2 mt-2">
              {health.pendingOrders === 0 ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  <span className={`${valueClass} text-green-500`}>0</span>
                </>
              ) : (
                <>
                  <Clock className="w-5 h-5 text-amber-500" />
                  <span className={`${valueClass} text-amber-500`}>{health.pendingOrders}</span>
                </>
              )}
            </div>
          </div>

          {/* Last Sync Times */}
          {Object.keys(health.lastSyncTimes).length > 0 && (
            <div className={`${cardClass} md:col-span-2 lg:col-span-3`}>
              <div className={labelClass}>Last Successful Sync by Entity</div>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
                {Object.entries(health.lastSyncTimes).map(([entity, ts]) => (
                  <div key={entity} className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    <div className="font-medium">{entity}</div>
                    <div className="font-mono">{ts ? new Date(ts).toLocaleString() : '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-16">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>Failed to load system health</p>
        </div>
      )}
    </div>
  );
};

export default SystemHealthPage;

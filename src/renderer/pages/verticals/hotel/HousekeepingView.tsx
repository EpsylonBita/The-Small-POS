import React, { memo, useMemo, useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Clock, User, Filter, RefreshCw, WifiOff, Sparkles } from 'lucide-react';
import { useTheme } from '../../../contexts/theme-context';
import { useSystemClock } from '../../../hooks/useSystemClock';
import { getBridge, isBrowser } from '../../../../lib';
import { posApiGet, posApiPatch, posApiPost } from '../../../utils/api-helpers';
import {
  offlineAssignHousekeepingStaff,
  offlineUpdateHousekeepingStatus,
} from '../../../services/offline-mutations';
import { toLocalDateString } from '../../../utils/date';
import { offEvent, onEvent } from '../../../../lib';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';
import { useRooms } from '../../../hooks/useRooms';
import { useResolvedPosIdentity } from '../../../hooks/useResolvedPosIdentity';
import {
  applyHousekeepingStatusOverrides,
  applyStatusTransition,
  buildHousekeepingFallbackTasks,
  isFallbackTaskId,
  toHousekeepingStatusOverride,
  type HousekeepingStatusOverride,
  type HousekeepingTask,
  type Priority,
  type TaskStatus,
} from './housekeeping-fallback';

interface StaffMember {
  id: string;
  name: string;
}

const HOUSEKEEPING_REFRESH_MIN_MS = 30000;

// Safe, readable label for unknown/custom task types when no locale key exists
// (e.g. "deep_clean" -> "Deep Clean"). Display only; the raw value is preserved
// for filtering and API data.
const humanizeTaskType = (type: string): string =>
  type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()).trim();

export const HousekeepingView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const now = useSystemClock();
  const isDark = resolvedTheme === 'dark';
  const today = toLocalDateString(now);
  const bridge = getBridge();
  const lightGlassSurface = 'bg-white/72 border-zinc-300/80 shadow-[0_12px_30px_rgba(15,23,42,0.10)]';
  const lightControlSurface = 'bg-white/90 text-gray-950 border-zinc-300 shadow-sm shadow-black/5';

  // Resolve identity + current rooms so rooms sitting in `cleaning` status surface
  // as visible fallback rows even before a housekeeping_tasks row exists for them.
  const { branchId, organizationId } = useResolvedPosIdentity('branch+organization');
  const { rooms } = useRooms({
    branchId: branchId || '',
    organizationId: organizationId || '',
    enableRealtime: true,
  });

  const [tasks, setTasks] = useState<HousekeepingTask[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);

  const [floorFilter, setFloorFilter] = useState<string>('all');
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [staffFilter, setStaffFilter] = useState<string>('all');

  // Pending optimistic status transitions keyed by real task id. While the offline
  // mutation carrying the same change is still syncing, the admin API keeps returning the
  // stale (pre-change) row; these overrides are re-applied on every fetch so a refresh
  // never regresses a staff-visible in_progress/completed/verified transition. Each entry
  // is dropped once a fetch shows the server has caught up (status rank >= override).
  const statusOverridesRef = useRef<Map<string, HousekeepingStatusOverride>>(new Map());
  // Mirror of the latest tasks so handlers can read the current row without a stale
  // closure or re-running their useCallback on every tasks change.
  const tasksRef = useRef<HousekeepingTask[]>([]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const priorityColors: Record<Priority, { bg: string; text: string }> = {
    urgent: { bg: '#7f1d1d', text: '#fecaca' },
    high: { bg: '#7c2d12', text: '#fed7aa' },
    normal: { bg: '#78350f', text: '#fde68a' },
    low: { bg: '#14532d', text: '#bbf7d0' },
  };

  const columns: Array<{ status: TaskStatus; label: string }> = [
    { status: 'pending', label: t('housekeepingView.status.pending', { defaultValue: 'Pending' }) },
    { status: 'in_progress', label: t('housekeepingView.status.inProgress', { defaultValue: 'In Progress' }) },
    { status: 'completed', label: t('housekeepingView.status.completed', { defaultValue: 'Completed' }) },
    { status: 'verified', label: t('housekeepingView.status.verified', { defaultValue: 'Verified' }) },
  ];

  // Localized, display-only label for a task type. Known types resolve through
  // i18n; unknown/custom types fall back to a humanized version of the raw value.
  const resolveTaskTypeLabel = useCallback(
    (type: string): string =>
      t(`housekeepingView.taskType.${type}`, { defaultValue: humanizeTaskType(type) }),
    [t],
  );

  const fetchStaff = useCallback(async () => {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const response = isBrowser()
      ? await posApiGet<{
          success: boolean;
          staff?: Array<{ id: string; name: string; firstName?: string; lastName?: string }>;
        }>(
          `/api/pos/staff-schedule?start_date=${encodeURIComponent(weekStart.toISOString())}&end_date=${encodeURIComponent(weekEnd.toISOString())}`
        )
      : await bridge.staffSchedule.list({
          start_date: weekStart.toISOString(),
          end_date: weekEnd.toISOString(),
        }) as {
          success: boolean;
          data?: {
            success?: boolean;
            staff?: Array<{ id: string; name: string; firstName?: string; lastName?: string }>;
          };
        };

    const payload = response.data ?? {};
    if (!response.success || (typeof payload.success === 'boolean' && payload.success === false)) {
      return;
    }

    const loadedStaff = (payload.staff || []).map((member) => ({
      id: member.id,
      name: member.name || `${member.firstName || ''} ${member.lastName || ''}`.trim() || 'Staff',
    }));
    setStaff(loadedStaff);
  }, []);

  const fetchTasks = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent || false;
    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    // Fetch one housekeeping endpoint and normalize the browser/desktop envelopes.
    const requestHousekeeping = async (pathSuffix: string) => {
      const path = `/api/pos/housekeeping${pathSuffix}`;
      const response = isBrowser()
        ? await posApiGet<{ success: boolean; tasks?: HousekeepingTask[]; error?: string }>(path)
        : (await bridge.adminApi.fetchFromAdmin(path, { method: 'GET' })) as {
            success: boolean;
            data?: { success?: boolean; tasks?: HousekeepingTask[]; error?: string };
            error?: string;
          };
      const ok = Boolean(response.success) && Boolean(response.data?.success);
      return {
        ok,
        tasks: ok ? response.data?.tasks || [] : [],
        error: response.error || response.data?.error,
      };
    };

    // Prefer ?status=all so a FIXED admin API returns every status (incl.
    // completed/verified). An OLD admin API matches status literally and returns
    // zero rows for "all"; when the all-status fetch succeeds but is empty, retry
    // the no-status endpoint, which returns active pending/in_progress tasks
    // (including a freshly created one) so fallback rows dedupe away and the real
    // assign/start controls appear. This keeps create-task promotion working
    // against both fixed and old runtime admin APIs.
    let result = await requestHousekeeping('?status=all');
    if (result.ok && result.tasks.length === 0) {
      const activeOnly = await requestHousekeeping('');
      if (activeOnly.ok && activeOnly.tasks.length > 0) {
        result = activeOnly;
      }
    }

    if (!result.ok) {
      const errorMessage = result.error || t('housekeepingView.toasts.loadFailed', { defaultValue: 'Failed to load housekeeping tasks' });
      if (!silent) {
        setError(errorMessage);
      }
      if (!silent) {
        toast.error(errorMessage);
      }
      setIsLoading(false);
      return;
    }

    // Re-apply any pending optimistic status transitions so this fetch cannot regress a
    // local in_progress/completed/verified change with stale admin data while sync is
    // pending/failing. Overrides the server has caught up to are dropped.
    const { tasks: mergedTasks, resolved } = applyHousekeepingStatusOverrides(
      result.tasks,
      statusOverridesRef.current,
      tasksRef.current,
    );
    for (const id of resolved) {
      statusOverridesRef.current.delete(id);
    }
    setTasks(mergedTasks);
    if (!silent) {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    const bootstrap = async () => {
      await Promise.all([fetchTasks(), fetchStaff()]);
      if (disposed) return;
      setIsLoading(false);
    };

    bootstrap();

    return () => {
      disposed = true;
    };
  }, [fetchTasks, fetchStaff]);

  useEffect(() => {
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastRefreshAt = Date.now();
        void fetchTasks({ silent: true });
      }, delayMs);
    };

    const handleSyncStatus = (status?: { inProgress?: boolean }) => {
      if (status?.inProgress) return;
      const now = Date.now();
      if (now - lastRefreshAt < HOUSEKEEPING_REFRESH_MIN_MS) {
        return;
      }
      scheduleRefresh(300);
    };

    const handleSyncComplete = () => {
      scheduleRefresh(150);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
    };
  }, [fetchTasks]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([fetchTasks({ silent: true }), fetchStaff()]);
    setIsRefreshing(false);
  }, [fetchTasks, fetchStaff]);

  const handleStatusChange = useCallback(async (taskId: string, status: TaskStatus) => {
    // Fallback rows have no backing housekeeping_tasks record; never send their
    // synthetic id to the task update API.
    if (isFallbackTaskId(taskId)) return;
    setUpdatingTaskId(taskId);
    try {
      if (isBrowser()) {
        const response = await posApiPatch<{ success: boolean; error?: string }>(
          '/api/pos/housekeeping',
          { task_id: taskId, status }
        );
        if (!response.success || response.data?.success === false) {
          throw new Error(response.error || response.data?.error || t('housekeepingView.toasts.updateFailed', { defaultValue: 'Failed to update task' }));
        }
      } else {
        await offlineUpdateHousekeepingStatus({ taskId, status });
      }

      const now = new Date().toISOString();
      const priorTask = tasksRef.current.find((task) => task.id === taskId);
      // Mirror the server's status-to-timestamp semantics locally so timestamp-driven
      // KPIs (Completed Today, average completion time) and the card timeline stay
      // consistent immediately after the status changes, not only after a later refetch.
      const nextTask = priorTask ? applyStatusTransition(priorTask, status, now) : null;
      // Record the optimistic transition so a refetch while the offline mutation is still
      // syncing cannot regress it back to the stale admin status.
      if (nextTask) {
        statusOverridesRef.current.set(taskId, toHousekeepingStatusOverride(nextTask));
      }

      setTasks((prev) =>
        prev.map((task) =>
          task.id === taskId ? (nextTask ?? applyStatusTransition(task, status, now)) : task
        )
      );
      setUpdatingTaskId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('housekeepingView.toasts.updateFailed', { defaultValue: 'Failed to update task' }));
      setUpdatingTaskId(null);
    }
  }, []);

  const handleAssignStaff = useCallback(async (taskId: string, staffId: string | null) => {
    // Fallback rows are not real tasks; never assign staff against a synthetic id.
    if (isFallbackTaskId(taskId)) return;
    setUpdatingTaskId(taskId);
    try {
      if (isBrowser()) {
        const response = await posApiPatch<{ success: boolean; error?: string }>(
          `/api/pos/housekeeping/${taskId}`,
          { assigned_staff_id: staffId }
        );

        if (!response.success || response.data?.success === false) {
          throw new Error(response.error || response.data?.error || t('housekeepingView.toasts.assignFailed', { defaultValue: 'Failed to assign staff' }));
        }
      } else {
        await offlineAssignHousekeepingStaff({ taskId, assignedStaffId: staffId });
      }

      const staffName = staff.find((member) => member.id === staffId)?.name || null;
      setTasks((prev) =>
        prev.map((task) =>
          task.id === taskId ? { ...task, assigned_staff_id: staffId, assigned_staff_name: staffName } : task
        )
      );
      setUpdatingTaskId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('housekeepingView.toasts.assignFailed', { defaultValue: 'Failed to assign staff' }));
      setUpdatingTaskId(null);
    }
  }, [staff]);

  // Promote a synthetic fallback row (a room in cleaning status with no backing
  // housekeeping_tasks record) into a real task via POST /api/pos/housekeeping. We
  // never PATCH/assign with the synthetic id; we create a genuine task, then reload
  // so the fallback row is replaced by the real task and normal controls appear.
  const handleCreateTask = useCallback(async (task: HousekeepingTask) => {
    if (!isFallbackTaskId(task.id) || !task.room_id) return;
    setUpdatingTaskId(task.id);
    try {
      // The fallback carries task_type 'cleaning'; the create API expects a concrete
      // enum, and a room in cleaning status is a post-checkout clean by default.
      const body = {
        room_id: task.room_id,
        task_type: 'checkout_clean',
        priority: task.priority,
      };
      const response = isBrowser()
        ? await posApiPost<{ success: boolean; error?: string }>('/api/pos/housekeeping', body)
        : (await bridge.adminApi.fetchFromAdmin('/api/pos/housekeeping', {
            method: 'POST',
            body: JSON.stringify(body),
          })) as { success: boolean; data?: { success?: boolean; error?: string }; error?: string };

      if (!response.success || response.data?.success === false) {
        throw new Error(
          response.error ||
            response.data?.error ||
            t('housekeepingView.toasts.createFailed', { defaultValue: 'Failed to create task' }),
        );
      }

      toast.success(t('housekeepingView.toasts.createSuccess', { defaultValue: 'Housekeeping task created' }));
      // Reload real tasks: the new task now covers this room, so the fallback row is
      // dropped by buildHousekeepingFallbackTasks and the real card (with
      // assign/start/complete controls) takes its place.
      await fetchTasks({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('housekeepingView.toasts.createFailed', { defaultValue: 'Failed to create task' }));
    } finally {
      setUpdatingTaskId(null);
    }
  }, [fetchTasks]);

  // Synthetic, read-only rows for cleaning rooms that have no real task yet.
  const fallbackTasks = useMemo(
    () => buildHousekeepingFallbackTasks(rooms, tasks),
    [rooms, tasks]
  );

  // Real API tasks first, then the cleaning-room fallback rows. All board stats
  // and filters operate on this combined list so cleaning rooms stay counted.
  const allTasks = useMemo(() => [...tasks, ...fallbackTasks], [tasks, fallbackTasks]);

  const floors = useMemo(
    () => [...new Set(allTasks.map((task) => String(task.floor ?? '')).filter(Boolean))].sort(),
    [allTasks]
  );
  const taskTypes = useMemo(
    () => [...new Set(allTasks.map((task) => task.task_type).filter(Boolean))].sort(),
    [allTasks]
  );

  const staffNames = useMemo(
    () => [...new Set(allTasks.map((task) => task.assigned_staff_name).filter(Boolean) as string[])].sort(),
    [allTasks]
  );

  const filteredTasks = useMemo(() => {
    return allTasks.filter((task) => {
      if (floorFilter !== 'all' && String(task.floor ?? '') !== floorFilter) return false;
      if (taskTypeFilter !== 'all' && task.task_type !== taskTypeFilter) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (staffFilter !== 'all' && (task.assigned_staff_name || 'unassigned') !== staffFilter) return false;
      return true;
    });
  }, [allTasks, floorFilter, taskTypeFilter, priorityFilter, staffFilter]);

  const completedToday = useMemo(() => {
    return allTasks.filter((task) => toLocalDateString(task.completed_at || '') === today).length;
  }, [allTasks, today]);

  const avgCompletionTime = useMemo(() => {
    const completed = allTasks
      .map((task) => {
        if (!task.started_at || !task.completed_at) return null;
        const start = new Date(task.started_at).getTime();
        const end = new Date(task.completed_at).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return Math.round((end - start) / 60000);
      })
      .filter((duration): duration is number => duration !== null);
    if (!completed.length) return 0;
    return Math.round(completed.reduce((sum, value) => sum + value, 0) / completed.length);
  }, [allTasks]);

  if (isLoading) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        {t('housekeepingView.loading', { defaultValue: 'Loading housekeeping tasks...' })}
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
        <WifiOff className="w-10 h-10 mb-3" />
        <p className="font-semibold mb-2">{t('housekeepingView.errorTitle', { defaultValue: 'Unable to load housekeeping tasks' })}</p>
        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
        <button
          type="button"
          onClick={() => fetchTasks()}
          className={`mt-4 px-4 py-2 rounded-xl border font-medium transition-transform active:scale-95 ${isDark ? 'border-amber-400/30 bg-amber-500/15 text-amber-200 active:bg-amber-500/25' : 'border-amber-400/40 bg-amber-50 text-amber-700 active:bg-amber-100'}`}
        >
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-4">
      <motion.section
        variants={pageMotionItem}
        data-vertical-hero="housekeeping"
        className={`mb-4 rounded-3xl border p-4 backdrop-blur-xl ${isDark ? 'bg-zinc-950/70 border-white/10 shadow-[0_18px_46px_rgba(0,0,0,0.35)]' : 'bg-white/74 border-yellow-200/80 shadow-[0_18px_44px_rgba(15,23,42,0.10)]'}`}
      >
        <div className="mb-4 min-w-0">
          <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('navigation.menu.housekeeping', { defaultValue: 'Housekeeping' })}
          </h1>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <motion.div variants={pageMotionContainer} className="flex gap-3 flex-wrap">
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-zinc-900/60 border-white/10' : lightGlassSurface}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-700'}`}>
                {t('housekeepingView.stats.totalTasks', { defaultValue: 'Total Tasks' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredTasks.length}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-zinc-900/60 border-white/10' : lightGlassSurface}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-700'}`}>
                {t('housekeepingView.stats.completedToday', { defaultValue: 'Completed Today' })}
              </div>
              <div className="text-xl font-bold text-emerald-500">{completedToday}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-zinc-900/60 border-white/10' : lightGlassSurface}`}>
              <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-700'}`}>
                {t('housekeepingView.stats.avgTime', { defaultValue: 'Avg Time' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{avgCompletionTime} {t('common.minutes', 'min')}</div>
            </motion.div>
          </motion.div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-transform active:scale-95 disabled:opacity-60 ${isDark ? 'border-amber-400/30 bg-amber-500/15 text-amber-300 active:bg-amber-500/25' : 'border-amber-400/40 bg-amber-50 text-amber-600 active:bg-amber-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.section>

      <motion.div variants={pageMotionItem} className="flex gap-2 mb-4 flex-wrap items-center">
        <Filter className={`w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
        <select
          value={floorFilter}
          onChange={(e) => setFloorFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-900/60 text-zinc-100 border-white/10' : lightControlSurface}`}
        >
          <option value="all">{t('housekeepingView.filter.allFloors', { defaultValue: 'All Floors' })}</option>
          {floors.map((floor) => (
            <option key={floor} value={floor}>
              {t('housekeepingView.filter.floor', { defaultValue: 'Floor' })} {floor}
            </option>
          ))}
        </select>
        <select
          value={taskTypeFilter}
          onChange={(e) => setTaskTypeFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-900/60 text-zinc-100 border-white/10' : lightControlSurface}`}
        >
          <option value="all">{t('housekeepingView.filter.allTypes', { defaultValue: 'All Types' })}</option>
          {taskTypes.map((type) => (
            <option key={type} value={type}>{resolveTaskTypeLabel(type)}</option>
          ))}
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-900/60 text-zinc-100 border-white/10' : lightControlSurface}`}
        >
          <option value="all">{t('housekeepingView.filter.allPriorities', { defaultValue: 'All Priorities' })}</option>
          <option value="urgent">{t('housekeepingView.priority.urgent', { defaultValue: 'Urgent' })}</option>
          <option value="high">{t('housekeepingView.priority.high', { defaultValue: 'High' })}</option>
          <option value="normal">{t('housekeepingView.priority.normal', { defaultValue: 'Normal' })}</option>
          <option value="low">{t('housekeepingView.priority.low', { defaultValue: 'Low' })}</option>
        </select>
        <select
          value={staffFilter}
          onChange={(e) => setStaffFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-900/60 text-zinc-100 border-white/10' : lightControlSurface}`}
        >
          <option value="all">{t('housekeepingView.filter.allStaff', { defaultValue: 'All Staff' })}</option>
          <option value="unassigned">{t('housekeepingView.filter.unassigned', { defaultValue: 'Unassigned' })}</option>
          {staffNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </motion.div>

      {filteredTasks.length === 0 ? (
        <motion.div
          variants={pageMotionItem}
          className="flex-1 flex items-center justify-center px-6"
        >
          <div className={`flex flex-col items-center justify-center text-center max-w-md rounded-3xl border px-8 py-10 backdrop-blur-md ${isDark ? 'bg-zinc-900/60 border-white/10' : lightGlassSurface}`}>
            <Sparkles className="w-12 h-12 mb-3 text-amber-400" />
            <p className={`text-lg font-semibold mb-1 ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
              {t('housekeepingView.empty.title', { defaultValue: 'No housekeeping tasks' })}
            </p>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-700'}`}>
              {t('housekeepingView.empty.description', { defaultValue: 'Housekeeping tasks appear here automatically when rooms are checked out or set to cleaning.' })}
            </p>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
              className={`mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl border font-medium transition-transform active:scale-95 disabled:opacity-60 ${isDark ? 'border-amber-400/30 bg-amber-500/15 text-amber-200 active:bg-amber-500/25' : 'border-amber-400/40 bg-amber-50 text-amber-700 active:bg-amber-100'}`}
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t('common.refresh', { defaultValue: 'Refresh' })}
            </button>
          </div>
        </motion.div>
      ) : (
      <motion.div variants={pageMotionContainer} className="flex-1 overflow-y-auto scrollbar-hide space-y-5 pb-4">
        {columns.map((column) => {
          const columnTasks = filteredTasks.filter((task) => task.status === column.status);
          if (columnTasks.length === 0) return null;
          return (
            <motion.section key={column.status} variants={pageMotionItem} data-housekeeping-section={column.status} className="space-y-3">
              <div className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-zinc-900/60 border-white/10' : lightGlassSurface}`}>
                <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{column.label}</span>
                <span className={`ml-auto px-2.5 py-0.5 rounded-full text-sm font-semibold ${isDark ? 'bg-white/10 text-zinc-100' : 'bg-zinc-200 text-zinc-800'}`}>
                  {columnTasks.length}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                {columnTasks.map((task) => {
                  const priorityColor = priorityColors[task.priority] || priorityColors.normal;
                  const isUpdating = updatingTaskId === task.id;
                  const availableStaff = staff.length > 0 ? staff : [];
                  return (
                    <motion.div key={task.id} variants={pageMotionItem} className={`p-3 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-zinc-900/50 border-white/10' : lightGlassSurface}`}>
                      <div className="flex items-center justify-between mb-2 gap-2">
                        <span className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {t('housekeepingView.room', { defaultValue: 'Room' })} {task.room_number || task.room_id || '-'}
                        </span>
                        <span
                          className="px-2 py-0.5 rounded text-xs"
                          style={{ backgroundColor: priorityColor.bg, color: priorityColor.text }}
                        >
                          {t(`housekeepingView.priority.${task.priority}`, { defaultValue: task.priority })}
                        </span>
                      </div>

                      <div className={`text-sm capitalize ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        {resolveTaskTypeLabel(task.task_type)}
                      </div>

                      <div className={`flex items-center gap-2 mt-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        <User className="w-3 h-3" />
                        <span>{task.assigned_staff_name || t('housekeepingView.unassigned', { defaultValue: 'Unassigned' })}</span>
                        <Clock className="w-3 h-3 ml-2" />
                        <span>{task.floor ? `${t('housekeepingView.filter.floor', { defaultValue: 'Floor' })} ${task.floor}` : '-'}</span>
                      </div>

                      {task.isFallback ? (
                        // Synthetic row derived from a room in cleaning status: it has
                        // no backing housekeeping_tasks record, so task-only controls
                        // (assign/start/complete/verify) are omitted to avoid hitting
                        // the task APIs with a synthetic id. A localized note explains.
                        <div className="mt-2 space-y-2">
                          <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            {t('housekeepingView.fallbackHint', {
                              defaultValue: 'Shown from a room in cleaning status. Actions become available once the housekeeping task is created.',
                            })}
                          </div>
                          <button
                            type="button"
                            disabled={isUpdating}
                            onClick={() => handleCreateTask(task)}
                            className={`w-full py-2 text-xs font-medium rounded-2xl border transition-transform active:scale-95 ${isDark ? 'border-amber-400/40 bg-amber-500/20 text-amber-200 active:bg-amber-500/30' : 'border-amber-500/60 bg-amber-100 text-amber-900 active:bg-amber-200'} disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:active:scale-100 disabled:cursor-not-allowed`}
                          >
                            {t('housekeepingView.action.createTask', { defaultValue: 'Create task' })}
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="mt-2">
                            <select
                              disabled={isUpdating}
                              value={task.assigned_staff_id || ''}
                              onChange={(e) => handleAssignStaff(task.id, e.target.value || null)}
                              className={`w-full px-2 py-2 rounded-2xl border text-xs ${isDark ? 'bg-zinc-950/60 text-zinc-100 border-white/10' : lightControlSurface}`}
                            >
                              <option value="">{t('housekeepingView.assign.none', { defaultValue: 'Unassigned' })}</option>
                              {availableStaff.map((member) => (
                                <option key={member.id} value={member.id}>{member.name}</option>
                              ))}
                            </select>
                          </div>

                          {column.status === 'pending' && (
                            <button
                              type="button"
                              disabled={isUpdating}
                              onClick={() => handleStatusChange(task.id, 'in_progress')}
                              className={`w-full mt-2 py-2 text-xs font-medium rounded-2xl border transition-transform active:scale-95 ${isDark ? 'border-amber-400/40 bg-amber-500/20 text-amber-200 active:bg-amber-500/30' : 'border-amber-500/60 bg-amber-100 text-amber-900 active:bg-amber-200'} disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:active:scale-100 disabled:cursor-not-allowed`}
                            >
                              {t('housekeepingView.action.start', { defaultValue: 'Start' })}
                            </button>
                          )}

                          {column.status === 'in_progress' && (
                            <button
                              type="button"
                              disabled={isUpdating}
                              onClick={() => handleStatusChange(task.id, 'completed')}
                              className={`w-full mt-2 py-2 text-xs font-medium rounded-2xl border transition-transform active:scale-95 ${isDark ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300 active:bg-emerald-500/30' : 'border-emerald-500/60 bg-emerald-100 text-emerald-900 active:bg-emerald-200'} disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:active:scale-100 disabled:cursor-not-allowed`}
                            >
                              {t('housekeepingView.action.complete', { defaultValue: 'Complete' })}
                            </button>
                          )}

                          {column.status === 'completed' && (
                            <button
                              type="button"
                              disabled={isUpdating}
                              onClick={() => handleStatusChange(task.id, 'verified')}
                              className={`w-full mt-2 py-2 text-xs font-medium rounded-2xl border transition-transform active:scale-95 ${isDark ? 'border-amber-400/40 bg-amber-500/20 text-amber-200 active:bg-amber-500/30' : 'border-amber-500/60 bg-amber-100 text-amber-900 active:bg-amber-200'} disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:active:scale-100 disabled:cursor-not-allowed`}
                            >
                              {t('housekeepingView.action.verify', { defaultValue: 'Verify' })}
                            </button>
                          )}
                        </>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </motion.section>
          );
        })}
      </motion.div>
      )}
    </motion.div>
  );
});

HousekeepingView.displayName = 'HousekeepingView';

export default HousekeepingView;

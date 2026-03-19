import React, { memo, useMemo, useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Clock, User, Filter, RefreshCw, WifiOff } from 'lucide-react';
import { useTheme } from '../../../contexts/theme-context';
import { useSystemClock } from '../../../hooks/useSystemClock';
import { posApiGet, posApiPatch } from '../../../utils/api-helpers';
import { toLocalDateString } from '../../../utils/date';
import { offEvent, onEvent } from '../../../../lib';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'verified' | 'cancelled';
type Priority = 'urgent' | 'high' | 'normal' | 'low';

interface HousekeepingTask {
  id: string;
  room_id: string | null;
  room_number: string | null;
  floor: number | null;
  room_type: string | null;
  task_type: string;
  status: TaskStatus;
  priority: Priority;
  assigned_staff_id: string | null;
  assigned_staff_name: string | null;
  checklist: Array<{ id: string; label: string; completed: boolean }> | null;
  notes: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StaffMember {
  id: string;
  name: string;
}

const HOUSEKEEPING_REFRESH_MIN_MS = 30000;

export const HousekeepingView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const now = useSystemClock();
  const isDark = resolvedTheme === 'dark';
  const today = toLocalDateString(now);

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

  const fetchStaff = useCallback(async () => {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const response = await posApiGet<{
      success: boolean;
      staff?: Array<{ id: string; name: string; firstName?: string; lastName?: string }>;
    }>(
      `/api/pos/staff-schedule?start_date=${encodeURIComponent(weekStart.toISOString())}&end_date=${encodeURIComponent(weekEnd.toISOString())}`
    );

    if (!response.success || !response.data?.success) {
      return;
    }

    const loadedStaff = (response.data.staff || []).map((member) => ({
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

    const response = await posApiGet<{
      success: boolean;
      tasks?: HousekeepingTask[];
      error?: string;
    }>('/api/pos/housekeeping?status=all');

    if (!response.success || !response.data?.success) {
      const errorMessage = response.error || response.data?.error || 'Failed to load housekeeping tasks';
      if (!silent) {
        setError(errorMessage);
      }
      if (!silent) {
        toast.error(errorMessage);
      }
      setIsLoading(false);
      return;
    }

    setTasks(response.data.tasks || []);
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
    setUpdatingTaskId(taskId);
    const response = await posApiPatch<{ success: boolean; error?: string }>(
      '/api/pos/housekeeping',
      { task_id: taskId, status }
    );
    if (!response.success || response.data?.success === false) {
      toast.error(response.error || response.data?.error || 'Failed to update task');
      setUpdatingTaskId(null);
      return;
    }

    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, status, updated_at: new Date().toISOString() } : task))
    );
    setUpdatingTaskId(null);
  }, []);

  const handleAssignStaff = useCallback(async (taskId: string, staffId: string | null) => {
    setUpdatingTaskId(taskId);
    const response = await posApiPatch<{ success: boolean; error?: string }>(
      `/api/pos/housekeeping/${taskId}`,
      { assigned_staff_id: staffId }
    );

    if (!response.success || response.data?.success === false) {
      toast.error(response.error || response.data?.error || 'Failed to assign staff');
      setUpdatingTaskId(null);
      return;
    }

    const staffName = staff.find((member) => member.id === staffId)?.name || null;
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, assigned_staff_id: staffId, assigned_staff_name: staffName } : task
      )
    );
    setUpdatingTaskId(null);
  }, [staff]);

  const floors = useMemo(
    () => [...new Set(tasks.map((task) => String(task.floor ?? '')).filter(Boolean))].sort(),
    [tasks]
  );
  const taskTypes = useMemo(
    () => [...new Set(tasks.map((task) => task.task_type).filter(Boolean))].sort(),
    [tasks]
  );

  const staffNames = useMemo(
    () => [...new Set(tasks.map((task) => task.assigned_staff_name).filter(Boolean) as string[])].sort(),
    [tasks]
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (floorFilter !== 'all' && String(task.floor ?? '') !== floorFilter) return false;
      if (taskTypeFilter !== 'all' && task.task_type !== taskTypeFilter) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (staffFilter !== 'all' && (task.assigned_staff_name || 'unassigned') !== staffFilter) return false;
      return true;
    });
  }, [tasks, floorFilter, taskTypeFilter, priorityFilter, staffFilter]);

  const completedToday = useMemo(() => {
    return tasks.filter((task) => toLocalDateString(task.completed_at || '') === today).length;
  }, [tasks, today]);

  const avgCompletionTime = useMemo(() => {
    const completed = tasks
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
  }, [tasks]);

  if (isLoading) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        {t('housekeepingView.loading', { defaultValue: 'Loading housekeeping tasks...' })}
      </div>
    );
  }

  if (error) {
    return (
      <div className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
        <WifiOff className="w-10 h-10 mb-3" />
        <p className="font-semibold mb-2">{t('housekeepingView.errorTitle', { defaultValue: 'Unable to load housekeeping tasks' })}</p>
        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
        <button
          onClick={() => fetchTasks()}
          className="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
        >
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('housekeepingView.stats.totalTasks', { defaultValue: 'Total Tasks' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredTasks.length}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('housekeepingView.stats.completedToday', { defaultValue: 'Completed Today' })}
            </div>
            <div className="text-xl font-bold text-green-500">{completedToday}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('housekeepingView.stats.avgTime', { defaultValue: 'Avg Time' })}
            </div>
            <div className="text-xl font-bold text-blue-500">{avgCompletionTime}min</div>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}
          disabled={isRefreshing}
          title={t('common.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Filter className={`w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
        <select
          value={floorFilter}
          onChange={(e) => setFloorFilter(e.target.value)}
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
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
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
        >
          <option value="all">{t('housekeepingView.filter.allTypes', { defaultValue: 'All Types' })}</option>
          {taskTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
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
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
        >
          <option value="all">{t('housekeepingView.filter.allStaff', { defaultValue: 'All Staff' })}</option>
          <option value="unassigned">{t('housekeepingView.filter.unassigned', { defaultValue: 'Unassigned' })}</option>
          {staffNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 grid grid-cols-2 xl:grid-cols-4 gap-4 overflow-hidden">
        {columns.map((column) => {
          const columnTasks = filteredTasks.filter((task) => task.status === column.status);
          return (
            <div key={column.status} className="flex flex-col min-h-0">
              <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{column.label}</span>
                <span className={`ml-auto px-2 py-0.5 rounded-full text-sm ${isDark ? 'bg-gray-700 text-gray-100' : 'bg-gray-100 text-gray-800'}`}>
                  {columnTasks.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {columnTasks.map((task) => {
                  const priorityColor = priorityColors[task.priority] || priorityColors.normal;
                  const isUpdating = updatingTaskId === task.id;
                  const availableStaff = staff.length > 0 ? staff : [];
                  return (
                    <div key={task.id} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white shadow-sm'}`}>
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

                      <div className={`text-sm capitalize ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                        {task.task_type}
                      </div>

                      <div className={`flex items-center gap-2 mt-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        <User className="w-3 h-3" />
                        <span>{task.assigned_staff_name || t('housekeepingView.unassigned', { defaultValue: 'Unassigned' })}</span>
                        <Clock className="w-3 h-3 ml-2" />
                        <span>{task.floor ? `${t('housekeepingView.filter.floor', { defaultValue: 'Floor' })} ${task.floor}` : '-'}</span>
                      </div>

                      <div className="mt-2">
                        <select
                          disabled={isUpdating}
                          value={task.assigned_staff_id || ''}
                          onChange={(e) => handleAssignStaff(task.id, e.target.value || null)}
                          className={`w-full px-2 py-1.5 rounded-lg text-xs ${isDark ? 'bg-gray-900 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
                        >
                          <option value="">{t('housekeepingView.assign.none', { defaultValue: 'Unassigned' })}</option>
                          {availableStaff.map((member) => (
                            <option key={member.id} value={member.id}>{member.name}</option>
                          ))}
                        </select>
                      </div>

                      {column.status === 'pending' && (
                        <button
                          disabled={isUpdating}
                          onClick={() => handleStatusChange(task.id, 'in_progress')}
                          className="w-full mt-2 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                        >
                          {t('housekeepingView.action.start', { defaultValue: 'Start' })}
                        </button>
                      )}

                      {column.status === 'in_progress' && (
                        <button
                          disabled={isUpdating}
                          onClick={() => handleStatusChange(task.id, 'completed')}
                          className="w-full mt-2 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                        >
                          {t('housekeepingView.action.complete', { defaultValue: 'Complete' })}
                        </button>
                      )}

                      {column.status === 'completed' && (
                        <button
                          disabled={isUpdating}
                          onClick={() => handleStatusChange(task.id, 'verified')}
                          className="w-full mt-2 py-1.5 text-xs rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-60"
                        >
                          {t('housekeepingView.action.verify', { defaultValue: 'Verify' })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

HousekeepingView.displayName = 'HousekeepingView';

export default HousekeepingView;

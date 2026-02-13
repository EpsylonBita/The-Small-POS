import React, { memo, useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import {
  AlertCircle,
  Briefcase,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  RefreshCw,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { posApiGet, posApiPost } from '../../../utils/api-helpers';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';

interface StaffMember {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  department: string;
  role: {
    id: string;
    name: string;
    displayName: string;
    color: string;
    level: number;
  } | null;
}

interface ScheduleShift {
  id: string;
  staffId?: string;
  staff_id?: string;
  staffName?: string;
  staff_name?: string;
  startTime?: string;
  start_time?: string;
  scheduled_start?: string;
  check_in_time?: string;
  endTime?: string;
  end_time?: string;
  scheduled_end?: string;
  check_out_time?: string;
  status?: string;
  role_type?: string;
  notes?: string;
}

interface ApiResponse {
  success: boolean;
  staff: StaffMember[];
  shifts: ScheduleShift[];
  totalCount: number;
  error?: string;
}

interface WeeklyShift {
  id: string;
  staffId: string;
  staffName: string;
  roleName: string;
  roleLabel: string;
  roleColor: string;
  start: Date;
  end: Date | null;
  status: string;
}

const ROLE_COLORS: Record<string, string> = {
  admin: '#DC2626',
  manager: '#F59E0B',
  supervisor: '#10B981',
  staff: '#3B82F6',
  stylist: '#06B6D4',
  colorist: '#0EA5E9',
  nail_tech: '#F97316',
  receptionist: '#14B8A6',
  cashier: '#3B82F6',
  driver: '#0EA5E9',
  kitchen: '#10B981',
  server: '#14B8A6',
  customer: '#6B7280',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (v: number): string => String(v).padStart(2, '0');

const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const toDateInputValue = (date: Date): string => localDateKey(date);

const toIsoFromDateAndTimeParts = (dateValue: string, hourValue: string, minuteValue: string): string | null => {
  if (!dateValue || hourValue === '' || minuteValue === '') {
    return null;
  }
  const iso = new Date(`${dateValue}T${hourValue}:${minuteValue}:00`);
  if (Number.isNaN(iso.getTime())) {
    return null;
  }
  return iso.toISOString();
};

const parseDate = (value?: string | null): Date | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const startOfWeekMonday = (date: Date): Date => {
  const local = new Date(date);
  local.setHours(0, 0, 0, 0);
  const weekday = local.getDay();
  const diff = (weekday + 6) % 7;
  local.setDate(local.getDate() - diff);
  return local;
};

const formatTimeRange = (start: Date, end: Date | null): string => {
  const startLabel = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!end) {
    return `${startLabel} - ?`;
  }
  const endLabel = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${startLabel} - ${endLabel}`;
};

const getRoleColor = (roleName: string | undefined): string => {
  if (!roleName) {
    return ROLE_COLORS.staff;
  }
  return ROLE_COLORS[roleName] || ROLE_COLORS.staff;
};

const getShiftStart = (shift: ScheduleShift): Date | null =>
  parseDate(shift.startTime || shift.start_time || shift.scheduled_start || shift.check_in_time);

const getShiftEnd = (shift: ScheduleShift): Date | null =>
  parseDate(shift.endTime || shift.end_time || shift.scheduled_end || shift.check_out_time);

const statusLabel = (status?: string): string => {
  if (!status) {
    return 'scheduled';
  }
  return status.replace(/_/g, ' ');
};

const HOURS = Array.from({ length: 24 }, (_, index) => pad(index));
const MINUTES = ['00', '15', '30', '45'];

export const StaffScheduleView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<ScheduleShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalDate, setCreateModalDate] = useState<Date | null>(null);
  const [createStaffId, setCreateStaffId] = useState('');
  const [createStartDate, setCreateStartDate] = useState('');
  const [createStartHour, setCreateStartHour] = useState('09');
  const [createStartMinute, setCreateStartMinute] = useState('00');
  const [createEndDate, setCreateEndDate] = useState('');
  const [createEndHour, setCreateEndHour] = useState('17');
  const [createEndMinute, setCreateEndMinute] = useState('00');
  const [createNotes, setCreateNotes] = useState('');
  const [creatingShift, setCreatingShift] = useState(false);

  const isDark = resolvedTheme === 'dark';
  const branchId = getSetting<string>('terminal', 'branch_id', '');

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + i);
      return date;
    });
  }, [currentWeekStart]);

  const weekDateSet = useMemo(() => new Set(weekDays.map(localDateKey)), [weekDays]);

  const fetchStaffData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const weekEnd = new Date(currentWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);

      const params = new URLSearchParams({
        start_date: currentWeekStart.toISOString(),
        end_date: weekEnd.toISOString(),
      });

      if (branchId) {
        params.append('branch_id', branchId);
      }
      if (roleFilter !== 'all') {
        params.append('role', roleFilter);
      }

      const response = await posApiGet<ApiResponse>(`/pos/staff-schedule?${params.toString()}`);

      if (response.success && response.data?.staff) {
        setStaff(response.data.staff);
        setShifts(Array.isArray(response.data.shifts) ? response.data.shifts : []);
      } else {
        setError(response.error || response.data?.error || 'Failed to fetch staff data');
      }
    } catch (err: any) {
      console.error('[StaffScheduleView] Fetch error:', err);
      setError(err.message || 'Failed to load staff schedule');
    } finally {
      setLoading(false);
    }
  }, [branchId, currentWeekStart, roleFilter]);

  useEffect(() => {
    fetchStaffData();
  }, [fetchStaffData]);

  const staffMap = useMemo(() => {
    const map = new Map<string, StaffMember>();
    for (const person of staff) {
      map.set(person.id, person);
    }
    return map;
  }, [staff]);

  const availableRoles = useMemo(() => {
    const roles = new Set<string>();
    staff.forEach(member => {
      if (member.role?.name) {
        roles.add(member.role.name);
      }
    });
    return Array.from(roles);
  }, [staff]);

  const filteredStaff = useMemo(() => {
    if (roleFilter === 'all') {
      return staff;
    }
    return staff.filter(member => member.role?.name === roleFilter);
  }, [staff, roleFilter]);

  const weeklyShifts = useMemo<WeeklyShift[]>(() => {
    const normalized: WeeklyShift[] = [];

    for (const shift of shifts) {
      const staffId = shift.staffId || shift.staff_id;
      if (!staffId) {
        continue;
      }

      const start = getShiftStart(shift);
      if (!start) {
        continue;
      }

      if (!weekDateSet.has(localDateKey(start))) {
        continue;
      }

      const staffMember = staffMap.get(staffId);
      const roleName = staffMember?.role?.name || shift.role_type || 'staff';

      if (roleFilter !== 'all' && roleName !== roleFilter) {
        continue;
      }

      normalized.push({
        id: shift.id,
        staffId,
        staffName: staffMember?.name || shift.staffName || shift.staff_name || 'Unknown staff',
        roleName,
        roleLabel: staffMember?.role?.displayName || roleName.replace(/_/g, ' '),
        roleColor: getRoleColor(roleName),
        start,
        end: getShiftEnd(shift),
        status: statusLabel(shift.status),
      });
    }

    normalized.sort((a, b) => a.start.getTime() - b.start.getTime());
    return normalized;
  }, [roleFilter, shifts, staffMap, weekDateSet]);

  const shiftsByDay = useMemo(() => {
    const grouped: Record<string, WeeklyShift[]> = {};

    for (const day of weekDays) {
      grouped[localDateKey(day)] = [];
    }

    for (const shift of weeklyShifts) {
      const key = localDateKey(shift.start);
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(shift);
    }

    return grouped;
  }, [weekDays, weeklyShifts]);

  const weekLabel = useMemo(() => {
    const startLabel = currentWeekStart.toLocaleDateString([], { day: 'numeric', month: 'short' });
    const endDate = weekDays[6] || currentWeekStart;
    const endLabel = endDate.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return `${startLabel} - ${endLabel}`;
  }, [currentWeekStart, weekDays]);

  const todayKey = localDateKey(new Date());
  const todayShiftsCount = (shiftsByDay[todayKey] || []).length;
  const scheduledStaffCount = useMemo(() => new Set(weeklyShifts.map(shift => shift.staffId)).size, [weeklyShifts]);
  const scheduledStaffSet = useMemo(() => new Set(weeklyShifts.map(shift => shift.staffId)), [weeklyShifts]);
  const unscheduledStaff = useMemo(() => filteredStaff.filter(member => !scheduledStaffSet.has(member.id)), [filteredStaff, scheduledStaffSet]);

  const navigateWeek = (direction: 'prev' | 'next') => {
    setCurrentWeekStart(prev => {
      const nextWeek = new Date(prev);
      nextWeek.setDate(nextWeek.getDate() + (direction === 'next' ? 7 : -7));
      return nextWeek;
    });
  };

  const openCreateModal = (day: Date) => {
    setCreateModalDate(new Date(day));
    setCreateStaffId('');
    const dayValue = toDateInputValue(day);
    setCreateStartDate(dayValue);
    setCreateEndDate(dayValue);
    setCreateStartHour('09');
    setCreateStartMinute('00');
    setCreateEndHour('17');
    setCreateEndMinute('00');
    setCreateNotes('');
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (creatingShift) {
      return;
    }
    setCreateModalOpen(false);
    setCreateModalDate(null);
  };

  const handleCreateShift = async () => {
    if (!createModalDate) {
      return;
    }
    if (!createStaffId) {
      toast.error(t('staffSchedule.validation.selectStaff', 'Please select a staff member'));
      return;
    }

    if (!createStartDate || !createEndDate) {
      toast.error(t('staffSchedule.validation.selectDateTime', 'Please select start and end date/time'));
      return;
    }

    const startIso = toIsoFromDateAndTimeParts(createStartDate, createStartHour, createStartMinute);
    const endIso = toIsoFromDateAndTimeParts(createEndDate, createEndHour, createEndMinute);

    if (!startIso || !endIso) {
      toast.error(t('staffSchedule.validation.selectDateTime', 'Please select start and end date/time'));
      return;
    }

    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      toast.error(t('staffSchedule.validation.endAfterStart', 'End time must be after start time'));
      return;
    }

    try {
      setCreatingShift(true);
      const response = await posApiPost<{ success?: boolean; error?: string }>('/pos/staff-schedule', {
        staff_id: createStaffId,
        start_time: startIso,
        end_time: endIso,
        notes: createNotes.trim() || null,
        status: 'scheduled',
      });

      const failed = !response.success || response.data?.success === false;
      if (failed) {
        throw new Error(response.error || response.data?.error || 'Failed to create shift');
      }

      toast.success(t('staffSchedule.shiftCreated', 'Shift created'));
      setCreateModalOpen(false);
      setCreateModalDate(null);
      await fetchStaffData();
    } catch (err: any) {
      console.error('[StaffScheduleView] Create shift error:', err);
      toast.error(err?.message || t('staffSchedule.shiftCreateFailed', 'Failed to create shift'));
    } finally {
      setCreatingShift(false);
    }
  };

  const shiftPreview = useMemo(() => {
    const startIso = toIsoFromDateAndTimeParts(createStartDate, createStartHour, createStartMinute);
    const endIso = toIsoFromDateAndTimeParts(createEndDate, createEndHour, createEndMinute);
    if (!startIso || !endIso) {
      return { valid: false, message: t('staffSchedule.validation.selectDateTime', 'Please select start and end date/time') };
    }
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (end.getTime() <= start.getTime()) {
      return { valid: false, message: t('staffSchedule.validation.endAfterStart', 'End time must be after start time') };
    }
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    const durationLabel = minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
    return {
      valid: true,
      message: `${start.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -> ${end.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${durationLabel})`,
    };
  }, [createStartDate, createStartHour, createStartMinute, createEndDate, createEndHour, createEndMinute, t]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className={isDark ? 'text-zinc-400' : 'text-gray-600'}>
            {t('staffSchedule.loading', 'Loading staff schedule...')}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className={`w-full max-w-xl flex flex-col items-center gap-4 p-6 rounded-2xl border ${
          isDark ? 'bg-red-950/20 border-red-900/40' : 'bg-red-50 border-red-200'
        }`}>
          <AlertCircle className="w-10 h-10 text-red-500" />
          <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>{error}</p>
          <button
            onClick={fetchStaffData}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col p-6 gap-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      <div className={`rounded-2xl border p-5 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200 shadow-sm'}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('staffSchedule.weeklyProgram', 'Weekly Staff Program')}
            </h2>
            <p className={`text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('staffSchedule.weeklyProgramHint', 'See who is working each day and at what time')}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateWeek('prev')}
              className={`p-2 rounded-lg border transition-colors ${
                isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-gray-100 border-gray-300 hover:bg-gray-200'
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className={`min-w-[170px] px-4 py-2 rounded-lg text-center font-semibold border ${
              isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'
            }`}>
              <span className="inline-flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-500" />
                {weekLabel}
              </span>
            </div>
            <button
              onClick={() => navigateWeek('next')}
              className={`p-2 rounded-lg border transition-colors ${
                isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-gray-100 border-gray-300 hover:bg-gray-200'
              }`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={fetchStaffData}
              className={`ml-1 px-3 py-2 rounded-lg border inline-flex items-center gap-2 transition-colors ${
                isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-200' : 'bg-white border-gray-300 hover:bg-gray-100 text-gray-700'
              }`}
            >
              <RefreshCw className="w-4 h-4" />
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <div className={`rounded-xl p-3 border ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-blue-50 border-blue-100'}`}>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-blue-700'}`}>{t('staffSchedule.stats.totalStaff', 'Total Staff')}</p>
            <p className="text-xl font-bold mt-1 inline-flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-500" />
              {filteredStaff.length}
            </p>
          </div>
          <div className={`rounded-xl p-3 border ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-emerald-50 border-emerald-100'}`}>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-emerald-700'}`}>{t('staffSchedule.stats.scheduledThisWeek', 'Scheduled This Week')}</p>
            <p className="text-xl font-bold mt-1 inline-flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-emerald-500" />
              {scheduledStaffCount}
            </p>
          </div>
          <div className={`rounded-xl p-3 border ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-amber-50 border-amber-100'}`}>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-amber-700'}`}>{t('staffSchedule.stats.todayShifts', 'Today Shifts')}</p>
            <p className="text-xl font-bold mt-1 inline-flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-500" />
              {todayShiftsCount}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={() => setRoleFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              roleFilter === 'all'
                ? 'bg-blue-600 border-blue-500 text-white'
                : isDark
                  ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('common.all', 'All')}
          </button>
          {availableRoles.map(role => (
            <button
              key={role}
              onClick={() => setRoleFilter(role)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize border transition-colors ${
                roleFilter === role
                  ? 'text-white'
                  : isDark
                    ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
              }`}
              style={roleFilter === role ? { backgroundColor: getRoleColor(role), borderColor: getRoleColor(role) } : undefined}
            >
              {role.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex-1 min-h-0 rounded-2xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="h-full overflow-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3 p-4 min-w-[980px] xl:min-w-0">
            {weekDays.map(day => {
              const dayKey = localDateKey(day);
              const dayShifts = shiftsByDay[dayKey] || [];
              const today = dayKey === todayKey;

              return (
                <div
                  key={dayKey}
                  onClick={() => openCreateModal(day)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openCreateModal(day);
                    }
                  }}
                  className={`rounded-xl border min-h-[280px] flex flex-col ${
                    today
                      ? isDark
                        ? 'bg-zinc-900 border-blue-600 shadow-[0_0_0_1px_rgba(37,99,235,0.35)]'
                        : 'bg-blue-50/60 border-blue-300 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]'
                      : isDark
                        ? 'bg-zinc-900 border-zinc-800'
                        : 'bg-gray-50 border-gray-200'
                  }`}
                >
                  <div className={`px-3 py-3 border-b ${
                    today
                      ? isDark
                        ? 'border-blue-700 bg-blue-950/40'
                        : 'border-blue-200 bg-blue-50'
                      : isDark
                        ? 'border-zinc-800'
                        : 'border-gray-200'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{DAY_NAMES[day.getDay()]}</p>
                          {today && (
                            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
                              isDark ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40' : 'bg-blue-100 text-blue-700 border border-blue-200'
                            }`}>
                              {t('common.today', 'Today')}
                            </span>
                          )}
                        </div>
                        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                          {day.toLocaleDateString([], { day: '2-digit', month: 'short' })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs px-2 py-1 rounded-full ${
                          dayShifts.length > 0
                            ? isDark ? 'bg-emerald-900/50 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
                            : isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-gray-200 text-gray-600'
                        }`}>
                          {dayShifts.length}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openCreateModal(day);
                          }}
                          className={`p-1.5 rounded-md border transition-colors ${
                            isDark
                              ? 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-200'
                              : 'bg-white border-gray-300 hover:bg-gray-100 text-gray-700'
                          }`}
                          title={t('staffSchedule.addShiftForDay', 'Add shift for this day')}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 space-y-2">
                    {dayShifts.length === 0 ? (
                      <div className={`text-xs text-center py-8 rounded-lg border border-dashed ${
                        isDark ? 'text-zinc-500 border-zinc-700' : 'text-gray-500 border-gray-300'
                      }`}>
                        {t('staffSchedule.noShifts', 'No shifts')}
                      </div>
                    ) : (
                      dayShifts.map(shift => (
                        <div
                          key={shift.id}
                          onClick={event => event.stopPropagation()}
                          className={`rounded-lg px-3 py-2 border-l-4 border ${
                            isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'
                          }`}
                          style={{ borderLeftColor: shift.roleColor }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-sm font-semibold leading-tight ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
                              {shift.staffName}
                            </p>
                            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                              shift.status.includes('active')
                                ? isDark ? 'bg-emerald-900/50 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
                                : shift.status.includes('cancel')
                                  ? isDark ? 'bg-red-900/40 text-red-300' : 'bg-red-100 text-red-700'
                                  : isDark ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-100 text-blue-700'
                            }`}>
                              {shift.status}
                            </span>
                          </div>
                          <p className={`text-xs mt-1 capitalize ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                            <span className="inline-flex items-center gap-1">
                              <Briefcase className="w-3 h-3" />
                              {shift.roleLabel}
                            </span>
                          </p>
                          <p className={`text-xs mt-1 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatTimeRange(shift.start, shift.end)}
                            </span>
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {unscheduledStaff.length > 0 && (
        <div className={`rounded-2xl border p-4 ${
          isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'
        }`}>
          <p className={`text-sm font-semibold mb-2 ${isDark ? 'text-zinc-200' : 'text-gray-900'}`}>
            {t('staffSchedule.unscheduled', 'Not Scheduled This Week')} ({unscheduledStaff.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {unscheduledStaff.map(member => (
              <span
                key={member.id}
                className={`text-xs px-2.5 py-1 rounded-full border ${
                  isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-300' : 'bg-gray-100 border-gray-200 text-gray-700'
                }`}
              >
                {member.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {createModalOpen && createModalDate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/60"
            onClick={closeCreateModal}
          />
          <div className={`relative w-full max-w-2xl rounded-2xl border p-6 ${
            isDark ? 'bg-zinc-950 border-zinc-800 text-zinc-100' : 'bg-white border-gray-200 text-gray-900'
          }`}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-2xl font-semibold">{t('staffSchedule.addShift', 'Add Shift')}</h3>
                <p className={`text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                  {createModalDate.toLocaleDateString([], { weekday: 'long', day: '2-digit', month: 'short' })}
                </p>
              </div>
              <button
                type="button"
                onClick={closeCreateModal}
                className={`p-2.5 rounded-lg border ${
                  isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-gray-50 border-gray-300 hover:bg-gray-100'
                }`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('staffSchedule.fields.staff', 'Staff')}
                </span>
                <select
                  value={createStaffId}
                  onChange={e => setCreateStaffId(e.target.value)}
                  className={`mt-1 w-full px-3 py-3 rounded-xl border text-base ${
                    isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-300'
                  }`}
                >
                  <option value="">{t('staffSchedule.selectStaff', 'Select staff')}</option>
                  {filteredStaff.map(member => (
                    <option key={member.id} value={member.id}>
                      {member.name} ({member.role?.displayName || member.role?.name || 'Staff'})
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className={`rounded-xl border p-4 ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-sm font-medium mb-3 ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>
                    {t('staffSchedule.fields.startDateTime', 'Start (date & time)')}
                  </p>
                  <div className="space-y-3">
                    <input
                      type="date"
                      value={createStartDate}
                      onChange={e => setCreateStartDate(e.target.value)}
                      className={`w-full px-3 py-3 rounded-xl border text-base ${
                        isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                      }`}
                    />
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <select
                        value={createStartHour}
                        onChange={e => setCreateStartHour(e.target.value)}
                        className={`px-3 py-3 rounded-xl border text-base ${
                          isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                        }`}
                      >
                        {HOURS.map(hour => <option key={`start-hour-${hour}`} value={hour}>{hour}</option>)}
                      </select>
                      <span className={`text-xl font-bold ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>:</span>
                      <select
                        value={createStartMinute}
                        onChange={e => setCreateStartMinute(e.target.value)}
                        className={`px-3 py-3 rounded-xl border text-base ${
                          isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                        }`}
                      >
                        {MINUTES.map(minute => <option key={`start-minute-${minute}`} value={minute}>{minute}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                <div className={`rounded-xl border p-4 ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-sm font-medium mb-3 ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>
                    {t('staffSchedule.fields.endDateTime', 'End (date & time)')}
                  </p>
                  <div className="space-y-3">
                    <input
                      type="date"
                      value={createEndDate}
                      onChange={e => setCreateEndDate(e.target.value)}
                      className={`w-full px-3 py-3 rounded-xl border text-base ${
                        isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                      }`}
                    />
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <select
                        value={createEndHour}
                        onChange={e => setCreateEndHour(e.target.value)}
                        className={`px-3 py-3 rounded-xl border text-base ${
                          isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                        }`}
                      >
                        {HOURS.map(hour => <option key={`end-hour-${hour}`} value={hour}>{hour}</option>)}
                      </select>
                      <span className={`text-xl font-bold ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>:</span>
                      <select
                        value={createEndMinute}
                        onChange={e => setCreateEndMinute(e.target.value)}
                        className={`px-3 py-3 rounded-xl border text-base ${
                          isDark ? 'bg-zinc-950 border-zinc-700' : 'bg-white border-gray-300'
                        }`}
                      >
                        {MINUTES.map(minute => <option key={`end-minute-${minute}`} value={minute}>{minute}</option>)}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!createStartDate) return;
                        const endDay = new Date(`${createStartDate}T00:00:00`);
                        endDay.setDate(endDay.getDate() + 1);
                        setCreateEndDate(toDateInputValue(endDay));
                      }}
                      className={`w-full px-3 py-2 rounded-lg border text-sm ${
                        isDark ? 'bg-zinc-950 border-zinc-700 hover:bg-zinc-800 text-zinc-300' : 'bg-white border-gray-300 hover:bg-gray-100 text-gray-700'
                      }`}
                    >
                      {t('staffSchedule.nextDayShortcut', 'Set end date to next day')}
                    </button>
                  </div>
                </div>
              </div>

              <div className={`rounded-xl border px-3 py-2 ${
                shiftPreview.valid
                  ? isDark ? 'bg-emerald-950/30 border-emerald-900/50 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : isDark ? 'bg-amber-950/30 border-amber-900/50 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}>
                <p className="text-sm font-medium">{shiftPreview.valid ? t('staffSchedule.preview', 'Preview') : t('staffSchedule.validation', 'Validation')}</p>
                <p className="text-sm mt-0.5">{shiftPreview.message}</p>
              </div>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>
                {t('staffSchedule.overnightHint', 'For overnight shifts, choose the next day as end date.')}
              </p>

              <label className="block">
                <span className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('staffSchedule.fields.notes', 'Notes')}
                </span>
                <textarea
                  value={createNotes}
                  onChange={e => setCreateNotes(e.target.value)}
                  rows={3}
                  placeholder={t('staffSchedule.fields.notesPlaceholder', 'Optional notes...')}
                  className={`mt-1 w-full px-3 py-3 rounded-xl border text-base resize-none ${
                    isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-300'
                  }`}
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={closeCreateModal}
                disabled={creatingShift}
                className={`px-5 py-3 rounded-xl border text-base ${
                  isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-gray-100 border-gray-300 hover:bg-gray-200'
                }`}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={handleCreateShift}
                disabled={creatingShift}
                className={`px-5 py-3 rounded-xl text-base font-semibold text-white ${
                  creatingShift ? 'bg-blue-500/70' : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {creatingShift ? t('common.saving', 'Saving...') : t('staffSchedule.createProgram', 'Create Program')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

StaffScheduleView.displayName = 'StaffScheduleView';
export default StaffScheduleView;

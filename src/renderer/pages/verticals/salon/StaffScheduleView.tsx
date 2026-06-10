import React, { memo, useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import {
  AlertCircle,
  Briefcase,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Plus,
  RefreshCw,
  Upload,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getBridge, isBrowser } from '../../../../lib';
import { posApiGet, posApiPost } from '../../../utils/api-helpers';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';
import { offlineCreateStaffShift } from '../../../services/offline-mutations';
import {
  importStaffScheduleFile,
  STAFF_SCHEDULE_IMPORT_ACCEPT,
  type ImportedScheduleShift,
} from '../../../utils/staff-schedule-import';

interface StaffMember {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  staffCode?: string | null;
  staff_code?: string | null;
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
  breakStart?: string | null;
  break_start?: string | null;
  breakEnd?: string | null;
  break_end?: string | null;
  status?: string;
  role_type?: string;
  notes?: string;
}

interface ApiResponse {
  success: boolean;
  data?: {
    success?: boolean;
    staff?: StaffMember[];
    shifts?: ScheduleShift[];
    totalCount?: number;
    error?: string;
  };
  staff?: StaffMember[];
  shifts?: ScheduleShift[];
  totalCount?: number;
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

interface ImportRunningShift {
  staffId: string;
  startTime: string;
  endTime: string;
  status?: string;
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

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const SHIFT_STATUS_KEYS = new Set(['scheduled', 'active', 'completed', 'cancelled', 'no_show']);
const TIME_PRESETS = [
  { key: 'morning', startHour: '09', startMinute: '00', endHour: '17', endMinute: '00' },
  { key: 'evening', startHour: '12', startMinute: '00', endHour: '20', endMinute: '00' },
  { key: 'closing', startHour: '17', startMinute: '00', endHour: '23', endMinute: '00' },
];

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

const getShiftStartValue = (shift: ScheduleShift): string | undefined =>
  shift.startTime || shift.start_time || shift.scheduled_start || shift.check_in_time;

const getShiftEndValue = (shift: ScheduleShift): string | undefined =>
  shift.endTime || shift.end_time || shift.scheduled_end || shift.check_out_time;

const normalizeStatus = (status?: string): string => {
  const normalized = (status || 'scheduled').trim().toLowerCase().replace(/\s+/g, '_');
  return SHIFT_STATUS_KEYS.has(normalized) ? normalized : 'scheduled';
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
  const [publishingErgani, setPublishingErgani] = useState(false);
  const [erganiPublishStatus, setErganiPublishStatus] = useState<string | null>(null);
  const [importingSchedule, setImportingSchedule] = useState(false);
  const [previewWeekOpen, setPreviewWeekOpen] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  const isDark = resolvedTheme === 'dark';
  const bridge = getBridge();
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
      const response = isBrowser()
        ? await posApiGet<ApiResponse>(`/pos/staff-schedule?${params.toString()}`)
        : await bridge.staffSchedule.list({
            start_date: currentWeekStart.toISOString(),
            end_date: weekEnd.toISOString(),
            branch_id: branchId || undefined,
            role: roleFilter === 'all' ? undefined : roleFilter,
          }) as ApiResponse;
      const payload = ((response as any).data ?? response) as {
        staff?: StaffMember[];
        shifts?: ScheduleShift[];
        error?: string;
      };

      if (response.success && Array.isArray(payload.staff)) {
        setStaff(payload.staff);
        setShifts(Array.isArray(payload.shifts) ? payload.shifts : []);
      } else {
        setError(response.error || payload.error || t('staffSchedule.errors.loadFailed', 'Failed to fetch staff data'));
      }
    } catch (err: any) {
      console.error('[StaffScheduleView] Fetch error:', err);
      setError(err.message || t('staffSchedule.errors.loadFailed', 'Failed to load staff schedule'));
    } finally {
      setLoading(false);
    }
  }, [branchId, currentWeekStart, roleFilter, t]);

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

  const roleLabelByName = useMemo(() => {
    const labels = new Map<string, string>();
    staff.forEach(member => {
      if (member.role?.name) {
        labels.set(member.role.name, member.role.displayName || member.role.name.replace(/_/g, ' '));
      }
    });
    return labels;
  }, [staff]);

  const getRoleLabel = useCallback((roleName: string) => (
    roleLabelByName.get(roleName) || roleName.replace(/_/g, ' ')
  ), [roleLabelByName]);

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
        staffName: staffMember?.name || shift.staffName || shift.staff_name || t('staffSchedule.unknownStaff', 'Unknown staff'),
        roleName,
        roleLabel: staffMember?.role?.displayName || getRoleLabel(roleName),
        roleColor: getRoleColor(roleName),
        start,
        end: getShiftEnd(shift),
        status: normalizeStatus(shift.status),
      });
    }

    normalized.sort((a, b) => a.start.getTime() - b.start.getTime());
    return normalized;
  }, [getRoleLabel, roleFilter, shifts, staffMap, t, weekDateSet]);

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
  const weeklyPreviewRows = useMemo(() => {
    return filteredStaff
      .map(member => ({
        staff: member,
        shiftsByDay: Object.fromEntries(
          weekDays.map(day => [
            localDateKey(day),
            weeklyShifts.filter(shift => shift.staffId === member.id && localDateKey(shift.start) === localDateKey(day)),
          ]),
        ) as Record<string, WeeklyShift[]>,
      }))
      .filter(row => weekDays.some(day => row.shiftsByDay[localDateKey(day)]?.length > 0));
  }, [filteredStaff, weekDays, weeklyShifts]);
  const defaultCreateDate = useMemo(
    () => (weekDateSet.has(todayKey) ? new Date() : new Date(currentWeekStart)),
    [currentWeekStart, todayKey, weekDateSet],
  );
  const refreshScheduleLabel = t('staffSchedule.actions.refresh', 'Refresh schedule');

  const getDayLabel = useCallback((day: Date) => {
    const key = DAY_KEYS[day.getDay()];
    return t(`staffSchedule.days.short.${key}`, day.toLocaleDateString([], { weekday: 'short' }));
  }, [t]);

  const navigateWeek = (direction: 'prev' | 'next') => {
    setCurrentWeekStart(prev => {
      const nextWeek = new Date(prev);
      nextWeek.setDate(nextWeek.getDate() + (direction === 'next' ? 7 : -7));
      return nextWeek;
    });
  };

  const openCreateModal = (day: Date, staffId = '') => {
    setCreateModalDate(new Date(day));
    setCreateStaffId(staffId);
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

  const applyTimePreset = (preset: typeof TIME_PRESETS[number]) => {
    if (createStartDate) {
      setCreateEndDate(createStartDate);
    }
    setCreateStartHour(preset.startHour);
    setCreateStartMinute(preset.startMinute);
    setCreateEndHour(preset.endHour);
    setCreateEndMinute(preset.endMinute);
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
      if (isBrowser()) {
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
      } else {
        await offlineCreateStaffShift({
          staff_id: createStaffId,
          start_time: startIso,
          end_time: endIso,
          notes: createNotes.trim() || null,
          status: 'scheduled',
          branch_id: branchId || undefined,
        });
      }

      toast.success(
        isBrowser()
          ? t('staffSchedule.shiftCreated', 'Shift created')
          : t('staffSchedule.savedLocallyQueued', 'Saved locally and queued'),
      );
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

  const importOverlaps = useCallback((candidate: ImportedScheduleShift, running: ImportRunningShift[]) => {
    const candidateStart = parseDate(candidate.startTime);
    const candidateEnd = parseDate(candidate.endTime);
    if (!candidateStart || !candidateEnd) {
      return true;
    }

    return running.some(shift => {
      if (shift.staffId !== candidate.staffId || normalizeStatus(shift.status) === 'cancelled') {
        return false;
      }
      const start = parseDate(shift.startTime);
      const end = parseDate(shift.endTime);
      if (!start || !end) {
        return false;
      }
      return start.getTime() < candidateEnd.getTime() && end.getTime() > candidateStart.getTime();
    });
  }, []);

  const handleImportScheduleFile = async (file: File) => {
    setImportingSchedule(true);
    try {
      const result = await importStaffScheduleFile(file, {
        staffList: staff.map(member => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          staffCode: member.staffCode || member.staff_code || null,
          name: member.name,
        })),
      });

      if (result.shifts.length === 0) {
        if (result.unmatchedStaffLabels?.length) {
          toast.error(
            t(
              'staffSchedule.import.unmatchedStaff',
              'No matching staff for: {{names}}. Add or rename the staff rows and import again.',
              { names: result.unmatchedStaffLabels.join(', ') },
            ),
          );
        } else {
          toast.error(t('staffSchedule.import.invalidFile', 'File does not look like a staff schedule.'));
        }
        return;
      }

      const seenKeys = new Set<string>();
      const uniqueRows = result.shifts.filter(row => {
        const key = `${row.staffId}|${row.startTime}|${row.endTime}`;
        if (seenKeys.has(key)) {
          return false;
        }
        seenKeys.add(key);
        return true;
      });
      const duplicateCount = result.shifts.length - uniqueRows.length;
      const running = shifts.reduce<ImportRunningShift[]>((acc, shift) => {
        const staffId = shift.staffId || shift.staff_id;
        const startTime = getShiftStartValue(shift);
        const endTime = getShiftEndValue(shift);
        if (!staffId || !startTime || !endTime) {
          return acc;
        }
        acc.push({ staffId, startTime, endTime, status: shift.status });
        return acc;
      }, []);

      let imported = 0;
      let overlapped = 0;
      let failed = 0;

      for (const row of uniqueRows) {
        if (importOverlaps(row, running)) {
          overlapped += 1;
          continue;
        }

        const payload = {
          staff_id: row.staffId,
          start_time: row.startTime,
          end_time: row.endTime,
          break_start: row.breakStart,
          break_end: row.breakEnd,
          notes: row.notes ?? null,
          status: row.status ?? 'scheduled',
          branch_id: branchId || undefined,
        };

        try {
          if (isBrowser()) {
            const response = await posApiPost<{ success?: boolean; error?: string }>('/pos/staff-schedule', payload);
            const failedResponse = !response.success || response.data?.success === false;
            if (failedResponse) {
              throw new Error(response.error || response.data?.error || 'Failed to create imported shift');
            }
          } else {
            await offlineCreateStaffShift(payload);
          }

          imported += 1;
          running.push({
            staffId: row.staffId,
            startTime: row.startTime,
            endTime: row.endTime,
            status: row.status ?? 'scheduled',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : '';
          if (message.includes('overlap') || message.includes('conflict')) {
            overlapped += 1;
          } else {
            failed += 1;
          }
        }
      }

      if (imported > 0) {
        const skipped = duplicateCount + overlapped + failed;
        const suffix = result.unmatchedStaffLabels?.length
          ? ` (${t('staffSchedule.import.unmatchedSuffix', 'no match')}: ${result.unmatchedStaffLabels.join(', ')})`
          : '';
        toast.success(
          t(
            'staffSchedule.import.success',
            'Imported {{imported}} shift(s) from {{format}}. Skipped {{skipped}}.',
            { imported, skipped, format: result.format?.toUpperCase() || 'file' },
          ) + suffix,
        );
        await fetchStaffData();
      } else {
        toast.error(t('staffSchedule.import.nothingImported', 'No valid shifts were imported.'));
      }
    } catch (error) {
      console.error('[StaffScheduleView] Import schedule error:', error);
      toast.error(
        t('staffSchedule.import.failed', 'Import failed: {{message}}', {
          message: error instanceof Error ? error.message : 'unknown error',
        }),
      );
    } finally {
      setImportingSchedule(false);
      if (importFileInputRef.current) {
        importFileInputRef.current.value = '';
      }
    }
  };

  const handlePublishToErgani = async () => {
    if (!branchId) {
      toast.error(t('staffSchedule.ergani.noBranch', 'Branch is not configured for this terminal.'));
      return;
    }
    if (weeklyShifts.length === 0) {
      toast.error(t('staffSchedule.ergani.noShifts', 'No shifts to publish for this week.'));
      return;
    }

    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const periodStart = localDateKey(currentWeekStart);
    const periodEnd = localDateKey(weekEnd);

    setPublishingErgani(true);
    setErganiPublishStatus(null);
    try {
      const response = await posApiPost<{
        status?: string;
        submission_id?: string;
        shift_count?: number;
      }>('/pos/plugins/ergani/schedules/publish', {
        start_date: periodStart,
        end_date: periodEnd,
        shift_ids: weeklyShifts.map(shift => shift.id),
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to publish schedule');
      }

      const status = response.data?.status || 'queued';
      setErganiPublishStatus(status);
      toast.success(
        status === 'blocked'
          ? t('staffSchedule.ergani.publishBlocked', 'Schedule queued but blocked until ERGANI setup is complete.')
          : t('staffSchedule.ergani.publishQueued', 'Schedule publish queued for ERGANI.'),
      );
    } catch (err: any) {
      setErganiPublishStatus('failed');
      toast.error(err?.message || t('staffSchedule.ergani.publishFailed', 'Failed to publish to ERGANI.'));
    } finally {
      setPublishingErgani(false);
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

  const panelClass = isDark
    ? 'bg-zinc-950/95 border-zinc-800 text-zinc-100'
    : 'bg-white border-slate-200 text-slate-950 shadow-sm';
  const softPanelClass = isDark
    ? 'bg-zinc-900/70 border-zinc-800'
    : 'bg-slate-50 border-slate-200';
  const mutedTextClass = isDark ? 'text-zinc-400' : 'text-slate-600';
  const inputClass = `w-full rounded-xl border px-3 py-3 text-base outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${
    isDark
      ? 'bg-zinc-900 border-zinc-700 text-zinc-100'
      : 'bg-white border-slate-300 text-slate-950'
  }`;
  const iconButtonClass = `inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-colors ${
    isDark
      ? 'bg-zinc-900 border-zinc-700 text-zinc-100 hover:bg-zinc-800'
      : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-100'
  }`;
  const primaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:bg-blue-500/60';
  const secondaryButtonClass = `inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-60 ${
    isDark
      ? 'bg-zinc-900 border-zinc-700 text-zinc-100 hover:bg-zinc-800'
      : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-100'
  }`;

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
            {t('common.actions.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full min-h-0 overflow-hidden ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>
      <input
        ref={importFileInputRef}
        type="file"
        accept={STAFF_SCHEDULE_IMPORT_ACCEPT}
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) {
            void handleImportScheduleFile(file);
          }
        }}
      />
      <div className="mx-auto flex h-full w-full max-w-screen-2xl flex-col gap-4 p-4 md:p-5 xl:p-6">
        <section className={`rounded-2xl border p-4 md:p-5 ${panelClass}`}>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold md:text-3xl">
                {t('staffSchedule.weeklyProgram', 'Weekly Staff Program')}
              </h2>
              <p className={`text-sm ${mutedTextClass}`}>
                {t('staffSchedule.weeklyProgramHint', 'See who is working each day and at what time')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => navigateWeek('prev')}
                aria-label={t('staffSchedule.actions.previousWeek', 'Previous week')}
                title={t('staffSchedule.actions.previousWeek', 'Previous week')}
                className={iconButtonClass}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div className={`inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold ${
                isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-slate-300'
              }`}>
                <Calendar className="h-4 w-4 text-blue-500" />
                {weekLabel}
              </div>
              <button
                type="button"
                onClick={() => navigateWeek('next')}
                aria-label={t('staffSchedule.actions.nextWeek', 'Next week')}
                title={t('staffSchedule.actions.nextWeek', 'Next week')}
                className={iconButtonClass}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={fetchStaffData}
                aria-label={refreshScheduleLabel}
                title={refreshScheduleLabel}
                className={iconButtonClass}
              >
                <RefreshCw className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => openCreateModal(defaultCreateDate)}
                className={primaryButtonClass}
              >
                <Plus className="h-4 w-4" />
                {t('staffSchedule.actions.addShift', 'Add shift')}
              </button>
              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                disabled={importingSchedule}
                className={secondaryButtonClass}
              >
                <Upload className="h-4 w-4" />
                {importingSchedule
                  ? t('staffSchedule.import.importing', 'Importing...')
                  : t('staffSchedule.import.action', 'Import')}
              </button>
              <button
                type="button"
                onClick={() => setPreviewWeekOpen(true)}
                className={secondaryButtonClass}
              >
                <Eye className="h-4 w-4" />
                {t('staffSchedule.previewWeek.action', 'Preview week')}
              </button>
              <button
                type="button"
                onClick={() => void handlePublishToErgani()}
                disabled={publishingErgani || weeklyShifts.length === 0}
                className={primaryButtonClass}
              >
                <FileText className="h-4 w-4" />
                {publishingErgani
                  ? t('staffSchedule.ergani.publishing', 'Publishing...')
                  : t('staffSchedule.ergani.publish', 'Publish to ERGANI')}
              </button>
            </div>
          </div>

          {erganiPublishStatus ? (
            <p className={`mt-3 text-xs ${mutedTextClass}`}>
              {t('staffSchedule.ergani.lastStatus', 'ERGANI status')}: {erganiPublishStatus}
            </p>
          ) : null}

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className={`rounded-xl border p-3 ${softPanelClass}`}>
              <p className={`text-xs ${mutedTextClass}`}>{t('staffSchedule.stats.totalStaff', 'Total Staff')}</p>
              <p className="mt-1 inline-flex items-center gap-2 text-2xl font-bold">
                <Users className="h-5 w-5 text-blue-500" />
                {filteredStaff.length}
              </p>
            </div>
            <div className={`rounded-xl border p-3 ${softPanelClass}`}>
              <p className={`text-xs ${mutedTextClass}`}>{t('staffSchedule.stats.scheduledThisWeek', 'Scheduled This Week')}</p>
              <p className="mt-1 inline-flex items-center gap-2 text-2xl font-bold">
                <UserCheck className="h-5 w-5 text-emerald-500" />
                {scheduledStaffCount}
              </p>
            </div>
            <div className={`rounded-xl border p-3 ${softPanelClass}`}>
              <p className={`text-xs ${mutedTextClass}`}>{t('staffSchedule.stats.todayShifts', 'Today Shifts')}</p>
              <p className="mt-1 inline-flex items-center gap-2 text-2xl font-bold">
                <Clock className="h-5 w-5 text-amber-500" />
                {todayShiftsCount}
              </p>
            </div>
            <div className={`rounded-xl border p-3 ${softPanelClass}`}>
              <p className={`text-xs ${mutedTextClass}`}>{t('staffSchedule.stats.unscheduled', 'Unscheduled')}</p>
              <p className="mt-1 inline-flex items-center gap-2 text-2xl font-bold">
                <Briefcase className="h-5 w-5 text-fuchsia-500" />
                {unscheduledStaff.length}
              </p>
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto scrollbar-hide pb-1">
            <button
              type="button"
              onClick={() => setRoleFilter('all')}
              className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                roleFilter === 'all'
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : isDark
                    ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {t('staffSchedule.filters.all', 'All roles')}
            </button>
            {availableRoles.map(role => (
              <button
                key={role}
                type="button"
                onClick={() => setRoleFilter(role)}
                className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-semibold capitalize transition-colors ${
                  roleFilter === role
                    ? 'text-white'
                    : isDark
                      ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
                style={roleFilter === role ? { backgroundColor: getRoleColor(role), borderColor: getRoleColor(role) } : undefined}
              >
                {getRoleLabel(role)}
              </button>
            ))}
          </div>
        </section>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <div className="space-y-4 pb-1">
            <section className={`rounded-2xl border p-3 md:p-4 ${panelClass}`}>
              <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">{t('staffSchedule.scheduleTitle', 'This week')}</h3>
                  <p className={`text-sm ${mutedTextClass}`}>{t('staffSchedule.scheduleHint', 'Tap a day or the plus button to add a shift.')}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
                {weekDays.map(day => {
                  const dayKey = localDateKey(day);
                  const dayShifts = shiftsByDay[dayKey] || [];
                  const today = dayKey === todayKey;

                  return (
                    <article
                      key={dayKey}
                      className={`flex min-h-64 overflow-hidden flex-col rounded-xl border transition-colors ${
                        today
                          ? isDark
                            ? 'bg-blue-950/20 border-blue-600 shadow-[0_0_0_1px_rgba(37,99,235,0.35)]'
                            : 'bg-blue-50 border-blue-300 shadow-[0_0_0_1px_rgba(59,130,246,0.2)]'
                          : softPanelClass
                      }`}
                    >
                      <div className={`border-b px-3 py-3 ${today ? (isDark ? 'border-blue-800' : 'border-blue-200') : (isDark ? 'border-zinc-800' : 'border-slate-200')}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-base font-bold">{getDayLabel(day)}</p>
                              {today && (
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                                  isDark ? 'bg-blue-600/20 border-blue-500/50 text-blue-200' : 'bg-blue-100 border-blue-200 text-blue-700'
                                }`}>
                                  {t('staffSchedule.today', 'Today')}
                                </span>
                              )}
                            </div>
                            <p className={`text-xs ${mutedTextClass}`}>
                              {day.toLocaleDateString([], { day: '2-digit', month: 'short' })}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-xs font-semibold ${
                              dayShifts.length > 0
                                ? isDark ? 'bg-emerald-900/50 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
                                : isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-slate-200 text-slate-600'
                            }`}>
                              {dayShifts.length}
                            </span>
                            <button
                              type="button"
                              onClick={() => openCreateModal(day)}
                              aria-label={t('staffSchedule.addShiftForDay', 'Add shift for this day')}
                              title={t('staffSchedule.addShiftForDay', 'Add shift for this day')}
                              className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border transition-colors ${
                                isDark
                                  ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800'
                                  : 'bg-white border-slate-300 hover:bg-slate-100'
                              }`}
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex-1 space-y-2 overflow-y-auto scrollbar-hide p-3">
                        {dayShifts.length === 0 ? (
                          <button
                            type="button"
                            onClick={() => openCreateModal(day)}
                            className={`flex h-full min-h-28 w-full flex-col items-center justify-center rounded-xl border border-dashed px-3 py-6 text-center text-sm transition-colors ${
                              isDark
                                ? 'border-zinc-700 text-zinc-500 hover:border-blue-600 hover:text-blue-300'
                                : 'border-slate-300 text-slate-500 hover:border-blue-300 hover:text-blue-700'
                            }`}
                          >
                            <Plus className="mb-2 h-5 w-5" />
                            <span className="font-medium">{t('staffSchedule.noShifts', 'No shifts')}</span>
                            <span className="mt-1 text-xs">{t('staffSchedule.tapToAddShift', 'Tap to add one')}</span>
                          </button>
                        ) : (
                          dayShifts.map(shift => (
                            <div
                              key={shift.id}
                              className={`rounded-xl border-l-4 border px-3 py-2 ${
                                isDark ? 'bg-black/30 border-zinc-800' : 'bg-white border-slate-200'
                              }`}
                              style={{ borderLeftColor: shift.roleColor }}
                            >
                              <p className="text-sm font-semibold leading-tight">{shift.staffName}</p>
                              <p className={`mt-1 inline-flex items-center gap-1 text-xs capitalize ${mutedTextClass}`}>
                                <Briefcase className="h-3 w-3" />
                                {shift.roleLabel}
                              </p>
                              <p className={`mt-1 inline-flex items-center gap-1 text-base font-bold ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>
                                <Clock className="h-4 w-4" />
                                {formatTimeRange(shift.start, shift.end)}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className={`rounded-2xl border p-4 ${panelClass}`}>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-base font-semibold">
                    {t('staffSchedule.unscheduled', 'Not Scheduled This Week')} ({unscheduledStaff.length})
                  </h3>
                  <p className={`text-sm ${mutedTextClass}`}>{t('staffSchedule.unscheduledHint', 'Tap a name to create their next shift quickly.')}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                {unscheduledStaff.length === 0 ? (
                  <span className={`text-sm ${mutedTextClass}`}>{t('staffSchedule.everyoneScheduled', 'Everyone has at least one shift this week.')}</span>
                ) : (
                  unscheduledStaff.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => openCreateModal(defaultCreateDate, member.id)}
                      className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                        isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                      }`}
                      title={t('staffSchedule.addShiftForStaff', 'Add shift for this staff member')}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {member.name}
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {previewWeekOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('staffSchedule.actions.close', 'Close')}
            className="absolute inset-0 bg-black/60"
            onClick={() => setPreviewWeekOpen(false)}
          />
          <div className={`relative flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border ${panelClass}`}>
            <div className={`flex items-start justify-between gap-3 border-b p-4 md:p-5 ${isDark ? 'border-zinc-800' : 'border-slate-200'}`}>
              <div className="min-w-0">
                <h3 className="text-xl font-semibold md:text-2xl">
                  {t('staffSchedule.previewWeek.title', 'Week preview')}
                </h3>
                <p className={`mt-1 text-sm ${mutedTextClass}`}>
                  {weekLabel} - {t('staffSchedule.previewWeek.activeStaffCount', '{{count}} active staff scheduled', { count: weeklyPreviewRows.length })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewWeekOpen(false)}
                aria-label={t('staffSchedule.actions.close', 'Close')}
                className={iconButtonClass}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto scrollbar-hide p-4 md:p-5">
              {weeklyPreviewRows.length === 0 ? (
                <div className={`flex min-h-48 items-center justify-center rounded-xl border border-dashed text-center text-sm ${isDark ? 'border-zinc-700 text-zinc-400' : 'border-slate-300 text-slate-500'}`}>
                  {t('staffSchedule.previewWeek.empty', 'No active staff are scheduled for this week.')}
                </div>
              ) : (
                <div className="overflow-x-auto scrollbar-hide rounded-xl border border-inherit">
                  <div className="min-w-max">
                    <div className={`grid grid-cols-[180px_repeat(7,minmax(104px,1fr))] border-b text-xs font-semibold uppercase ${isDark ? 'bg-zinc-900 border-zinc-800 text-zinc-400' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
                      <div className={`border-r p-3 ${isDark ? 'border-zinc-800' : 'border-slate-200'}`}>
                        {t('staffSchedule.fields.staff', 'Staff')}
                      </div>
                      {weekDays.map(day => {
                        const dayKey = localDateKey(day);
                        const isToday = dayKey === todayKey;
                        return (
                          <div
                            key={`preview-header-${dayKey}`}
                            className={`border-r p-3 last:border-r-0 ${isDark ? 'border-zinc-800' : 'border-slate-200'} ${isToday ? (isDark ? 'text-blue-300' : 'text-blue-700') : ''}`}
                          >
                            <div>{getDayLabel(day)}</div>
                            <div className="mt-0.5 font-normal normal-case">
                              {day.toLocaleDateString([], { day: '2-digit', month: 'short' })}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {weeklyPreviewRows.map(row => (
                      <div
                        key={row.staff.id}
                        className={`grid grid-cols-[180px_repeat(7,minmax(104px,1fr))] border-b last:border-b-0 ${isDark ? 'border-zinc-800' : 'border-slate-200'}`}
                      >
                        <div className={`border-r p-3 ${isDark ? 'border-zinc-800 bg-zinc-950/60' : 'border-slate-200 bg-white'}`}>
                          <p className="truncate text-sm font-semibold">{row.staff.name}</p>
                          <p className={`mt-1 truncate text-xs ${mutedTextClass}`}>
                            {row.staff.role?.displayName || row.staff.role?.name || t('staffSchedule.roles.staff', 'Staff')}
                          </p>
                          {(row.staff.staffCode || row.staff.staff_code) ? (
                            <p className={`mt-1 truncate text-xs ${mutedTextClass}`}>
                              {row.staff.staffCode || row.staff.staff_code}
                            </p>
                          ) : null}
                        </div>

                        {weekDays.map(day => {
                          const dayKey = localDateKey(day);
                          const dayShifts = row.shiftsByDay[dayKey] || [];
                          return (
                            <div
                              key={`${row.staff.id}-${dayKey}`}
                              className={`min-h-24 border-r last:border-r-0 ${isDark ? 'border-zinc-800' : 'border-slate-200'} ${
                                dayShifts.length === 0
                                  ? isDark ? 'bg-amber-950/40' : 'bg-amber-50'
                                  : isDark ? 'bg-zinc-950/30' : 'bg-white'
                              }`}
                            >
                              {dayShifts.length === 0 ? (
                                <div className={`flex h-full min-h-24 w-full items-center justify-center px-2 text-center text-sm font-bold uppercase tracking-wide ${
                                  isDark ? 'text-amber-200' : 'text-amber-800'
                                }`}>
                                  {t('staffSchedule.dayOff', 'Day Off')}
                                </div>
                              ) : (
                                <div className="space-y-1.5 p-2">
                                  {dayShifts.map(shift => (
                                    <div
                                      key={`preview-${shift.id}`}
                                      className={`rounded-lg border-l-4 px-2 py-2 ${isDark ? 'bg-zinc-900 border-zinc-800' : 'bg-slate-50 border-slate-200'}`}
                                      style={{ borderLeftColor: shift.roleColor }}
                                    >
                                      <p className="text-base font-bold leading-tight">{formatTimeRange(shift.start, shift.end)}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {createModalOpen && createModalDate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('staffSchedule.actions.close', 'Close')}
            className="absolute inset-0 bg-black/60"
            onClick={closeCreateModal}
          />
          <div className={`relative max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto scrollbar-hide rounded-2xl border p-5 md:p-6 ${panelClass}`}>
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
                aria-label={t('staffSchedule.actions.close', 'Close')}
                className={iconButtonClass}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {t('staffSchedule.fields.staff', 'Staff')}
                </span>
                <select
                  value={createStaffId}
                  onChange={e => setCreateStaffId(e.target.value)}
                  className={`mt-1 ${inputClass}`}
                >
                  <option value="">{t('staffSchedule.selectStaff', 'Select staff')}</option>
                  {filteredStaff.map(member => (
                    <option key={member.id} value={member.id}>
                      {member.name} ({member.role?.displayName || member.role?.name || t('staffSchedule.roles.staff', 'Staff')})
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap gap-2">
                {TIME_PRESETS.map(preset => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyTimePreset(preset)}
                    className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    {t(`staffSchedule.presets.${preset.key}`, preset.key)}
                  </button>
                ))}
              </div>

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
                      className={inputClass}
                    />
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <select
                        value={createStartHour}
                        onChange={e => setCreateStartHour(e.target.value)}
                        className={inputClass}
                      >
                        {HOURS.map(hour => <option key={`start-hour-${hour}`} value={hour}>{hour}</option>)}
                      </select>
                      <span className={`text-xl font-bold ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>:</span>
                      <select
                        value={createStartMinute}
                        onChange={e => setCreateStartMinute(e.target.value)}
                        className={inputClass}
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
                      className={inputClass}
                    />
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <select
                        value={createEndHour}
                        onChange={e => setCreateEndHour(e.target.value)}
                        className={inputClass}
                      >
                        {HOURS.map(hour => <option key={`end-hour-${hour}`} value={hour}>{hour}</option>)}
                      </select>
                      <span className={`text-xl font-bold ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>:</span>
                      <select
                        value={createEndMinute}
                        onChange={e => setCreateEndMinute(e.target.value)}
                        className={inputClass}
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
                <p className="text-sm font-medium">{shiftPreview.valid ? t('staffSchedule.preview', 'Preview') : t('staffSchedule.validationLabel', 'Validation')}</p>
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
                  className={`mt-1 resize-none ${inputClass}`}
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
                {t('common.actions.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={handleCreateShift}
                disabled={creatingShift}
                className={primaryButtonClass}
              >
                {creatingShift ? t('common.actions.saving', 'Saving...') : t('staffSchedule.createProgram', 'Create shift')}
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

import React, { memo, useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { User, Clock, ChevronLeft, ChevronRight, Calendar, Users, Briefcase, RefreshCw, AlertCircle } from 'lucide-react';
import { posApiGet } from '../../../utils/api-helpers';
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
  staffId: string;
  startTime: string;
  endTime: string;
  status: string;
}

interface ApiResponse {
  success: boolean;
  staff: StaffMember[];
  shifts: ScheduleShift[];
  totalCount: number;
  error?: string;
}

// Role color mapping for display
const getRoleColor = (roleName: string | undefined): string => {
  const colors: Record<string, string> = {
    admin: '#DC2626',
    manager: '#D97706',
    supervisor: '#059669',
    staff: '#3B82F6',
    stylist: '#8B5CF6',
    colorist: '#A855F7',
    nail_tech: '#EC4899',
    receptionist: '#10B981',
    customer: '#6B7280',
  };
  return colors[roleName || 'staff'] || '#3B82F6';
};

export const StaffScheduleView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<ScheduleShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [currentWeekStart, setCurrentWeekStart] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay());
    return start;
  });

  const isDark = resolvedTheme === 'dark';
  const branchId = getSetting<string>('terminal', 'branch_id', '');

  // Fetch staff data
  const fetchStaffData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const weekEnd = new Date(currentWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

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
        setShifts(response.data.shifts || []);
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

  // Get unique roles from staff
  const availableRoles = useMemo(() => {
    const roles = new Set<string>();
    staff.forEach(s => {
      if (s.role?.name) roles.add(s.role.name);
    });
    return Array.from(roles);
  }, [staff]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + i);
      return date;
    });
  }, [currentWeekStart]);

  const filteredStaff = roleFilter === 'all'
    ? staff
    : staff.filter(s => s.role?.name === roleFilter);

  const navigateWeek = (direction: 'prev' | 'next') => {
    setCurrentWeekStart(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
      return newDate;
    });
  };

  const formatDateHeader = (date: Date): string => {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${dayNames[date.getDay()]} ${date.getDate()}`;
  };

  const isToday = (date: Date): boolean => {
    return date.toDateString() === new Date().toDateString();
  };

  // Loading state
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className={isDark ? 'text-gray-400' : 'text-gray-600'}>
            {t('staffSchedule.loading', 'Loading staff schedule...')}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className={`flex flex-col items-center gap-4 p-8 rounded-2xl ${
          isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'
        }`}>
          <AlertCircle className="w-12 h-12 text-red-500" />
          <p className={isDark ? 'text-red-400' : 'text-red-600'}>{error}</p>
          <button
            onClick={fetchStaffData}
            className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 gap-6">
      {/* Beautiful Header with Glassmorphism */}
      <div className={`rounded-2xl p-6 backdrop-blur-xl ${
        isDark
          ? 'bg-gradient-to-r from-gray-800/80 to-gray-900/80 border border-white/10'
          : 'bg-gradient-to-r from-white/80 to-gray-50/80 border border-gray-200 shadow-xl'
      }`}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          {/* Stats Cards */}
          <div className="flex gap-4">
            {/* Total Staff Card */}
            <div className={`px-5 py-4 rounded-xl flex items-center gap-4 ${
              isDark
                ? 'bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30'
                : 'bg-gradient-to-br from-blue-50 to-purple-50 border border-blue-200 shadow-sm'
            }`}>
              <div className={`p-3 rounded-xl ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}>
                <Users className="w-6 h-6 text-blue-500" />
              </div>
              <div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('staffSchedule.stats.totalStaff', 'Total Staff')}
                </p>
                <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {filteredStaff.length}
                </p>
              </div>
            </div>

            {/* Roles Count Card */}
            <div className={`px-5 py-4 rounded-xl flex items-center gap-4 ${
              isDark
                ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/20 border border-green-500/30'
                : 'bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 shadow-sm'
            }`}>
              <div className={`p-3 rounded-xl ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}>
                <Briefcase className="w-6 h-6 text-green-500" />
              </div>
              <div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('staffSchedule.stats.roles', 'Roles')}
                </p>
                <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {availableRoles.length}
                </p>
              </div>
            </div>
          </div>

          {/* Week Navigation */}
          <div className={`flex items-center gap-2 px-2 py-1 rounded-xl ${
            isDark ? 'bg-gray-800/50' : 'bg-white/50'
          }`}>
            <button
              onClick={() => navigateWeek('prev')}
              className={`p-2.5 rounded-xl transition-all ${
                isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'
              }`}
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className={`px-5 py-2.5 rounded-xl flex items-center gap-3 min-w-[200px] justify-center ${
              isDark ? 'bg-gray-700/50' : 'bg-white shadow-sm'
            }`}>
              <Calendar className={`w-5 h-5 ${isDark ? 'text-blue-400' : 'text-blue-500'}`} />
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {currentWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {weekDays[6]?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>
            <button
              onClick={() => navigateWeek('next')}
              className={`p-2.5 rounded-xl transition-all ${
                isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'
              }`}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* Role Filter Pills */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setRoleFilter('all')}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                roleFilter === 'all'
                  ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg shadow-blue-500/25'
                  : isDark
                    ? 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
                    : 'bg-white text-gray-600 hover:bg-gray-50 shadow-sm'
              }`}
            >
              {t('common.all', 'All')}
            </button>
            {availableRoles.map(role => (
              <button
                key={role}
                onClick={() => setRoleFilter(role)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all capitalize ${
                  roleFilter === role
                    ? 'text-white shadow-lg'
                    : isDark
                      ? 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
                      : 'bg-white text-gray-600 hover:bg-gray-50 shadow-sm'
                }`}
                style={roleFilter === role ? {
                  backgroundColor: getRoleColor(role),
                  boxShadow: `0 10px 25px -5px ${getRoleColor(role)}40`
                } : {}}
              >
                {role.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Staff Grid - Beautiful Card Layout */}
      <div className="flex-1 overflow-auto">
        {filteredStaff.length === 0 ? (
          <div className={`flex flex-col items-center justify-center h-64 rounded-2xl ${
            isDark ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-50 border border-gray-200'
          }`}>
            <Users className={`w-16 h-16 mb-4 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} />
            <p className={`text-lg ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('staffSchedule.noStaff', 'No staff members found')}
            </p>
            <p className={`text-sm mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {t('staffSchedule.addStaffHint', 'Add staff members in the Admin Dashboard')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredStaff.map(member => {
              const roleColor = getRoleColor(member.role?.name);
              return (
                <div
                  key={member.id}
                  className={`group relative rounded-2xl overflow-hidden transition-all duration-300 hover:scale-[1.02] ${
                    isDark
                      ? 'bg-gradient-to-br from-gray-800 to-gray-900 border border-white/10 hover:border-white/20'
                      : 'bg-white border border-gray-200 shadow-lg hover:shadow-xl'
                  }`}
                >
                  {/* Role Color Accent Bar */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1"
                    style={{ backgroundColor: roleColor }}
                  />

                  <div className="p-5">
                    {/* Avatar and Info */}
                    <div className="flex items-start gap-4">
                      {/* Avatar */}
                      <div
                        className="relative w-14 h-14 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0 shadow-lg"
                        style={{
                          backgroundColor: roleColor,
                          boxShadow: `0 8px 20px -4px ${roleColor}50`
                        }}
                      >
                        {member.avatarUrl ? (
                          <img
                            src={member.avatarUrl}
                            alt={member.name}
                            className="w-full h-full rounded-xl object-cover"
                          />
                        ) : (
                          member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
                        )}
                        {/* Online indicator */}
                        <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 border-2 border-white dark:border-gray-800 rounded-full" />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <h3 className={`font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {member.name}
                        </h3>
                        <div
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium mt-1"
                          style={{
                            backgroundColor: `${roleColor}20`,
                            color: roleColor
                          }}
                        >
                          <Briefcase className="w-3 h-3" />
                          <span className="capitalize">{member.role?.displayName || member.role?.name || 'Staff'}</span>
                        </div>
                        {member.department && (
                          <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {member.department}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Contact Info */}
                    {(member.email || member.phone) && (
                      <div className={`mt-4 pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
                        {member.email && (
                          <p className={`text-xs truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {member.email}
                          </p>
                        )}
                        {member.phone && (
                          <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {member.phone}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Refresh Button */}
      <div className="flex justify-center">
        <button
          onClick={fetchStaffData}
          disabled={loading}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
            isDark
              ? 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
              : 'bg-white text-gray-600 hover:bg-gray-50 shadow-lg border border-gray-200'
          }`}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh', 'Refresh')}
        </button>
      </div>
    </div>
  );
});

StaffScheduleView.displayName = 'StaffScheduleView';
export default StaffScheduleView;

import React, { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { Clock, User, Filter } from 'lucide-react';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'verified' | 'cancelled';
// Priority matches DB schema: low, normal, high, urgent (not 'medium')
type Priority = 'urgent' | 'high' | 'normal' | 'low';

interface HousekeepingTask {
  id: string;
  roomNumber: string;
  taskType: 'cleaning' | 'turndown' | 'maintenance';
  assignedStaff: string;
  priority: Priority;
  status: TaskStatus;
  estimatedTime: number;
}

const MOCK_TASKS: HousekeepingTask[] = Array.from({ length: 20 }, (_, i) => ({
  id: `task-${i + 1}`,
  roomNumber: `${Math.floor(i / 4) + 1}${String((i % 4) + 1).padStart(2, '0')}`,
  taskType: (['cleaning', 'turndown', 'maintenance'] as const)[i % 3],
  assignedStaff: ['Maria', 'Carlos', 'Anna', 'James'][i % 4],
  priority: (['high', 'normal', 'low'] as Priority[])[i % 3],
  status: (['pending', 'in_progress', 'completed'] as TaskStatus[])[i % 3],
  estimatedTime: [30, 45, 60][i % 3],
}));

export const HousekeepingView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [tasks, setTasks] = useState<HousekeepingTask[]>(MOCK_TASKS);
  const [floorFilter, setFloorFilter] = useState<string>('all');
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [staffFilter, setStaffFilter] = useState<string>('all');
  const isDark = resolvedTheme === 'dark';

  const columns: { status: TaskStatus; label: string }[] = [
    { status: 'pending', label: t('housekeepingView.status.pending', { defaultValue: 'Pending' }) },
    { status: 'in_progress', label: t('housekeepingView.status.inProgress', { defaultValue: 'In Progress' }) },
    { status: 'completed', label: t('housekeepingView.status.completed', { defaultValue: 'Completed' }) },
  ];

  const priorityColors: Record<Priority, string> = {
    urgent: 'red',
    high: 'orange',
    normal: 'yellow',
    low: 'green',
  };

  // Extract unique values for filters
  const floors = [...new Set(tasks.map(t => t.roomNumber.charAt(0)))].sort();
  const taskTypes = [...new Set(tasks.map(t => t.taskType))];
  const staffMembers = [...new Set(tasks.map(t => t.assignedStaff))];

  // Filter tasks
  const filteredTasks = tasks.filter(task => {
    if (floorFilter !== 'all' && !task.roomNumber.startsWith(floorFilter)) return false;
    if (taskTypeFilter !== 'all' && task.taskType !== taskTypeFilter) return false;
    if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
    if (staffFilter !== 'all' && task.assignedStaff !== staffFilter) return false;
    return true;
  });

  // Calculate stats
  const completedToday = tasks.filter(t => t.status === 'completed').length;
  const avgCompletionTime = 42; // Mock average completion time in minutes

  const moveTask = (taskId: string, newStatus: TaskStatus) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
  };

  return (
    <div className="h-full flex flex-col p-4">
      {/* Stats */}
      <div className="flex gap-4 mb-4">
        <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
          <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('housekeepingView.stats.totalTasks', { defaultValue: 'Total Tasks' })}</div>
          <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredTasks.length}</div>
        </div>
        <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
          <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('housekeepingView.stats.completedToday', { defaultValue: 'Completed Today' })}</div>
          <div className={`text-xl font-bold text-green-500`}>{completedToday}</div>
        </div>
        <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
          <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('housekeepingView.stats.avgTime', { defaultValue: 'Avg Time' })}</div>
          <div className={`text-xl font-bold text-blue-500`}>{avgCompletionTime}min</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-1">
          <Filter className={`w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
        </div>
        <select
          value={floorFilter}
          onChange={(e) => setFloorFilter(e.target.value)}
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
        >
          <option value="all">{t('housekeepingView.filter.allFloors', { defaultValue: 'All Floors' })}</option>
          {floors.map(f => <option key={f} value={f}>{t('housekeepingView.filter.floor', { defaultValue: 'Floor' })} {f}</option>)}
        </select>
        <select
          value={taskTypeFilter}
          onChange={(e) => setTaskTypeFilter(e.target.value)}
          className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
        >
          <option value="all">{t('housekeepingView.filter.allTypes', { defaultValue: 'All Types' })}</option>
          {taskTypes.map(type => <option key={type} value={type}>{type}</option>)}
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
          {staffMembers.map(staff => <option key={staff} value={staff}>{staff}</option>)}
        </select>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 grid grid-cols-3 gap-4 overflow-hidden">
        {columns.map(col => {
          const columnTasks = filteredTasks.filter(t => t.status === col.status);
          return (
            <div key={col.status} className="flex flex-col min-h-0">
              <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{col.label}</span>
                <span className={`ml-auto px-2 py-0.5 rounded-full text-sm ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
                  {columnTasks.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {columnTasks.map(task => (
                  <div key={task.id} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white shadow-sm'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('housekeepingView.room', { defaultValue: 'Room' })} {task.roomNumber}</span>
                      <span className={`px-2 py-0.5 rounded text-xs bg-${priorityColors[task.priority]}-500/10 text-${priorityColors[task.priority]}-500`}>
                        {t(`housekeepingView.priority.${task.priority}`, { defaultValue: task.priority })}
                      </span>
                    </div>
                    <div className={`text-sm capitalize ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{task.taskType}</div>
                    <div className="flex items-center gap-2 mt-2 text-xs">
                      <User className="w-3 h-3" /><span>{task.assignedStaff}</span>
                      <Clock className="w-3 h-3 ml-2" /><span>{task.estimatedTime}min</span>
                    </div>
                    {col.status !== 'completed' && (
                      <button
                        onClick={() => moveTask(task.id, col.status === 'pending' ? 'in_progress' : 'completed')}
                        className="w-full mt-2 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {col.status === 'pending' 
                          ? t('housekeepingView.action.start', { defaultValue: 'Start' }) 
                          : t('housekeepingView.action.complete', { defaultValue: 'Complete' })}
                      </button>
                    )}
                  </div>
                ))}
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

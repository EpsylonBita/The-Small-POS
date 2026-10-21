import { useTerminalSettings } from './useTerminalSettings';
import { branchCalendarClock } from '../utils/room-workflow';
export function useHotelClock() {
  const { getSetting } = useTerminalSettings();
  const branch = getSetting<string>('terminal', 'branch_id', '');
  const zoneBranch = getSetting<string>('terminal', 'hotel_timezone_branch_id', '');
  const timeZone = branch && branch === zoneBranch ? getSetting<string>('terminal', 'hotel_timezone', '') ?? '' : '';
  return { timeZone, clock: (now = new Date()) => branchCalendarClock(timeZone, now) };
}

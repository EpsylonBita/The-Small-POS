import { getBridge } from '../../lib';

export function branchWallTime(instant: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Reject a DST gap; choose the first occurrence of a repeated wall minute. */
export function branchWallTimeToIso(wall: string, timeZone: string): string {
  const normalized = wall.length === 16 ? `${wall}:00` : wall;
  const calendar = Date.parse(`${normalized}Z`);
  if (!timeZone || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== normalized) throw new Error('BRANCH_TIME_INVALID');
  const offsets = new Set<number>();
  for (const hours of [-36, 0, 36]) {
    const sample = calendar + hours * 3600000;
    offsets.add(Date.parse(`${branchWallTime(new Date(sample), timeZone)}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => calendar - offset)
    .filter(value => branchWallTime(new Date(value), timeZone) === normalized).sort((a, b) => a - b);
  if (!candidates.length) throw new Error('BRANCH_TIME_INVALID');
  return new Date(candidates[0]).toISOString();
}

/** These retained settings come only from authenticated branch_info.timezone. */
export async function retainedBranchTimeZone(branchId: string): Promise<string> {
  const bridge = getBridge();
  const [branch, zone] = await Promise.all([
    bridge.settings.get('terminal', 'hotel_timezone_branch_id'),
    bridge.settings.get('terminal', 'hotel_timezone'),
  ]);
  if (!branchId || branch !== branchId || typeof zone !== 'string' || !zone) throw new Error('TIMEZONE_UNAVAILABLE');
  branchWallTime(new Date(), zone);
  return zone;
}

/** One machine in the live floor snapshot (`GET /api/analytics/floor`). */
export interface FloorMachine {
  _id: string;
  name: string;
  departmentId: string;
  departmentName?: string | null;
  status: string;
  /** When the machine entered its current state (ISO, UTC). */
  statusSince?: string | null;
  unitsToday: number;
  unitsThisHour: number;
  expectedPerHour: number;
  /** What the mold should have made by this point in the hour. */
  expectedSoFar: number;
  moldName?: string | null;
  operatorName?: string | null;
  /** A stoppage that still has no reason. */
  waitingForReason?: { hour: number; minutes: number } | null;
}

export interface FloorSnapshot {
  now: string;
  factoryHour: number;
  machines: FloorMachine[];
}

/** "for 12 min", "for 3 h 05 min", "for 2 days". Empty when the start is unknown. */
export function timeInState(since: string | null | undefined, now: number = Date.now()): string {
  if (!since) return '';
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `for ${minutes} min`;
  if (minutes < 1440) return `for ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
  const days = Math.floor(minutes / 1440);
  return `for ${days} ${days === 1 ? 'day' : 'days'}`;
}

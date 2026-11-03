/**
 * When the tracker talks to members, in the community's own timezone:
 *
 *   Monday 03:00 → Friday 13:00   one opportunity every few minutes (5–8 by default)
 *   Friday 14:00                  the weekly report, then a weekend message
 *   the weekend                   silence (scanning continues quietly)
 */

export interface LocalTime {
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
  hour: number;
  minute: number;
  /** YYYY-MM-DD in the local timezone. */
  date: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const minutes = (t: LocalTime): number => t.hour * 60 + t.minute;

/** Monday 03:00 up to (not including) Friday 13:00. */
export function inDripWindow(t: LocalTime): boolean {
  if (t.weekday === 1) return minutes(t) >= 3 * 60;
  if (t.weekday >= 2 && t.weekday <= 4) return true;
  if (t.weekday === 5) return minutes(t) < 13 * 60;
  return false;
}

/** Friday from 14:00 until midnight: when the weekly report goes out. */
export function isReportTime(t: LocalTime): boolean {
  return t.weekday === 5 && t.hour >= 14;
}

/** The Monday that starts this local week, as YYYY-MM-DD: the report's key. */
export function weekStart(t: LocalTime): string {
  const date = new Date(`${t.date}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (t.weekday - 1));
  return date.toISOString().slice(0, 10);
}

export interface DripRange {
  minMinutes: number;
  maxMinutes: number;
}

/** Five to eight minutes between cards unless an administrator changes it. */
export const DEFAULT_DRIP: DripRange = { minMinutes: 5, maxMinutes: 8 };

/** "5", "5-8" or "5–8" → a range, within 1 to 120 minutes. Null when unreadable. */
export function parseDripRange(text: string): DripRange | null {
  const match = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/.exec(text.trim());
  if (!match) return null;
  const min = Number(match[1]);
  const max = match[2] ? Number(match[2]) : min;
  if (min < 1 || max > 120 || max < min) return null;
  return { minMinutes: min, maxMinutes: max };
}

/** The next gap between two opportunities, picked at random within the range. */
export function nextDripDelayMs(range: DripRange = DEFAULT_DRIP, random: () => number = Math.random): number {
  return Math.round((range.minMinutes + random() * (range.maxMinutes - range.minMinutes)) * 60_000);
}

export function weekLabel(startIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 4);
  const format = (date: Date): string =>
    date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `Week of ${format(start)} – ${format(end)}`;
}

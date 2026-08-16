const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function dateKey(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    dateFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function offsetMinutesAt(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (!name || name === 'GMT') return 0;
  const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Unable to determine ${timeZone} offset`);
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function midnightUtc(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const first = new Date(candidate.getTime() - offsetMinutesAt(candidate, timeZone) * 60_000);
  return new Date(candidate.getTime() - offsetMinutesAt(first, timeZone) * 60_000);
}

export function nextDateKey(localDate: string): string {
  return shiftDateKey(localDate, 1);
}

export function shiftDateKey(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function todayBounds(timeZone: string, now = new Date()): { date: string; start: Date; end: Date } {
  const date = dateKey(now, timeZone);
  return {
    date,
    start: midnightUtc(date, timeZone),
    end: midnightUtc(nextDateKey(date), timeZone),
  };
}

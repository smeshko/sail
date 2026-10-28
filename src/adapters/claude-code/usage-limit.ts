// Recognising the provider's usage limit: its text ("You've hit your session limit · resets 4:20pm (Europe/Sofia)"), and
// the reset time it gives as text or as an epoch. Only this adapter knows the provider's wording; a time it cannot read
// is no reset time, and the watcher falls back to its back-off.

/** Whether `text` says the user hit a usage limit. */
export function limitText(text: string): boolean {
  return /hit your [^·]*limit/i.test(text);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const RESETS = /resets\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/** The wall clock `zone` shows at `ms`, as the UTC instant that has the same digits. Throws on an unknown zone. */
function wallClock(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'));
}

/** The instant at which `zone` shows this wall clock. */
function instantAt(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wanted = Date.UTC(year, month, day, hour, minute);
  const first = wanted - (wallClock(wanted, zone) - wanted);
  return wanted - (wallClock(first, zone) - first);
}

/**
 * The first instant after `now` at which the zone in `text` shows the time it names, as ISO 8601: `resets 4:20pm
 * (Europe/Sofia)` is today's or tomorrow's, `resets Oct 30, 4pm (Europe/Sofia)` that day's, or next year's.
 */
export function resetsFromText(text: string, now: Date): string | undefined {
  const found = RESETS.exec(text);
  if (found === null) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = found as unknown as [
    string,
    string | undefined,
    string | undefined,
    string,
    string | undefined,
    string,
    string,
  ];
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  try {
    const local = new Date(wallClock(now.getTime(), zone.trim()));
    const year = local.getUTCFullYear();
    let month = local.getUTCMonth();
    let day = local.getUTCDate();
    const dated = monthName !== undefined && dayText !== undefined;
    if (dated) {
      month = MONTHS.indexOf(monthName.toLowerCase());
      day = Number(dayText);
      if (month < 0) return undefined;
      const check = new Date(Date.UTC(year, month, day));
      if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
    }
    let at = instantAt(year, month, day, hour, minute, zone.trim());
    if (at <= now.getTime()) {
      at = dated
        ? instantAt(year + 1, month, day, hour, minute, zone.trim())
        : instantAt(year, month, day + 1, hour, minute, zone.trim());
    }
    return new Date(at).toISOString();
  } catch {
    return undefined;
  }
}

/** An epoch from the SDK as ISO 8601: below 1e12 it is seconds, otherwise milliseconds. */
export function resetsFromEpoch(value: number): string {
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

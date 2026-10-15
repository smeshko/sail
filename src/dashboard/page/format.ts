// The formats the views share: durations, dollars, token counts, clock times and ages. Pure, and built by hand rather
// than through Intl, so every Bun gives the same strings. A time of day is shown at a fixed offset from UTC, which the
// shell takes from the browser, so a snapshot renders the same on every machine.

const DASH = '—';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** `850ms`, `1.2s`, `3m 4s` or `2h 5m`, and `—` for no duration. */
export function duration(ms: number | undefined): string {
  if (!isNumber(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/** `$0.31`, or `$0.004` below a cent, and `—` for no cost. */
export function cost(usd: number | undefined): string {
  if (!isNumber(usd)) return DASH;
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** `999`, `1.0k`, `12k`, `1.0m` or `12m`: a k count that rounds to 1000k is shown in millions. */
export function tokens(n: number | undefined): string {
  if (!isNumber(n)) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const shown = n < 10_000 ? (n / 1000).toFixed(1) : String(Math.round(n / 1000));
    return Number(shown) >= 1000 ? `${(n / 1_000_000).toFixed(1)}m` : `${shown}k`;
  }
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  return `${Math.round(n / 1_000_000)}m`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS` of `iso` at `offsetMinutes` east of UTC, and `—` for a missing or invalid time. */
export function clock(iso: string | undefined, offsetMinutes: number): string {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return DASH;
  const local = new Date(at + offsetMinutes * 60_000);
  return `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
}

/** How long before `now` (ms since the epoch) `iso` was: `12s ago`, `4m ago`, `3h ago`, `2d ago`, or `in 5m`. */
export function ago(iso: string | undefined, now: number): string {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return DASH;
  const ms = now - at;
  const span = Math.abs(ms);
  const amount =
    span < 60_000
      ? `${Math.floor(span / 1000)}s`
      : span < 3_600_000
        ? `${Math.floor(span / 60_000)}m`
        : span < 86_400_000
          ? `${Math.floor(span / 3_600_000)}h`
          : `${Math.floor(span / 86_400_000)}d`;
  return ms < 0 ? `in ${amount}` : `${amount} ago`;
}

/** `used` of `limit` as a percentage to one decimal, `5.4%`, and `—` without a limit. */
export function percent(used: number | undefined, limit: number | undefined): string {
  if (!isNumber(used) || !isNumber(limit) || limit <= 0) return DASH;
  return `${Number(((used / limit) * 100).toFixed(1))}%`;
}

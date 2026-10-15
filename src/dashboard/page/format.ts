// The formats the views share: durations, dollars, token counts, clock times and ages. Pure, and built by hand rather
// than through Intl, so every Bun gives the same strings. A time of day is shown at a fixed offset from UTC, which the
// shell takes from the browser, so a snapshot renders the same on every machine.
//
// Stub (TASK-001): signatures only.

/** `850ms`, `1.2s`, `3m 4s` or `2h 5m`, and `—` for no duration. */
export function duration(_ms: number | undefined): string {
  return '';
}

/** `$0.31`, or `$0.004` below a cent, and `—` for no cost. */
export function cost(_usd: number | undefined): string {
  return '';
}

/** `999`, `1.0k`, `12k`, `1.0m` or `12m`: a k count that rounds to 1000k is shown in millions. */
export function tokens(_n: number | undefined): string {
  return '';
}

/** `HH:MM:SS` of `iso` at `offsetMinutes` east of UTC, and `—` for a missing or invalid time. */
export function clock(_iso: string | undefined, _offsetMinutes: number): string {
  return '';
}

/** How long before `now` (ms since the epoch) `iso` was: `12s ago`, `4m ago`, `3h ago`, `2d ago`, or `in 5m`. */
export function ago(_iso: string | undefined, _now: number): string {
  return '';
}

/** `used` of `limit` as a percentage to one decimal, `5.4%`, and `—` without a limit. */
export function percent(_used: number | undefined, _limit: number | undefined): string {
  return '';
}

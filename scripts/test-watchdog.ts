// The helpers of scripts/test.ts's silence watchdog: whether it runs and after how long, and a process's tree out of a
// `ps` listing. A `bun test` worker blocked in a synchronous call never reaches its own timeout, so the launcher watches
// the output of the whole run instead.

/** The seconds without output after which a run is stopped, on CI or when SAIL_TEST_SILENCE_SECONDS is no number. */
export const SILENCE_SECONDS = 600;

/** The silence limit in seconds, or undefined when the watchdog is off: it runs on CI, or when SAIL_TEST_SILENCE_SECONDS is set, and `0` turns it off. */
export function silenceSeconds(env: Record<string, string | undefined>): number | undefined {
  const given = env.SAIL_TEST_SILENCE_SECONDS?.trim();
  if (given) {
    const seconds = Number(given);
    if (seconds === 0) return undefined;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : SILENCE_SECONDS;
  }
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false' ? SILENCE_SECONDS : undefined;
}

/** The lines of a `pid ppid etime stat command` listing that belong to `root`'s tree, the root first and each child after its parent. */
export function descendants(ps: string, root: number): string[] {
  const rows = new Map<number, { line: string; children: number[] }>();
  const parents: [number, number][] = [];
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S/.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { line, children: [] });
    parents.push([Number(match[1]), Number(match[2])]);
  }
  for (const [pid, parent] of parents) rows.get(parent)?.children.push(pid);
  const found: string[] = [];
  const seen = new Set<number>();
  const walk = (pid: number) => {
    const row = rows.get(pid);
    if (!row || seen.has(pid)) return;
    seen.add(pid);
    found.push(row.line);
    for (const child of row.children) walk(child);
  };
  walk(root);
  return found;
}

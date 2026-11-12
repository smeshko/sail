// The helpers of scripts/test.ts's silence watchdog: whether it runs and after how long, and a process's tree out of a
// `ps` listing. A `bun test` worker blocked in a synchronous call never reaches its own timeout, so the launcher watches
// the output of the whole run instead. It also holds the start markers: one file per worker, naming the test file it is in.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

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

/** The variable that names the directory of the start markers, set by the launcher while the watchdog is on. */
export const RUNNING_ENV = 'SAIL_TEST_RUNNING';

/** Records that the worker `pid` is running `file`, replacing its earlier marker. A diagnostic: it never throws. */
export function markStarted(dir: string | undefined, pid: number, file: string): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, String(pid)), file);
  } catch {
    // a marker is a diagnostic; a failed write must not fail a test file
  }
}

/** Removes the worker's marker, only while it still names `file`. Never throws. */
export function markEnded(dir: string | undefined, pid: number, file: string): void {
  if (!dir) return;
  try {
    const marker = join(dir, String(pid));
    if (readFileSync(marker, 'utf8') === file) rmSync(marker);
  } catch {
    // already gone, or unreadable
  }
}

/** The markers in `dir`: each file named by a pid, with its content. Empty when `dir` is missing or unreadable. */
export function runningFiles(dir: string): Map<number, string> {
  const found = new Map<number, string>();
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        found.set(Number(name), readFileSync(join(dir, name), 'utf8'));
      } catch {
        // removed meanwhile
      }
    }
  } catch {
    return new Map();
  }
  return found;
}

/** For each `ps` line of `tree` whose pid has a marker, `  <pid>  <path>`, the path relative to `cwd` when under it. */
export function workerFiles(tree: readonly string[], files: ReadonlyMap<number, string>, cwd: string): string[] {
  const lines: string[] = [];
  for (const line of tree) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    const file = files.get(pid);
    if (file === undefined) continue;
    const rel = relative(cwd, file);
    lines.push(`  ${pid}  ${rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file}`);
  }
  return lines;
}

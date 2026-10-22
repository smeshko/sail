// What the real-process tests share: `sail` run as a process of its own from a temp repository, waits on a condition
// bounded at a minute, and a kill that signals one pid and never a group. Killing a process group is the known EPERM
// flake on macOS (a group whose members are exiting), so nothing here takes a group.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStatus } from '../../src/engine/run-dir';

/** This checkout's bin, run on the Bun that runs the tests. */
export const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

/** How long any wait in a real-process test lasts at most. */
export const WAIT_MS = 60_000;

export interface SailProcess {
  pid: number;
  exited: Promise<number>;
  readonly exitCode: number | null;
  /** Everything it printed to stdout and stderr, once it has exited. */
  output(): Promise<{ stdout: string; stderr: string }>;
}

/** Starts `sail <argv>` in `cwd` with `env`, its output piped and kept. */
export function sailProcess(cwd: string, env: Readonly<Record<string, string>>, argv: readonly string[]): SailProcess {
  const child = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd,
    env: { ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    pid: child.pid,
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    output: async () => ({ stdout: await stdout, stderr: await stderr }),
  };
}

/** Runs `sail <argv>` to its end: its exit code and what it printed. */
export async function sail(
  cwd: string,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = sailProcess(cwd, env, argv);
  const code = await child.exited;
  return { code, ...(await child.output()) };
}

/** Waits until `ready` holds, looking every 200 ms, for at most `WAIT_MS`: `what`, or that it didn't happen. */
export async function until(what: string, ready: () => boolean): Promise<string> {
  const deadline = performance.now() + WAIT_MS;
  while (!ready()) {
    if (performance.now() > deadline) return `${what} did not happen within ${WAIT_MS / 1000} s`;
    await Bun.sleep(200);
  }
  return what;
}

/** Whether `pid` names a live process. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Sends `signal` to the one process `pid`, never its group. A process already gone is fine. */
export function killOne(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Waits for `pid` to be gone, for at most `WAIT_MS`: true once it is. */
export async function gone(pid: number): Promise<boolean> {
  return (await until(`pid ${pid} ending`, () => !alive(pid))) === `pid ${pid} ending`;
}

/** A run in `runs`, by its run.json, with its STATUS and its events: none until a run has written its header. */
export interface RunOnDisk {
  runId: string;
  workflow: string;
  ticketKey: string;
  via: string;
  startedAt: string;
  status: string;
  events: { type: string; ts: string; [field: string]: unknown }[];
}

/** The runs in `runs`, oldest first. */
export function runsIn(runs: string): RunOnDisk[] {
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((name) => existsSync(join(runs, name, 'run.json')))
    .map((runId) => {
      const dir = join(runs, runId);
      const header = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
      let status = 'starting';
      try {
        const read = readStatus(dir);
        status = read.stopReason === undefined ? read.status : `${read.status} ${read.stopReason}`;
      } catch {
        // No STATUS yet.
      }
      const events = existsSync(join(dir, 'events.ndjson'))
        ? readFileSync(join(dir, 'events.ndjson'), 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line))
        : [];
      return {
        runId,
        workflow: header.workflow.name,
        ticketKey: header.source.ticketKey,
        via: header.source.via,
        startedAt: header.startedAt,
        status,
        events,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

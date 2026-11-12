// Standing workspaces: where one lives and who holds it.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dropStanding,
  heldByRun,
  readStanding,
  STANDING_DIR,
  standingDir,
  standingOf,
  standingPath,
  takeStanding,
} from '../../../src/adapters/workspace/standing';
import { type Status, writeStatus } from '../../../src/engine/run-dir';

const NOW = new Date('2026-11-01T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-standing-'));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** A holder for run `runId` whose run directory holds `status` (none when left out), and whose pid is `pid`. */
function holder(runId: string, pid: number, status?: Status, withDir = true) {
  const runDir = join(tempDir(), runId);
  if (withDir) {
    mkdirSync(runDir);
    if (status === 'failed') writeStatus(runDir, status, 'workflow_failed');
    else if (status === 'suspended') writeStatus(runDir, status, 'interrupted');
    else if (status !== undefined) writeStatus(runDir, status);
  }
  return { runId, runDir, pid };
}

test('a free standing directory is taken, a second run is refused it naming the holder, and the holder renews it', () => {
  const dir = standingDir(tempDir(), 'demo', 0);
  const first = holder('run-a', process.pid);
  expect(takeStanding(dir, first, NOW)).toEqual({ taken: true });
  const second = takeStanding(dir, holder('run-b', process.pid), NOW);
  expect(second.taken).toBe(false);
  if (!second.taken) expect(second.holder.runId).toBe('run-a');
  expect(takeStanding(dir, { ...first, pid: process.pid + 1 }, NOW)).toEqual({ taken: true });
  expect(readStanding(dir)?.pid).toBe(process.pid + 1);
});

test('a lease whose run completed or failed is taken over, and took names that run', () => {
  for (const status of ['completed', 'failed'] as const) {
    const dir = standingDir(tempDir(), 'demo', 0);
    takeStanding(dir, holder('old', process.pid, status), NOW);
    const result = takeStanding(dir, holder('new', process.pid), NOW);
    expect(result.taken).toBe(true);
    if (result.taken) expect(result.took?.runId).toBe('old');
    expect(readStanding(dir)?.runId).toBe('new');
  }
});

test('a lease whose run is suspended, or running with a dead pid, is refused', async () => {
  const dead = await deadPid();
  for (const status of ['suspended', 'running'] as const) {
    const dir = standingDir(tempDir(), 'demo', 0);
    takeStanding(dir, holder('old', dead, status), NOW);
    const result = takeStanding(dir, holder('new', process.pid), NOW);
    expect(result.taken).toBe(false);
    expect(readStanding(dir)?.runId).toBe('old');
  }
});

test('a lease with no run directory and a dead pid is taken over, with a live pid it is held', async () => {
  const dead = await deadPid();
  const dir = standingDir(tempDir(), 'demo', 0);
  takeStanding(dir, holder('old', dead, undefined, false), NOW);
  expect(takeStanding(dir, holder('new', process.pid), NOW).taken).toBe(true);
  const other = standingDir(tempDir(), 'demo', 0);
  takeStanding(other, holder('old', process.pid, undefined, false), NOW);
  expect(takeStanding(other, holder('new', process.pid), NOW).taken).toBe(false);
});

test('dropStanding by a run that does not hold the lease leaves it', () => {
  const dir = standingDir(tempDir(), 'demo', 0);
  takeStanding(dir, holder('run-a', process.pid), NOW);
  expect(dropStanding(dir, 'run-b')).toBe(false);
  expect(heldByRun(dir, 'run-a')).toBe(true);
  expect(dropStanding(dir, 'run-a')).toBe(true);
  expect(existsSync(join(dir, 'LEASE'))).toBe(false);
  expect(heldByRun(dir, 'run-a')).toBe(false);
});

test('standingPath is the workspace folder of a standing directory', () => {
  const runs = tempDir();
  expect(standingPath(runs, 'demo', 1)).toBe(join(runs, STANDING_DIR, 'demo-1', 'workspace'));
  expect(standingOf(runs, standingPath(runs, 'demo', 1))).toBe(standingDir(runs, 'demo', 1));
});

test('standingOf is undefined for a run workspace, a path outside standing/ and one nested deeper', () => {
  const runs = tempDir();
  expect(standingOf(runs, join(runs, 'ADW-1-x', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, 'elsewhere', 'demo-0', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'demo-0', 'deeper', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'demo-0', 'other'))).toBeUndefined();
});

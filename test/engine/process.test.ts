import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProcessEnd, type ProcessOptions, runProcess, stopGroup } from '../../src/engine/process';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scratch {
  dir: string;
  options: (command: string[], more?: Partial<ProcessOptions>) => ProcessOptions;
  script: (name: string, body: string, mode?: number) => string;
  log: (name: 'stdout' | 'stderr') => string;
}

function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), 'sail-process-'));
  dirs.push(dir);
  return {
    dir,
    options: (command, more = {}) => ({
      command,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdout: join(dir, 'stdout.log'),
      stderr: join(dir, 'stderr.log'),
      timeoutMs: 10_000,
      graceMs: 500,
      ...more,
    }),
    script: (name, body, mode = 0o755) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/bash\n${body}\n`);
      chmodSync(path, mode);
      return path;
    },
    log: (name) => readFileSync(join(dir, `${name}.log`), 'utf8'),
  };
}

/** True while `pid` names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

const pidIn = (path: string): number => Number(readFileSync(path, 'utf8').trim());

async function timed(options: ProcessOptions): Promise<{ end: ProcessEnd; ms: number }> {
  const started = performance.now();
  const end = await runProcess(options);
  return { end, ms: performance.now() - started };
}

test('the exit code is reported, and stdout and stderr land in their logs', async () => {
  const s = scratch();
  const end = await runProcess(s.options(['bash', '-c', 'echo out; echo err >&2; exit 3']));
  expect(end).toEqual({ started: true, code: 3, signal: null, timedOut: false, aborted: false });
  expect(s.log('stdout')).toBe('out\n');
  expect(s.log('stderr')).toBe('err\n');
});

test('the command runs from cwd with only the environment it is given', async () => {
  const s = scratch();
  const end = await runProcess(
    s.options(['bash', '-c', 'pwd -P; echo "${ONLY}:${HOME:-unset}"'], {
      env: { PATH: process.env.PATH ?? '', ONLY: 'yes' },
    }),
  );
  expect(end).toMatchObject({ code: 0 });
  expect(s.log('stdout')).toBe(`${realpathSync(s.dir)}\nyes:unset\n`);
});

test('a timeout stops the group with SIGTERM', async () => {
  const s = scratch();
  const { end, ms } = await timed(s.options(['sleep', '5'], { timeoutMs: 1000 }));
  console.log(`timeout: ${Math.round(ms)} ms`);
  expect(end).toEqual({ started: true, code: null, signal: 'SIGTERM', timedOut: true, aborted: false });
  expect(ms).toBeLessThan(3500);
});

test('a script that ignores SIGTERM is killed after the grace period', async () => {
  const s = scratch();
  const run = s.script('stubborn.sh', "trap '' TERM\nsleep 5");
  const { end, ms } = await timed(s.options([run], { timeoutMs: 500, graceMs: 500 }));
  console.log(`SIGKILL after grace: ${Math.round(ms)} ms`);
  expect(end).toMatchObject({ started: true, code: null, signal: 'SIGKILL', timedOut: true });
  expect(ms).toBeGreaterThanOrEqual(1000);
  expect(ms).toBeLessThan(3500);
});

test('a background grandchild dies with the group on a timeout', async () => {
  const s = scratch();
  const pidFile = join(s.dir, 'grandchild.pid');
  const run = s.script('spawner.sh', `sleep 30 &\necho $! > "${pidFile}"\nsleep 5`);
  const { end } = await timed(s.options([run], { timeoutMs: 1000 }));
  expect(end).toMatchObject({ timedOut: true });
  expect(alive(pidIn(pidFile))).toBe(false);
});

test('whatever a script leaves running is stopped once it exits', async () => {
  const s = scratch();
  const pidFile = join(s.dir, 'leftover.pid');
  const run = s.script('leaver.sh', `sleep 30 &\necho $! > "${pidFile}"\nexit 0`);
  const { end, ms } = await timed(s.options([run]));
  console.log(`leftover stopped: ${Math.round(ms)} ms`);
  expect(end).toEqual({ started: true, code: 0, signal: null, timedOut: false, aborted: false });
  expect(ms).toBeLessThan(2000);
  expect(alive(pidIn(pidFile))).toBe(false);
});

test.each([
  ['a missing command', (s: Scratch) => join(s.dir, 'missing.sh')],
  ['a file without execute permission', (s: Scratch) => s.script('plain.sh', 'exit 0', 0o644)],
])('%s does not start, and leaves empty logs and no open descriptor', async (_, command) => {
  const s = scratch();
  const openBefore = readdirSync('/dev/fd').length;
  const end = await runProcess(s.options([command(s)]));
  expect(end.started).toBe(false);
  expect(end).toMatchObject({ message: expect.stringMatching(/\S/) });
  expect(readdirSync('/dev/fd').length).toBe(openBefore);
  expect(s.log('stdout')).toBe('');
  expect(s.log('stderr')).toBe('');
});

test('an abort stops the group well before the timeout', async () => {
  const s = scratch();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const { end, ms } = await timed(s.options(['sleep', '5'], { signal: controller.signal }));
  console.log(`abort: ${Math.round(ms)} ms`);
  expect(end).toEqual({ started: true, code: null, signal: 'SIGTERM', timedOut: false, aborted: true });
  expect(ms).toBeLessThan(2000);
});

test('a signal aborted before the call stops the command at once', async () => {
  const s = scratch();
  const { end, ms } = await timed(s.options(['sleep', '5'], { signal: AbortSignal.abort() }));
  expect(end).toMatchObject({ signal: 'SIGTERM', aborted: true });
  expect(ms).toBeLessThan(1000);
});

test('stopping a group that is already gone does nothing', async () => {
  const child = Bun.spawn(['true'], { detached: true });
  await child.exited;
  const started = performance.now();
  await stopGroup(child.pid, 5000);
  expect(performance.now() - started).toBeLessThan(500);
});

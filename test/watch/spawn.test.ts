// Spawning a dispatched run (DECISIONS D10), and a resume of one (13.3's D5): a process in a session of its own, run
// where `.sail/` is, in the environment it is given, writing both its streams to its dispatch log. Each child exits on its own: nothing here
// signals a process.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchLog, lastLine, spawnResume, spawnRun } from '../../src/watch/spawn';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-spawn-')));
  dirs.push(dir);
  return dir;
}

const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** A stand-in for `sail`: prints its arguments, cwd, process group and a variable, one per line, then exits 3. */
function fakeSail(dir: string): string {
  const script = join(dir, 'fake-sail.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'echo "argv: $*"',
      'echo "cwd: $(pwd -P)"',
      'echo "pgid: $(ps -o pgid= -p $$ | tr -d " ")"',
      'echo "pid: $$"',
      'echo "mark: $SAIL_SPAWN_MARK home: $HOME"',
      'echo "to stderr" >&2',
      'echo',
      'exit 3',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return script;
}

test('a spawned run gets the ticket, its workflow and --dispatch with the run id, runs in the root with the given env in a process group of its own, and logs both streams', async () => {
  const dir = tempDir();
  const root = join(dir, 'repo');
  mkdirSync(root);
  const runs = join(root, '.sail-runs');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), SAIL_SPAWN_MARK: 'dispatched' };
  const spawned = spawnRun({
    root,
    runsDir: runs,
    workflow: 'a',
    ticketKey: 'FAKE-1',
    runId: RUN,
    env,
    cli: ['/bin/sh', fakeSail(dir)],
  });
  expect(spawned.pid).toBeGreaterThan(0);
  expect(await spawned.exited).toBe(3);
  const log = dispatchLog(runs, 'a', RUN);
  expect(log).toBe(join(runs, 'queue', 'a', 'dispatch', `${RUN}.log`));
  expect(existsSync(log)).toBe(true);
  const lines = readFileSync(log, 'utf8').split('\n');
  expect(lines.filter((line) => !line.startsWith('pgid') && !line.startsWith('pid'))).toEqual([
    `argv: FAKE-1 --workflow a --dispatch ${RUN}`,
    `cwd: ${root}`,
    `mark: dispatched home: ${join(dir, 'home')}`,
    'to stderr',
    '',
    '',
  ]);
  const pgid = Number(lines.find((line) => line.startsWith('pgid: '))?.slice('pgid: '.length));
  expect([pgid, Number(lines.find((line) => line.startsWith('pid: '))?.slice('pid: '.length))]).toEqual([
    spawned.pid,
    spawned.pid,
  ]);
  expect(pgid).not.toBe(Number(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout.toString()));
});

test('a forced dispatched run gets --force last on its command line', async () => {
  const dir = tempDir();
  const root = join(dir, 'repo');
  mkdirSync(root);
  const runs = join(root, '.sail-runs');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), SAIL_SPAWN_MARK: 'forced' };
  const spawned = spawnRun({
    root,
    runsDir: runs,
    workflow: 'a',
    ticketKey: 'FAKE-3',
    runId: RUN,
    env,
    cli: ['/bin/sh', fakeSail(dir)],
    force: true,
  });
  expect(await spawned.exited).toBe(3);
  expect(readFileSync(dispatchLog(runs, 'a', RUN), 'utf8').split('\n')[0]).toBe(
    `argv: FAKE-3 --workflow a --dispatch ${RUN} --force`,
  );
});

test('lastLine gives the last line that is not blank, cut to 500 characters, and nothing for an empty or missing log', () => {
  const dir = tempDir();
  const log = join(dir, 'run.log');
  writeFileSync(log, `first\n  the refusal  \n\n   \n`);
  const long = join(dir, 'long.log');
  writeFileSync(long, `${'x'.repeat(600)}\n`);
  const empty = join(dir, 'empty.log');
  writeFileSync(empty, '\n\n');
  expect([lastLine(log), lastLine(long), lastLine(empty), lastLine(join(dir, 'missing.log'))]).toEqual([
    'the refusal',
    'x'.repeat(500),
    undefined,
    undefined,
  ]);
});

test("a spawned resume gets resume and the run id, runs in the root in a process group of its own, and appends to the run's dispatch log", async () => {
  const dir = tempDir();
  const root = join(dir, 'repo');
  mkdirSync(root);
  const runs = join(root, '.sail-runs');
  const log = dispatchLog(runs, 'a', RUN);
  mkdirSync(join(runs, 'queue', 'a', 'dispatch'), { recursive: true });
  writeFileSync(log, 'what the dispatched run printed\n');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), SAIL_SPAWN_MARK: 'resumed' };
  const spawned = spawnResume({ root, runsDir: runs, workflow: 'a', runId: RUN, env, cli: ['/bin/sh', fakeSail(dir)] });
  expect(await spawned.exited).toBe(3);
  const lines = readFileSync(log, 'utf8').split('\n');
  expect(lines.filter((line) => !line.startsWith('pgid') && !line.startsWith('pid'))).toEqual([
    'what the dispatched run printed',
    `argv: resume ${RUN}`,
    `cwd: ${root}`,
    `mark: resumed home: ${join(dir, 'home')}`,
    'to stderr',
    '',
    '',
  ]);
  const pgid = Number(lines.find((line) => line.startsWith('pgid: '))?.slice('pgid: '.length));
  expect([pgid, spawned.pid > 0]).toEqual([spawned.pid, true]);
});

// A machine for the dashboard's tests: a temporary SAIL_HOME whose registry holds two clones, `alpha` and `beta`, each
// with an empty `.sail/` and a copy of the golden run in its `.sail-runs/`, plus a directory outside every clone that
// holds a secret, for the escapes to aim at. The entries are written by hand, so the setup doesn't lean on the
// registry module under test.
//
// `seedFixtures()` is the same machine with the dashboard's recorded fixtures instead: alpha holds the golden run and
// FAKE-2 (failed, with a denial), and beta holds FAKE-3 (suspended, with a stage the fixture repository doesn't have)
// and the queue of its watched `ticket-to-pr`. `test/fixtures/dashboard/<repo>/` holds what each clone's `.sail-runs/`
// holds.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyGoldenRun, GOLDEN_RUN, GOLDEN_RUN_ID } from './golden-run';

export { GOLDEN_RUN, GOLDEN_RUN_ID };

export const SECRET = 'SECRET-6c1f0e: nothing outside a run directory may be served';

export interface Clone {
  name: string;
  clone: string;
  sailDir: string;
  /** The golden run's copy in this clone. */
  runDir: string;
}

export interface Machine {
  root: string;
  sailHome: string;
  registryDir: string;
  alpha: Clone;
  beta: Clone;
  /** A directory outside every clone: `secret.txt`, and `result.json`, `session.log` and `stdout.log` holding SECRET. */
  outside: string;
  remove(): void;
}

/** Registers a clone named `name` under `root`, with a copy of the golden run, by writing its entry by hand. */
export function addClone(root: string, registryDir: string, name: string): Clone {
  return register(root, registryDir, name, copyGoldenRun);
}

/** Registers a clone named `name` under `root` by writing its entry by hand, after `fill` has put its runs in. */
function register(root: string, registryDir: string, name: string, fill: (clone: string) => string): Clone {
  const clone = join(root, name);
  const sailDir = join(clone, '.sail');
  mkdirSync(sailDir, { recursive: true });
  const runDir = fill(clone);
  mkdirSync(registryDir, { recursive: true });
  const entry = {
    schema: 'sail.registry.v1',
    name,
    remote: `https://example.com/${name}.git`,
    clone,
    sailDir,
    updatedAt: '2026-10-14T09:00:00.000Z',
  };
  writeFileSync(join(registryDir, `${name}.json`), `${JSON.stringify(entry)}\n`);
  return { name, clone, sailDir, runDir };
}

/** A temp root with its SAIL_HOME and the directory outside every clone. */
function machineRoot(): { root: string; sailHome: string; registryDir: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-dashboard-')));
  const sailHome = join(root, 'sail-home');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  for (const name of ['secret.txt', 'result.json', 'session.log', 'stdout.log']) {
    writeFileSync(join(outside, name), `${SECRET}\n`);
  }
  return { root, sailHome, registryDir: join(sailHome, 'watchers'), outside };
}

export function machine(): Machine {
  const { root, sailHome, registryDir, outside } = machineRoot();
  return {
    root,
    sailHome,
    registryDir,
    alpha: addClone(root, registryDir, 'alpha'),
    beta: addClone(root, registryDir, 'beta'),
    outside,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The dashboard's recorded fixtures: what each clone's `.sail-runs/` holds. */
export const DASHBOARD_FIXTURES = join(import.meta.dir, '..', 'fixtures', 'dashboard');
export const FAKE_2_ID = 'FAKE-2-01M36VAD801GH3GKJTE239SCP8';
export const FAKE_3_ID = 'FAKE-3-01M39H4ZW0S46MV303CFX3T4PY';
/** The watched workflow whose queue beta holds. */
export const QUEUE_WORKFLOW = 'ticket-to-pr';
/** The id of the running copy `runningCopy()` makes. */
export const RUNNING_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD9Z';

/** Copies the recorded `.sail-runs/` of `repo` into `clone`, and gives the run directory of `runId` in it. */
function copyFixture(repo: 'alpha' | 'beta', runId: string) {
  return (clone: string): string => {
    cpSync(join(DASHBOARD_FIXTURES, repo), join(clone, '.sail-runs'), { recursive: true });
    return join(clone, '.sail-runs', runId);
  };
}

/**
 * A machine whose registry holds alpha, with the golden run and FAKE-2, and beta, with FAKE-3 and its queue. alpha's
 * `runDir` is its golden run, and beta's is FAKE-3.
 */
export function seedFixtures(): Machine {
  const { root, sailHome, registryDir, outside } = machineRoot();
  const alpha = register(root, registryDir, 'alpha', (clone) => {
    copyFixture('alpha', FAKE_2_ID)(clone);
    return copyGoldenRun(clone);
  });
  const beta = register(root, registryDir, 'beta', copyFixture('beta', FAKE_3_ID));
  return {
    root,
    sailHome,
    registryDir,
    alpha,
    beta,
    outside,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** FAKE-2's run directory in a seeded machine. */
export const fake2Dir = (m: Machine): string => join(m.alpha.clone, '.sail-runs', FAKE_2_ID);

/** beta's queue directory in a seeded machine. */
export const queueDirOf = (m: Machine): string => join(m.beta.clone, '.sail-runs', 'queue', QUEUE_WORKFLOW);

/**
 * A copy of the golden run in alpha that is still running: STATUS `running` and the golden run's first `count` events.
 * `rest` is the lines still to append.
 */
export function runningCopy(m: Machine, count: number): { dir: string; rest: string[] } {
  const dir = copyGoldenRun(m.alpha.clone, { runId: RUNNING_ID, status: 'running\n' });
  const lines = eventLines(dir);
  writeFileSync(
    join(dir, 'events.ndjson'),
    lines
      .slice(0, count)
      .map((line) => `${line}\n`)
      .join(''),
  );
  return { dir, rest: lines.slice(count) };
}

/** The registry entry `addClone()` wrote for `clone`, as the registry reads it. */
export function entryOf(clone: Clone) {
  return {
    schema: 'sail.registry.v1' as const,
    name: clone.name,
    remote: `https://example.com/${clone.name}.git`,
    clone: clone.clone,
    sailDir: clone.sailDir,
    updatedAt: '2026-10-14T09:00:00.000Z',
  };
}

/** A hash of every path, file content, mode and symlink target under `dirs`: what a read must leave as it was. */
export function treeHash(...dirs: string[]): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(`${path}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  for (const dir of dirs) walk(dir);
  return hash.digest('hex');
}

/** The run's events file, as lines. */
export const eventLines = (runDir: string): string[] =>
  readFileSync(join(runDir, 'events.ndjson'), 'utf8').split('\n').slice(0, -1);

/**
 * Appends a call's end to the run's events: a `sail.event.v1` line of `type` with the next `seq`, so `readEvents()`
 * keeps it. `fields` are the payload beside the envelope.
 */
export function appendEvent(runDir: string, type: string, fields: Record<string, unknown>): void {
  const lines = eventLines(runDir);
  const last = JSON.parse(lines.at(-1) ?? '{}');
  const event = { seq: last.seq + 1, ts: '2026-09-25T09:00:30.000Z', type, runId: last.runId, ...fields };
  appendFileSync(join(runDir, 'events.ndjson'), `${JSON.stringify(event)}\n`);
}

/** A stage call's end pointing at `resultPath`, which is what the dashboard follows to a call's files. */
export function appendStageEnd(runDir: string, key: string, resultPath: string): void {
  const [stage = '', call = '1'] = key.split('#');
  appendEvent(runDir, 'stage:end', {
    key,
    stage,
    call: Number(call),
    try: 1,
    outcome: 'done',
    durationMs: 10,
    resultPath,
  });
}

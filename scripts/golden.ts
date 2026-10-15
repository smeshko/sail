// Generates the golden run: the run directory under test/fixtures/runs/, and the four terminal views of its events
// under test/fixtures/terminal/. The golden run is what the engine writes for the fixture repository's `ticket-to-pr`
// on `FAKE-1`, on the fakes. Nobody edits it by hand: `bun run golden` rewrites it after a change to what a run writes,
// and test/scripts/golden.test.ts fails while the committed one is stale.
//
// The same run writes the same bytes on every machine, since nothing it records is the machine's: every time is read
// from one clock that steps 100 ms a reading, the run id's random part is fixed bytes, and the commit `open` pushes has
// a fixed author, committer and dates, so its sha is fixed too. One field is left to the machine: `run.json`'s
// `sail.runtime`, the Bun that generated.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BUILTINS } from '../src/adapters/index';
import { resolveAdapters } from '../src/engine/adapters';
import { readConfig } from '../src/engine/config';
import { runWorkflow } from '../src/engine/runtime';
import { formatIssue } from '../src/engine/schemas';
import { readEvents } from '../src/events/consumers/ndjson';
import { terminalConsumer, type Verbosity } from '../src/events/consumers/terminal';
import type { SailEvent } from '../src/events/types';

const root = join(import.meta.dir, '..');
const FIXTURE_SAIL = join(root, 'test', 'fixtures', 'repo', '.sail');
const RUNS = join(root, 'test', 'fixtures', 'runs');
const VIEWS = join(root, 'test', 'fixtures', 'terminal');

/** The golden run's id: its ticket key, then the ULID of `START` and `RANDOM`. */
export const GOLDEN_RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
export const VERBOSITIES: readonly Verbosity[] = ['quiet', 'normal', 'verbose', 'trace'];

/** The clock's first reading, and how far each reading is after the last. */
const START = Date.parse('2026-09-25T09:00:00.000Z');
const STEP_MS = 100;
/** The run id's random part. */
const RANDOM = [69, 201, 163, 108, 93, 196, 139, 62, 52, 117];

/** The one commit of the repository the run works in: `open` pushes it, so its sha is in the run directory. */
const COMMIT = {
  GIT_AUTHOR_NAME: 'sail fixture',
  GIT_AUTHOR_EMAIL: 'fixture@sail.invalid',
  GIT_AUTHOR_DATE: '2026-09-25T08:00:00Z',
  GIT_COMMITTER_NAME: 'sail fixture',
  GIT_COMMITTER_EMAIL: 'fixture@sail.invalid',
  GIT_COMMITTER_DATE: '2026-09-25T08:00:00Z',
};
const README = '# greet\n\nThe repository the fixture run works in.\n';

/** Runs git in `cwd` with no config of the machine, and throws with its stderr when it fails. */
function git(cwd: string, home: string, ...args: string[]): void {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...COMMIT,
  };
  const result = Bun.spawnSync(['git', ...args], { cwd, env });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`);
}

/** Every file under `dir`, relative to it, sorted. */
export function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Runs the fixture repository's `ticket-to-pr` on `FAKE-1`, in a temporary repository of its own, and leaves the run
 * directory in `outDir` as ordinary, writable files. It throws when the run doesn't complete under the golden run's
 * id.
 */
export async function generateGoldenRun(outDir: string): Promise<void> {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sail-golden-')));
  try {
    const repo = join(temp, 'repo');
    const home = join(temp, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    git(repo, home, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), README);
    git(repo, home, 'add', 'README.md');
    git(repo, home, 'commit', '--quiet', '-m', 'initial');
    const sailDir = join(repo, '.sail');
    cpSync(FIXTURE_SAIL, sailDir, { recursive: true });

    // One clock for the run and the fakes: each reading is 100 ms after the last, whoever reads.
    let readings = 0;
    const clock = (): Date => new Date(START + readings++ * STEP_MS);
    const config = readConfig(sailDir);
    if ('issues' in config) throw new Error(`the fixture's project.yaml: ${config.issues.map(formatIssue).join('; ')}`);
    const adapters = await resolveAdapters({ sailDir, config, builtins: BUILTINS, env: process.env, now: clock });
    if ('issues' in adapters) throw new Error(`the fixture's adapters: ${adapters.issues.map(formatIssue).join('; ')}`);
    const end = await runWorkflow({
      cwd: repo,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters,
      clock,
      random: (bytes) => {
        bytes.set(RANDOM);
        return bytes;
      },
    });
    if ('refused' in end) throw new Error(`the fixture's run was refused: ${end.refused}`);
    if (end.status !== 'completed' || end.runId !== GOLDEN_RUN_ID) {
      throw new Error(`the fixture's run ${end.runId} ended ${end.status}: ${end.message ?? 'under another id'}`);
    }

    rmSync(outDir, { recursive: true, force: true });
    cpSync(end.dir, outDir, { recursive: true });
    // run.json is read-only where the run wrote it. A fixture is data: a test copies it and rewrites the copy.
    for (const file of filesIn(outDir)) chmodSync(join(outDir, file), 0o644);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * What `events` print at `verbosity`, in plain mode. A view shows the tail of a failed script's log, which it reads
 * from the run directory under `runsDir`: the committed golden run's unless given.
 */
export function renderView(events: readonly SailEvent[], verbosity: Verbosity, runsDir: string = RUNS): string {
  let out = '';
  const terminal = terminalConsumer({
    verbosity,
    write: (text) => {
      out += text;
    },
    runsDir,
    shownRunsDir: '.sail-runs',
  });
  for (const event of events) terminal.onEvent(event);
  return out;
}

/** The time the dashboard's views are rendered at, and the clock offset their times are shown at. */
export const VIEWS_NOW = Date.parse('2026-10-01T12:00:00.000Z');

/**
 * Renders every view of the dashboard's recorded fixtures into `outDir`, as fragments, and gives the files written. The
 * machine is seeded afresh, and nothing absolute of it is ever rendered, so the views are the same on every machine.
 *
 * Stub (TASK-007): renders nothing.
 */
export function renderDashboardViews(_outDir: string): string[] {
  return [];
}

if (import.meta.main) {
  const dir = join(RUNS, GOLDEN_RUN_ID);
  await generateGoldenRun(dir);
  for (const file of filesIn(dir)) console.log(relative(root, join(dir, file)));
  const events = readEvents(dir);
  for (const verbosity of VERBOSITIES) {
    const view = join(VIEWS, `${verbosity}.txt`);
    writeFileSync(view, renderView(events, verbosity));
    console.log(relative(root, view));
  }
}

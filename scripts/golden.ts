// Generates the golden run: the run directory under test/fixtures/runs/, and the four terminal views of its events
// under test/fixtures/terminal/. Then it renders the dashboard's views of its recorded fixtures, with the golden run
// among them, under test/fixtures/dashboard/views/. The golden run is what the engine writes for the fixture
// repository's `ticket-to-pr` on `FAKE-1`, on the fakes. Nobody edits it by hand: `bun run golden` rewrites it after a
// change to what a run writes, and test/scripts/golden.test.ts fails while the committed one is stale.
//
// The same run writes the same bytes on every machine, since nothing it records is the machine's: every time is read
// from one clock that steps 100 ms a reading, the run id's random part is fixed bytes, and the commit `open` pushes has
// a fixed author, committer and dates, so its sha is fixed too. One field is left to the machine: `run.json`'s
// `sail.runtime`, the Bun that generated.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { BUILTINS } from '../src/adapters/index';
import { recordingHarness, writeJournalKeys } from '../src/adapters/recording';
import { index } from '../src/dashboard/files';
import { attention } from '../src/dashboard/page/attention';
import { renderAttention } from '../src/dashboard/page/attention-view';
import type { SafeHtml } from '../src/dashboard/page/html';
import { queuePanels, railRepos, watchState } from '../src/dashboard/page/index-model';
import { renderInspector } from '../src/dashboard/page/inspector-view';
import { queueId, renderQueues } from '../src/dashboard/page/queue-view';
import { renderRail } from '../src/dashboard/page/rail-view';
import { foldRun } from '../src/dashboard/page/run-model';
import { renderRun } from '../src/dashboard/page/run-view';
import { type InspectorTab, initialUi, type UiState } from '../src/dashboard/page/ui-state';
import { resolveAdapters } from '../src/engine/adapters';
import { type AdapterConfig, readConfig } from '../src/engine/config';
import { runWorkflow } from '../src/engine/runtime';
import { formatIssue } from '../src/engine/schemas';
import { readEvents } from '../src/events/consumers/ndjson';
import { terminalConsumer, type Verbosity } from '../src/events/consumers/terminal';
import type { QueueEvent, SailEvent } from '../src/events/types';
import { FAKE_2_ID, FAKE_3_ID, fake2Dir, QUEUE_WORKFLOW, queueDirOf, seedFixtures } from '../test/helpers/dashboard';

const root = join(import.meta.dir, '..');
const FIXTURE_SAIL = join(root, 'test', 'fixtures', 'repo', '.sail');
const RUNS = join(root, 'test', 'fixtures', 'runs');
const VIEWS = join(root, 'test', 'fixtures', 'terminal');
const DASHBOARD_VIEWS = join(root, 'test', 'fixtures', 'dashboard', 'views');
/** Recordings: the scripted run's, and each real set's. A set carries the `.sail/` it was recorded on, when it has one. */
export const SESSIONS = join(root, 'test', 'fixtures', 'sessions');
/** The golden run directory a recorded set plays back to, one folder per set. */
export const PLAYBACK = join(root, 'test', 'fixtures', 'playback');
/** The scripted golden run, recorded: `bun run golden` rewrites it, and test/playback.test.ts plays it back. */
export const SCRIPTED_SET = 'fake-1';

/** A set recorded from a real session, which `bun run golden` plays back into `PLAYBACK/<name>/`. */
export interface RecordedSet {
  readonly name: string;
  /** `warn` for a set whose prompts may drift, since a real set can't be recorded again at $0. */
  readonly onPromptMismatch: 'fail' | 'warn';
}
export const RECORDED_SETS: readonly RecordedSet[] = [{ name: 'fake-1-claude-code', onPromptMismatch: 'warn' }];

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

export interface GoldenOptions {
  /** A directory to record the run's agent sessions into, with `journal.txt`: the run's harness is wrapped. */
  readonly record?: string;
  /** The `.sail/` copied into the temporary repository: the fixture's when left out. */
  readonly sailDir?: string;
  /** Replaces the config's harness for this run, in memory only: `playback` plays a recording back. */
  readonly harness?: AdapterConfig;
}

/**
 * Runs the fixture repository's `ticket-to-pr` on `FAKE-1`, in a temporary repository of its own, and leaves the run
 * directory in `outDir` as ordinary, writable files. It throws when the run doesn't complete under the golden run's
 * id. With no options it is the scripted golden run: `record` records its sessions, and `sailDir` and `harness` let a
 * recorded set play back on the `.sail/` it was recorded on.
 */
export async function generateGoldenRun(outDir: string, options: GoldenOptions = {}): Promise<void> {
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
    cpSync(options.sailDir ?? FIXTURE_SAIL, sailDir, { recursive: true });

    // One clock for the run and the fakes: each reading is 100 ms after the last, whoever reads.
    let readings = 0;
    const clock = (): Date => new Date(START + readings++ * STEP_MS);
    const read = readConfig(sailDir);
    if ('issues' in read) throw new Error(`the fixture's project.yaml: ${read.issues.map(formatIssue).join('; ')}`);
    const config =
      options.harness === undefined ? read : { ...read, adapters: { ...read.adapters, harness: options.harness } };
    const resolved = await resolveAdapters({ sailDir, config, builtins: BUILTINS, env: process.env, now: clock });
    if ('issues' in resolved) throw new Error(`the fixture's adapters: ${resolved.issues.map(formatIssue).join('; ')}`);
    const adapters =
      options.record === undefined
        ? resolved
        : {
            ...resolved,
            ports: {
              ...resolved.ports,
              harness: recordingHarness(resolved.ports.harness, {
                dir: options.record,
                secrets: [],
                roots: { $RUNS: join(repo, '.sail-runs'), $REPO: repo, $HOME: home, $TMPDIR: tmpdir() },
              }),
            },
          };
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

    if (options.record !== undefined) writeJournalKeys(options.record, end.dir);
    rmSync(outDir, { recursive: true, force: true });
    cpSync(end.dir, outDir, { recursive: true });
    // run.json is read-only where the run wrote it. A fixture is data: a test copies it and rewrites the copy.
    for (const file of filesIn(outDir)) chmodSync(join(outDir, file), 0o644);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Plays the recorded set `name` back into `outDir`: on the `.sail/` it carries, or the fixture's when it has none. */
export async function playBack(set: RecordedSet | { name: string; onPromptMismatch: 'fail' }, outDir: string) {
  const dir = join(SESSIONS, set.name);
  const sail = join(dir, '.sail');
  await generateGoldenRun(outDir, {
    ...(existsSync(sail) ? { sailDir: sail } : {}),
    harness: { use: 'fake', playback: dir, onPromptMismatch: set.onPromptMismatch },
  });
}

/** Makes every file under `dir` an ordinary, writable one: a recording is data that a test copies and rewrites. */
function writable(dir: string): string[] {
  const files = filesIn(dir);
  for (const file of files) chmodSync(join(dir, file), 0o644);
  return files;
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
const VIEWS_TZ = 0;

/**
 * Renders every view of the dashboard's recorded fixtures into `outDir`, as fragments, and gives the files written. The
 * machine is seeded afresh, and nothing absolute of it is ever rendered, so the views are the same on every machine.
 */
export function renderDashboardViews(outDir: string): string[] {
  const machine = seedFixtures();
  try {
    const repos = index(machine.registryDir);
    const ui = (fields: Partial<UiState> = {}): UiState => ({ ...initialUi(VIEWS_TZ), ...fields });
    const runDirs: Record<string, [repo: string, dir: string]> = {
      golden: ['alpha', machine.alpha.runDir],
      'fake-2': ['alpha', fake2Dir(machine)],
      'fake-3': ['beta', machine.beta.runDir],
    };
    const runIdOf = { golden: GOLDEN_RUN_ID, 'fake-2': FAKE_2_ID, 'fake-3': FAKE_3_ID };
    const summaryOf = (repo: string, runId: string) =>
      repos.find((entry) => entry.name === repo)?.runs.find((run) => run.runId === runId)?.summary;
    const views: Record<string, SafeHtml> = {};
    const selected = ui({ repo: 'alpha', runId: GOLDEN_RUN_ID });
    views['rail.html'] = renderRail(railRepos(repos, VIEWS_NOW), selected);
    views['attention.html'] = renderAttention(attention(repos));
    const queueEvents = readEvents(queueDirOf(machine)) as unknown as QueueEvent[];
    const streams = {
      [queueId('beta', QUEUE_WORKFLOW)]: { recent: queueEvents.slice(-20), watch: watchState(queueEvents) },
    };
    views['queues.html'] = renderQueues(queuePanels(repos), streams, selected, VIEWS_NOW);
    for (const [name, [repo, dir]] of Object.entries(runDirs)) {
      const runId = runIdOf[name as keyof typeof runIdOf];
      const model = foldRun(readEvents(dir));
      views[`run-${name}.html`] = renderRun(model, summaryOf(repo, runId), ui({ repo, runId }), VIEWS_NOW);
    }
    const inspectors: [name: string, run: keyof typeof runDirs, key: string, tab: InspectorTab][] = [
      ['inspector-fake-2-implement-1-permissions.html', 'fake-2', 'implement#1', 'permissions'],
      ['inspector-golden-implement-2-overview.html', 'golden', 'implement#2', 'overview'],
      ['inspector-golden-implement-2-files.html', 'golden', 'implement#2', 'files'],
      ['inspector-golden-tests-1-log.html', 'golden', 'tests#1', 'log'],
    ];
    for (const [file, run, key, tab] of inspectors) {
      const [repo, dir] = runDirs[run] ?? ['', ''];
      const model = foldRun(readEvents(dir));
      const card = model.cards.find((entry) => entry.key === key);
      const resultPath = card?.resultPath ?? '';
      const result = JSON.parse(readFileSync(join(dir, resultPath), 'utf8')) as unknown;
      const log = readFileSync(
        join(dir, dirname(resultPath), card?.kind === 'script' ? 'stdout.log' : 'session.log'),
        'utf8',
      );
      const runId = runIdOf[run as keyof typeof runIdOf];
      views[file] = renderInspector(
        card,
        model.roster,
        { state: 'loaded', value: result },
        { state: 'loaded', value: log },
        ui({ repo, runId, key, tab }),
      );
    }
    mkdirSync(outDir, { recursive: true });
    return Object.entries(views).map(([file, view]) => {
      writeFileSync(join(outDir, file), `${view.value}\n`);
      return file;
    });
  } finally {
    machine.remove();
  }
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
  rmSync(DASHBOARD_VIEWS, { recursive: true, force: true });
  for (const file of renderDashboardViews(DASHBOARD_VIEWS)) console.log(relative(root, join(DASHBOARD_VIEWS, file)));
  // The scripted golden run, recorded, replaces its set; then every real set plays back to its own golden.
  const scratch = mkdtempSync(join(tmpdir(), 'sail-golden-record-'));
  try {
    await generateGoldenRun(join(scratch, 'run'), { record: join(scratch, 'rec') });
    const scripted = join(SESSIONS, SCRIPTED_SET);
    rmSync(scripted, { recursive: true, force: true });
    cpSync(join(scratch, 'rec'), scripted, { recursive: true });
    for (const file of writable(scripted)) console.log(relative(root, join(scripted, file)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const set of RECORDED_SETS) {
    const played = join(PLAYBACK, set.name);
    await playBack(set, played);
    for (const file of filesIn(played)) console.log(relative(root, join(played, file)));
  }
}

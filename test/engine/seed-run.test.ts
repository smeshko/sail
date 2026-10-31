// openSeededRun(): a new run seeded with a source run's calls before a stage, on the fixture repository's fakes. The
// source is `sail FAKE-1` run to its end once in a repository of its own, and each case seeds from a copy of it: a
// process opens one run per `.sail/`.
import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type JournalEntry, readJournal } from '../../src/engine/journal';
import type { OpenedRun } from '../../src/engine/open-run';
import { readStatus } from '../../src/engine/run-dir';
import { type RunHeader, readRunHeader } from '../../src/engine/run-header';
import { runWorkflow } from '../../src/engine/runtime';
import { openSeededRun, type SeededRunOptions } from '../../src/engine/seed-run';
import { fakeAdapters } from '../helpers/adapters';
import { AGENT_WORKFLOW } from '../helpers/agent-fixture';
import { edit } from '../helpers/fixture';
import { TRIO_JOURNAL, trioRunInto } from '../helpers/review-fixture';
import { cutJournal, reorderJournal, runIds, SOURCE_BRANCH, sharedSource } from '../helpers/seeded';
import { copyRun } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { writeTwoStep } from '../helpers/two-step';

/** Copies a completed source with publish's two steps grouped with notify into the case's repository. */
async function groupedTwoStepInto(to: string): Promise<string> {
  return withTempRepo(async (from) => {
    writeTwoStep(from.dir, { grouped: true });
    const end = await runWorkflow({
      cwd: from.dir,
      adapters: await fakeAdapters(from.dir),
      workflow: AGENT_WORKFLOW,
      ticket: 'FAKE-1',
    });
    if ('refused' in end) throw new Error(end.refused);
    expect(end.status).toBe('completed');
    copyRun(from.dir, to);
    return end.runId;
  });
}

test('seeding an interrupted group with only step lines is refused without writing anything', async () => {
  await withTempRepo(async (repo) => {
    const fromRun = await withTempRepo(async (from) => {
      const sail = writeTwoStep(from.dir, { grouped: true });
      edit(
        sail,
        `workflows/${AGENT_WORKFLOW}/stages/notify/stage.ts`,
        "import { script, value, z } from 'sail';",
        "import { script, stage, value, z } from 'sail';\nconst Url = z.string();",
      );
      edit(
        sail,
        `workflows/${AGENT_WORKFLOW}/stages/notify/stage.ts`,
        "export const notify = script('notify', {",
        "const send = script('send', {",
      );
      edit(sail, `workflows/${AGENT_WORKFLOW}/stages/notify/stage.ts`, 'value(z.string())', 'value(Url)');
      const notifyPath = join(sail, `workflows/${AGENT_WORKFLOW}/stages/notify/stage.ts`);
      writeFileSync(
        notifyPath,
        `${readFileSync(notifyPath, 'utf8')}\nconst Sent = z.object({ sent: z.boolean() });
export const notify = stage('notify', {
  consumes: { url: value(Url) },
  output: Sent,
  steps: [send, script('confirm', { run: './run.sh', output: Sent })],
});\n`,
      );
      const end = await runWorkflow({
        cwd: from.dir,
        adapters: await fakeAdapters(from.dir),
        workflow: AGENT_WORKFLOW,
        ticket: 'FAKE-1',
      });
      if ('refused' in end) throw new Error(end.refused);
      expect(end.status).toBe('completed');
      copyRun(from.dir, repo.dir);
      return end.runId;
    });
    const fromDir = join(repo.dir, '.sail-runs', fromRun);
    reorderJournal(fromDir, [
      'intake#1',
      'brief#1',
      'spec#1',
      'publish#1/describe',
      'notify#1/send',
      'publish#1/open',
      'publish#1',
      'notify#1/confirm',
      'notify#1',
    ]);
    cutJournal(fromDir, 5);
    writeFileSync(join(fromDir, 'STATUS'), 'running\n');
    const before = runIds(repo.dir);
    const worktrees = repo.git('worktree', 'list', '--porcelain');
    expect(await seed(repo, { fromRun, stage: 'notify' })).toEqual({
      refused: `run ${fromRun}'s notify#1 has only step lines and no recorded group: sail resume ${fromRun} before seeding it`,
    });
    expect(runIds(repo.dir)).toEqual(before);
    expect(repo.git('worktree', 'list', '--porcelain')).toBe(worktrees);
  });
}, 60_000);

test('seeding an interrupted sequential multi-step call reuses only its preceding calls', async () => {
  await withTempRepo(async (repo) => {
    const fromRun = await withTempRepo(async (from) => {
      writeTwoStep(from.dir);
      const end = await runWorkflow({
        cwd: from.dir,
        adapters: await fakeAdapters(from.dir),
        workflow: AGENT_WORKFLOW,
        ticket: 'FAKE-1',
      });
      if ('refused' in end) throw new Error(end.refused);
      expect(end.status).toBe('completed');
      copyRun(from.dir, repo.dir);
      return end.runId;
    });
    const fromDir = join(repo.dir, '.sail-runs', fromRun);
    cutJournal(fromDir, 4);
    writeFileSync(join(fromDir, 'STATUS'), 'running\n');
    expect(readJournal(fromDir).entries.map((entry) => entry.key)).toEqual([
      'intake#1',
      'brief#1',
      'spec#1',
      'publish#1/describe',
    ]);
    const opened = openedFrom(await seed(repo, { fromRun, stage: 'publish' }));
    expect(readJournal(opened.dir).entries.map((entry) => entry.key)).toEqual(['intake#1', 'brief#1', 'spec#1']);
    expect(existsSync(join(opened.dir, '03-publish/call-1'))).toBe(false);
  });
}, 60_000);

const source = sharedSource();
afterAll(() => source.release());

const STAGES = 'implement, publish, self-review, spec, tests';

const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');

/** Every file under `dir`'s `paths`, each with its sha256, by its path relative to `dir`. */
function filesOf(dir: string, paths: string[]): Record<string, string> {
  const glob = new Bun.Glob('**/*');
  return Object.fromEntries(
    paths.flatMap((path) =>
      [...glob.scanSync({ cwd: join(dir, path), dot: true, onlyFiles: true })]
        .sort()
        .map((file) => [`${path}/${file}`, sha256(join(dir, path, file))]),
    ),
  );
}

/** A seeded run of the copied source in `repo`, with `options` over the defaults. */
async function seed(repo: TempRepo, options: Partial<SeededRunOptions> & { fromRun: string }) {
  return openSeededRun({ cwd: repo.dir, stage: 'spec', adapters: await fakeAdapters(repo.dir), ...options });
}

/** The opened run, once a test has asserted that `result` is no refusal. */
function openedFrom(result: OpenedRun | { refused: string }): OpenedRun {
  expect('refused' in result ? result.refused : 'opened').toBe('opened');
  return result as OpenedRun;
}

test('seeding spec copies the intake call byte for byte, journals intake#1 alone, and records fromRun, no claim, a branch of its own and the base of the source', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const sourceHeader = readRunHeader(from.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    const header: Partial<RunHeader> = readRunHeader(opened.dir);
    const { recordedAt: _, ...intake } = readJournal(from.dir).entries[0] as JournalEntry;
    expect({
      intakeFiles: filesOf(opened.dir, ['00-intake/call-1']),
      spec: existsSync(join(opened.dir, '01-spec')),
      workspace: existsSync(join(opened.dir, 'workspace', '.git')),
      journal: readJournal(opened.dir).entries.map(({ recordedAt: __, ...entry }) => entry),
      fromRun: header.fromRun,
      reused: header.reused,
      claim: 'claim' in header,
      branch: header.branch,
      baseSha: header.repository?.baseSha,
      source: header.source,
      status: readStatus(opened.dir),
      until: opened.until,
    }).toEqual({
      intakeFiles: filesOf(from.dir, ['00-intake/call-1']),
      spec: false,
      workspace: true,
      journal: [intake],
      fromRun: from.runId,
      reused: 1,
      claim: false,
      branch: `${SOURCE_BRANCH}-seeded-${opened.runId.slice(-8).toLowerCase()}`,
      baseSha: sourceHeader.repository?.baseSha,
      source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
      status: { status: 'running' },
      until: 'spec',
    });
  });
}, 60_000);

test('a source run of layout 2 still seeds a run, which is of layout 3 and keeps its own copy of .sail/', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const path = join(from.dir, 'run.json');
    chmodSync(path, 0o644);
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), layout: 2 }, null, 2)}\n`);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    expect(readRunHeader(opened.dir).layout).toBe(3);
    expect(existsSync(join(opened.dir, 'definition', '.sail', 'project.yaml'))).toBe(true);
  });
}, 60_000);

test("a seeded run keeps the clone's .sail/: an uncommitted edit reaches its definition/ copy, and its header has no definitionsSha", async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const prompt = join('workflows', 'ticket-to-pr', 'stages', 'spec', 'prompt.md');
    writeFileSync(join(repo.dir, '.sail', prompt), 'an uncommitted edit\n');
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    expect({
      sailDir: opened.sailDir,
      definitionsSha: readRunHeader(opened.dir).definitionsSha,
      prompt: readFileSync(join(opened.dir, 'definition', '.sail', prompt), 'utf8'),
    }).toEqual({
      sailDir: join(opened.dir, 'definition', '.sail'),
      definitionsSha: undefined,
      prompt: 'an uncommitted edit\n',
    });
    expect(readRunHeader(opened.dir).layout).toBe(3);
    expect(existsSync(join(opened.dir, 'definition', '.sail', 'project.yaml'))).toBe(true);
    expect(existsSync(join(opened.dir, 'definition', '.sail', 'workflows', 'ticket-to-pr', 'workflow.ts'))).toBe(true);
  });
}, 60_000);

test("a seeded run keeps the stage its roster was built from in definition/, though the clone's .sail/ changes it while the workspace is made", async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const stage = join('workflows', 'ticket-to-pr', 'stages', 'spec', 'stage.ts');
    const before = readFileSync(join(repo.dir, '.sail', stage), 'utf8');
    const adapters = await fakeAdapters(repo.dir);
    const { workspace } = adapters.ports;
    const create = workspace.create.bind(workspace);
    workspace.create = async (run, options) => {
      writeFileSync(join(repo.dir, '.sail', stage), before.replace("agent('spec'", "script('spec'"));
      return create(run, options);
    };
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, adapters }));
    expect(readFileSync(join(opened.dir, 'definition', '.sail', stage), 'utf8')).toBe(before);
    expect(readRunHeader(opened.dir).stages.spec?.kind).toBe('agent');
  });
}, 60_000);

test('seeding self-review journals every call of the source before self-review#1, and copies their call directories with every try', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, stage: 'self-review' }));
    const calls = ['00-intake/call-1', '01-spec/call-1', '02-implement/call-1', '02-implement/call-2'];
    const reused = [...calls, '03-tests/call-1', '03-tests/call-2'];
    expect({
      journal: readJournal(opened.dir).entries.map((entry) => `${entry.key} ${entry.outcome}`),
      files: filesOf(opened.dir, reused),
      review: existsSync(join(opened.dir, '04-self-review')),
      seeded: opened.seeded?.entries.map((entry) => entry.key),
    }).toEqual({
      journal: [
        'intake#1 passed',
        'spec#1 done',
        'implement#1 done',
        'tests#1 failed',
        'implement#2 done',
        'tests#2 passed',
      ],
      files: filesOf(from.dir, reused),
      review: false,
      seeded: ['intake#1', 'spec#1', 'implement#1', 'tests#1', 'implement#2', 'tests#2'],
    });
  });
}, 60_000);

const MINTED = 'FAKE-1-01HZX3Y4Z5A6B7C8D9E0F1G2H3';

test('a seeded run given a run id runs under exactly that id, with fromRun in its header', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, runId: MINTED }));
    expect({
      runId: opened.runId,
      dir: opened.dir,
      header: [readRunHeader(opened.dir).runId, readRunHeader(opened.dir).fromRun],
      ids: runIds(repo.dir),
    }).toEqual({
      runId: MINTED,
      dir: join(repo.dir, '.sail-runs', MINTED),
      header: [MINTED, from.runId],
      ids: [from.runId, MINTED].sort(),
    });
  });
}, 60_000);

test.each<[string, (sourceId: string) => string, (sourceId: string) => string]>([
  [
    'an id of another ticket',
    () => 'FAKE-2-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    () =>
      "--run-id takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: 'FAKE-2-01HZX3Y4Z5A6B7C8D9E0F1G2H3' is not one",
  ],
  [
    'a malformed id',
    () => 'FAKE-1-nope',
    () => "--run-id takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: 'FAKE-1-nope' is not one",
  ],
  [
    "an existing run's id",
    (sourceId) => sourceId,
    (sourceId) => `--run-id names run ${sourceId}, which already exists in .sail-runs: a seeded run is a new run`,
  ],
])(
  'a seeded run given %s is refused, leaving no run directory, lease or workspace',
  async (_, id, refusal) => {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      const before = runIds(repo.dir);
      const leases = join(repo.dir, '.sail-runs', 'fake', 'leases');
      const leased = () => (existsSync(leases) ? readdirSync(leases) : []);
      const held = leased();
      const result = await seed(repo, { fromRun: from.runId, runId: id(from.runId) });
      expect({ result, runs: runIds(repo.dir), leases: leased() }).toEqual({
        result: { refused: refusal(from.runId) },
        runs: before,
        leases: held,
      });
    });
  },
  60_000,
);

test('a seeded run masks its secrets in run.json and hands on a redactor of them', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, secrets: ['fake://origin'] }));
    expect([readRunHeader(opened.dir).repository?.url, opened.redact.text('at fake://origin')]).toEqual([
      '[redacted]',
      'at [redacted]',
    ]);
  });
}, 60_000);

test('a seeded run whose masked header breaks its schema throws, leaving no run directory, workspace or lease', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const baseSha = readRunHeader(from.dir).repository?.baseSha ?? '';
    const before = runIds(repo.dir);
    const leases = join(repo.dir, '.sail-runs', 'fake', 'leases');
    const leased = () => (existsSync(leases) ? readdirSync(leases).filter((name) => name.endsWith('.json')) : []);
    const held = leased();
    await expect(seed(repo, { fromRun: from.runId, secrets: [baseSha.slice(0, 12)] })).rejects.toThrow();
    expect({ runs: runIds(repo.dir), leases: leased() }).toEqual({ runs: before, leases: held });
  });
}, 60_000);

/** Makes `deep` name the harness `harness` in `repo`'s config, which defines `second` and the credentialed `echo`. */
function nameHarness(repo: TempRepo, harness: string, model = 'claude-opus-5-5'): void {
  const sail = join(repo.dir, '.sail');
  edit(
    sail,
    'project.yaml',
    '  workspace: { use: fake }\n',
    '  workspace: { use: fake }\n  harnesses: { second: { use: fake }, echo: { use: ./adapters/echo-harness.ts } }\n',
  );
  edit(sail, 'project.yaml', 'deep: claude-opus-5-5', `deep: { harness: ${harness}, model: ${model} }`);
}

test('a seeded run reaching a named harness records it in run.json and hands it on, and creates no other', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    nameHarness(repo, 'second');
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    expect(readRunHeader(opened.dir).adapters.harnesses).toEqual({ second: { use: 'fake', origin: 'builtin' } });
    expect(Object.keys(opened.harnesses)).toEqual(['second']);
  });
}, 60_000);

test('a seeded run reaching a named harness whose adapter needs a variable that is not set is refused, naming it', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    nameHarness(repo, 'echo', 'echo-1');
    const before = runIds(repo.dir);
    expect(await seed(repo, { fromRun: from.runId })).toEqual({
      refused: '.sail/project.yaml  /adapters/harnesses/echo needs ECHO_HARNESS_TOKEN, which is not set',
    });
    expect(runIds(repo.dir)).toEqual(before);
  });
}, 60_000);

/** Rewrites the first journal line of the run in `dir` so its intake failed. */
function failIntake(dir: string): void {
  const path = join(dir, 'journal.ndjson');
  const [first = '', ...rest] = readFileSync(path, 'utf8').split('\n');
  const line = JSON.parse(first);
  writeFileSync(path, [JSON.stringify({ ...line, outcome: 'failed' }), ...rest].join('\n'));
}

/** Rewrites the header of the run in `dir` as a run from before workspaces would have it: no branch, no repository. */
function dropWorkspace(dir: string): void {
  const path = join(dir, 'run.json');
  const { branch: _, repository: __, workspace: ___, ...header } = JSON.parse(readFileSync(path, 'utf8'));
  chmodSync(path, 0o644);
  writeFileSync(path, `${JSON.stringify(header, null, 2)}\n`);
}

/** Rewrites the header of the run in `dir` as a run from before the move to out/ has it: no layout. */
function dropLayout(dir: string): void {
  const path = join(dir, 'run.json');
  const { layout: _, ...header } = JSON.parse(readFileSync(path, 'utf8'));
  chmodSync(path, 0o644);
  writeFileSync(path, `${JSON.stringify(header, null, 2)}\n`);
}

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

test.each<[string, (dir: string) => void, (runId: string) => Partial<SeededRunOptions>, (runId: string) => string]>([
  ['an id that names no run', () => {}, () => ({ fromRun: 'FAKE-1-NOPE' }), () => "no run 'FAKE-1-NOPE' in .sail-runs"],
  ['an id that is not a plain name', () => {}, () => ({ fromRun: '../x' }), () => "'../x' is not a run id"],
  [
    'a stage the workflow does not have',
    () => {},
    () => ({ stage: 'nope' }),
    () => `--stage names 'nope', which is no stage of workflow 'ticket-to-pr': its stages are ${STAGES}`,
  ],
  [
    'a stage the source never ran',
    (dir) => cutJournal(dir, 2),
    () => ({ stage: 'publish' }),
    (runId) => `run ${runId} never ran 'publish': sail resume ${runId} continues it`,
  ],
  [
    'a source whose intake failed',
    failIntake,
    () => ({}),
    (runId) => `run ${runId}'s intake didn't pass: there is nothing to reuse`,
  ],
  [
    'a source from before workspaces',
    dropWorkspace,
    () => ({}),
    (runId) => `run ${runId} started before runs had workspaces: it can't seed a run`,
  ],
  [
    'a run without a layout',
    dropLayout,
    () => ({}),
    (runId) =>
      `run ${runId} keeps its calls' records inside their $STAGE_OUT, as runs did before sail moved them to out/: it can't seed a run`,
  ],
  ['a start that has aborted', () => {}, () => ({ signal: aborted() }), () => 'stopped before the run was opened'],
])(
  'seeding is refused for %s, and leaves only the source run and the fakes',
  async (_, prepare, options, refused) => {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      prepare(from.dir);
      const worktrees = repo.git('worktree', 'list', '--porcelain');
      const result = await seed(repo, { fromRun: from.runId, ...options(from.runId) });
      expect([result, runIds(repo.dir), repo.git('worktree', 'list', '--porcelain')]).toEqual([
        { refused: refused(from.runId) },
        [from.runId],
        worktrees,
      ]);
    });
  },
  60_000,
);

test('seeding from a pull-request run is refused, naming its pull request, and leaves only the source run and the fakes', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const path = join(from.dir, 'run.json');
    const { claim: _, ...header } = JSON.parse(readFileSync(path, 'utf8'));
    const pr = { kind: 'pr', number: 3, headSha: 'c'.repeat(40), via: 'watch', forced: [] };
    chmodSync(path, 0o644);
    writeFileSync(path, `${JSON.stringify({ ...header, source: pr }, null, 2)}\n`);
    const worktrees = repo.git('worktree', 'list', '--porcelain');
    const result = await seed(repo, { fromRun: from.runId });
    expect([result, runIds(repo.dir), repo.git('worktree', 'list', '--porcelain')]).toEqual([
      { refused: `a seeded run starts from a ticket run: run ${from.runId} started from pull request #3` },
      [from.runId],
      worktrees,
    ]);
  });
}, 60_000);

test('a seeded run reads no ticket and claims nothing: the fake ticket state is as it was, and nothing it reports is about the ticket', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const tickets = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const before = readFileSync(tickets, 'utf8');
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    expect({
      tickets: readFileSync(tickets, 'utf8'),
      started: opened.started.map((event) => event.type),
    }).toEqual({ tickets: before, started: ['workspace:leased', 'workspace:created'] });
  });
}, 60_000);

test('two seeded runs from one source both open, each on a branch of its own, and the branch of the source stays free', async () => {
  await withTempRepo(async (first) => {
    const from = await source.copyInto(first.dir);
    const one = openedFrom(await seed(first, { fromRun: from.runId }));
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const two = openedFrom(await seed(second, { fromRun: from.runId }));
      const { workspace } = (await fakeAdapters(second.dir)).ports;
      const holders = await Promise.all(
        [one.workspace.branch, two.workspace.branch, SOURCE_BRANCH].map(
          async (branch) => (await workspace.holder('fake://origin', branch))?.runId,
        ),
      );
      expect([one.workspace.branch === two.workspace.branch, holders]).toEqual([
        false,
        [one.runId, two.runId, undefined],
      ]);
    });
  });
}, 60_000);

// Review round 1: a source the seed can't trust is refused before anything is written, never copied or thrown on.

/** Rewrites the journal line of `key` in the run in `dir`. */
function rewriteLine(dir: string, key: string, change: (line: Record<string, unknown>) => Record<string, unknown>) {
  const path = join(dir, 'journal.ndjson');
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((text) => text !== '' && JSON.parse(text).key === key);
  lines[at] = JSON.stringify(change(JSON.parse(lines[at] as string)));
  writeFileSync(path, lines.join('\n'));
}

/** Replaces `file` in the run in `dir` with a symlink to a file outside the run. */
function linkOut(dir: string, file: string): void {
  const outside = join(dir, '..', '..', 'outside.md');
  writeFileSync(outside, 'not from the source run\n');
  rmSync(join(dir, file));
  symlinkSync(outside, join(dir, file));
}

test.each<[string, (dir: string) => void, Partial<SeededRunOptions>, (runId: string) => string]>([
  [
    'a reused line whose result lies outside its call directory',
    (dir) => rewriteLine(dir, 'intake#1', (line) => ({ ...line, resultPath: '00-intake/../result.json' })),
    {},
    (runId) => `run ${runId}'s journal line 1 points at '00-intake/../result.json', outside a call directory`,
  ],
  [
    'a reused line whose file lies outside its call directory',
    (dir) =>
      rewriteLine(dir, 'intake#1', (line) => ({
        ...line,
        files: { ...(line.files as object), 'brief.md': '01-spec/call-1/out/spec.md' },
      })),
    {},
    (runId) => `run ${runId}'s journal line 1 points at '01-spec/call-1/out/spec.md', outside a call directory`,
  ],
  [
    'a reused file that is a symlink',
    (dir) => linkOut(dir, '00-intake/call-1/out/brief.md'),
    {},
    (runId) => `run ${runId}'s 00-intake/call-1/out/brief.md is a symlink: a seed copies only what the run wrote`,
  ],
  [
    'a reused call directory that is a symlink',
    (dir) => {
      const moved = join(dir, '..', '..', 'moved-call');
      renameSync(join(dir, '00-intake', 'call-1'), moved);
      symlinkSync(moved, join(dir, '00-intake', 'call-1'));
    },
    {},
    (runId) => `run ${runId}'s 00-intake/call-1 is a symlink: a seed copies only what the run wrote`,
  ],
  [
    'a reused result.json that is a symlink',
    (dir) => linkOut(dir, '00-intake/call-1/result.json'),
    {},
    (runId) => `run ${runId}'s 00-intake/call-1/result.json is a symlink: a seed copies only what the run wrote`,
  ],
  [
    'a source run directory that is a symlink',
    (dir) => {
      const moved = join(dir, '..', '..', 'moved-run');
      renameSync(dir, moved);
      symlinkSync(moved, dir);
    },
    {},
    (runId) => `run ${runId} is a symlink in .sail-runs, not a run directory: it can't seed a run`,
  ],
  [
    'a source whose run.json is broken',
    (dir) => {
      chmodSync(join(dir, 'run.json'), 0o644);
      writeFileSync(join(dir, 'run.json'), '{');
    },
    {},
    (runId) => `run ${runId}'s run.json can't be read: `,
  ],
  [
    'a source with no journal',
    (dir) => rmSync(join(dir, 'journal.ndjson')),
    {},
    (runId) => `run ${runId}'s journal can't be read: `,
  ],
  [
    'a source whose journal has a broken line',
    (dir) => {
      const path = join(dir, 'journal.ndjson');
      const [first = '', ...rest] = readFileSync(path, 'utf8').split('\n');
      writeFileSync(path, ['{"seq":', first, ...rest].join('\n'));
    },
    {},
    (runId) => `run ${runId}'s journal can't be read: `,
  ],
])(
  'seeding is refused for %s, and writes nothing',
  async (_, prepare, options, refused) => {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      prepare(from.dir);
      const worktrees = repo.git('worktree', 'list', '--porcelain');
      const result = await seed(repo, { fromRun: from.runId, ...options });
      // A refusal that passes on a reader's own words is matched up to them: they differ between Bun versions.
      const message = 'refused' in result ? result.refused : 'opened';
      const expected = refused(from.runId);
      expect([
        message.startsWith(expected) ? expected : message,
        runIds(repo.dir),
        repo.git('worktree', 'list', '--porcelain'),
      ]).toEqual([expected, [from.runId], worktrees]);
    });
  },
  60_000,
);

// Review round 3: a link no reused call points at, such as one an agent's rejected try left in its directory, is copied
// as the link it is: nothing reads it again, and a source that holds one can still seed a run.
test('a link a reused call does not point at is copied as a link, and seeding opens', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    linkOut(from.dir, '01-spec/call-1/in/brief.md');
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, stage: 'implement' }));
    const copied = join(opened.dir, '01-spec', 'call-1', 'in', 'brief.md');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
  });
}, 60_000);

test.each([
  {
    stage: 'notify',
    order: ['intake#1', 'brief#1', 'spec#1', 'publish#1/describe', 'publish#1/open', 'publish#1', 'notify#1'],
    behaviour: "seeding a sibling cuts before a grouped member's earlier step lines",
  },
  {
    stage: 'publish',
    order: ['intake#1', 'brief#1', 'spec#1', 'notify#1', 'publish#1/describe', 'publish#1/open', 'publish#1'],
    behaviour: "seeding a multi-step member cuts before its sibling's earlier call line",
  },
])(
  '$behaviour',
  async ({ stage, order }) => {
    await withTempRepo(async (repo) => {
      const fromRun = await groupedTwoStepInto(repo.dir);
      const fromDir = join(repo.dir, '.sail-runs', fromRun);
      reorderJournal(fromDir, [...order]);
      expect(readJournal(fromDir).entries.map((entry) => entry.key)).toEqual([...order]);
      const opened = openedFrom(await seed(repo, { fromRun, stage }));
      expect({
        journal: readJournal(opened.dir).entries.map((entry) => entry.key),
        reused: opened.seeded?.entries.map((entry) => entry.key),
        members: readdirSync(opened.dir).filter((name) => name.endsWith('-publish') || name.endsWith('-notify')),
        until: opened.until,
      }).toEqual({
        journal: ['intake#1', 'brief#1', 'spec#1'],
        reused: ['intake#1', 'brief#1', 'spec#1'],
        members: [],
        until: stage,
      });
    });
  },
  60_000,
);

test("seeding a stage whose first call belongs to a group copies only the calls before the group, and none of its members, though the stage's call was journaled last", async () => {
  await withTempRepo(async (repo) => {
    const { runId: fromRun, keys } = await trioRunInto(repo.dir);
    expect(keys).toEqual(TRIO_JOURNAL);
    const opened = openedFrom(await seed(repo, { fromRun, stage: 'a' }));
    expect({
      journal: readJournal(opened.dir).entries.map((entry) => entry.key),
      reused: opened.seeded?.entries.map((entry) => entry.key),
      members: ['01-a', '02-b', '03-c'].filter((path) => existsSync(join(opened.dir, path))),
      until: opened.until,
    }).toEqual({ journal: ['intake#1'], reused: ['intake#1'], members: [], until: 'a' });
  });
}, 60_000);

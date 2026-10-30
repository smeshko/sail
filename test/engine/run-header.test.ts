import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { type ProjectConfig, type RunPort, readConfig } from '../../src/engine/config';
import { type LoadedWorkflow, loadWorkflow } from '../../src/engine/load-workflow';
import type { Source } from '../../src/engine/run-dir';
import {
  type AdapterEntry,
  buildRunHeader,
  type HeaderWorkspace,
  RUN_HEADER_FILE,
  type RunHeader,
  readRunHeader,
  validateRunHeader,
  workflowHash,
  writeRunHeader,
} from '../../src/engine/run-header';
import { copyFixture, edit, write } from '../helpers/fixture';
import { withTempRepo } from '../helpers/temp-repo';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const NOW = new Date('2026-09-27T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-run-header-'));
  dirs.push(dir);
  return dir;
}

async function load(sail: string): Promise<{ loaded: LoadedWorkflow; config: ProjectConfig }> {
  const loaded = await loadWorkflow(sail, 'ticket-to-pr');
  const config = readConfig(sail);
  if ('refused' in loaded) throw new Error(loaded.refused);
  if ('issues' in config) throw new Error(JSON.stringify(config.issues));
  return { loaded, config };
}

/** The workflow hash of a fresh copy of the fixture, after `change` edits it. */
async function hashAfter(change: (sail: string) => void = () => {}): Promise<string> {
  return withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    change(sail);
    return workflowHash(sail, (await load(sail)).loaded);
  });
}

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const FAKE_1: Source = { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] };
const FAKE: AdapterEntry = { use: 'fake', origin: 'builtin' };
const FAKE_ENTRIES: Record<RunPort, AdapterEntry> = {
  ticketSource: FAKE,
  codeHost: FAKE,
  harness: FAKE,
  workspace: FAKE,
};

/** The fixture's header, built on a fresh copy, recording `adapters`, and the run's workspace when one is given. */
async function fixtureHeader(
  adapters: Record<RunPort, AdapterEntry> = FAKE_ENTRIES,
  workspace?: HeaderWorkspace,
): Promise<RunHeader> {
  return withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const { loaded, config } = await load(sail);
    return buildRunHeader({
      runId: RUN_ID,
      source: FAKE_1,
      sailDir: sail,
      loaded,
      config,
      adapters,
      now: NOW,
      ...(workspace === undefined ? {} : { workspace }),
    });
  });
}

test("a new run's header carries layout 2, right after its run id, and validates", async () => {
  const header = await fixtureHeader();
  expect(header.layout).toBe(2);
  expect(Object.keys(header).slice(0, 3)).toEqual(['schema', 'runId', 'layout']);
  expect(validateRunHeader(header)).toEqual([]);
});

test('the workflow hash is 64 hex characters, and the same for a copy at another path', async () => {
  const first = await hashAfter();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashAfter()).toBe(first);
});

/** A helper the workflow imports that holds no stage. */
const withHelper = (text: string) => (sail: string) => {
  write(sail, 'workflows/ticket-to-pr/notes.ts', text);
  edit(
    sail,
    WORKFLOW,
    "import { workflow } from 'sail';",
    "import { workflow } from 'sail';\nimport { note } from './notes';\nexport const noted = note;",
  );
};

test.each<[string, (sail: string) => void]>([
  ['workflow.ts', (sail) => edit(sail, WORKFLOW, 'a ticket in', 'one ticket in')],
  ['a shared stage.ts', (sail) => edit(sail, 'stages/implement/stage.ts', 'makes the change', 'makes a change')],
  ['a private prompt.md', (sail) => write(sail, 'workflows/ticket-to-pr/stages/spec/prompt.md', 'Write a spec.\n')],
  ['a new file in a roster stage', (sail) => write(sail, 'stages/tests/templates/x.md', 'x\n')],
  [
    'a new dotfile in a roster stage',
    (sail) => write(sail, 'workflows/ticket-to-pr/stages/publish/.env.example', 'X=1\n'),
  ],
])('the workflow hash changes when %s changes', async (_, change) => {
  expect(await hashAfter(change)).not.toBe(await hashAfter());
});

test('the workflow hash changes when a helper the workflow imports changes', async () => {
  const before = await hashAfter(withHelper("export const note = 'a';\n"));
  expect(before).not.toBe(await hashAfter());
  expect(await hashAfter(withHelper("export const note = 'b';\n"))).not.toBe(before);
});

test.each<[string, (sail: string) => void]>([
  [
    'a stage the workflow does not import is added',
    (sail) => {
      cpSync(join(sail, 'stages', 'tests'), join(sail, 'stages', 'unused'), { recursive: true });
      edit(sail, 'stages/unused/stage.ts', "script('tests'", "script('unused'");
    },
  ],
  ['project.yaml changes', (sail) => edit(sail, 'project.yaml', 'maxUsd: 25', 'maxUsd: 30')],
])('the workflow hash stays the same when %s', async (_, change) => {
  expect(await hashAfter(change)).toBe(await hashAfter());
});

test("a repository's intake is hashed: a private one as its file, a shared one as its folder", async () => {
  const intake =
    "import { intake, script, z } from 'sail';\n" +
    'const Empty = z.object({});\n' +
    "const fetch = script('fetch', { run: './fetch.sh', output: Empty });\n" +
    "export const own = intake('own', { accepts: ['ticket'], output: Empty, steps: [fetch] });\n";
  const shared = (extra: string) => (sail: string) => {
    write(sail, 'intakes/own/intake.ts', intake);
    write(sail, 'intakes/own/brief.md', extra);
    edit(
      sail,
      WORKFLOW,
      "import { ticket } from 'sail/intakes';",
      "import { own as ticket } from '../../intakes/own/intake';",
    );
  };
  expect(await hashAfter(shared('one\n'))).not.toBe(await hashAfter(shared('two\n')));
  const privately = (text: string) => (sail: string) => {
    write(sail, 'workflows/ticket-to-pr/intake.ts', text);
    edit(sail, WORKFLOW, "import { ticket } from 'sail/intakes';", "import { own as ticket } from './intake';");
  };
  expect(await hashAfter(privately(intake))).not.toBe(await hashAfter(privately(`// changed\n${intake}`)));
});

test("the fixture's header validates, with the workflow's folder, the adapters asked for and the run budget", async () => {
  const header = await fixtureHeader();
  expect(validateRunHeader(header)).toEqual([]);
  expect(header).toMatchObject({
    schema: 'sail.run.v1',
    runId: RUN_ID,
    source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
    workflow: { name: 'ticket-to-pr', version: 1, origin: 'repo:.sail/workflows/ticket-to-pr' },
    sail: { version: pkg.version, runtime: `bun ${Bun.version}` },
    budget: { maxUsd: 25, maxMinutes: 90 },
    startedAt: '2026-09-27T09:00:00.000Z',
  });
  expect(header.workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
  const fake = { use: 'fake', origin: 'builtin' };
  expect(header.adapters).toEqual({ ticketSource: fake, codeHost: fake, harness: fake, workspace: fake });
  expect(Object.keys(header.stages)).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests']);
  expect(header.intake.name).toBe('ticket');
});

test("a step's idle limit of 0 still validates, as its minute budget of 0 does, so the agent kind refuses it with its own message (review D1)", async () => {
  const header = await fixtureHeader();
  const spec = header.stages.spec as unknown as { budget: Record<string, number> };
  spec.budget = { ...spec.budget, maxIdleMinutes: 0 };
  expect(validateRunHeader(header)).toEqual([]);
});

test("a workflow's budget overrides project.yaml's field by field, and stands alone without one: the header validates and holds the merged budget a dry run prints", async () => {
  const headerOf = (change: (sail: string) => void) =>
    withTempRepo(async (repo) => {
      const sail = copyFixture(repo.dir);
      edit(sail, WORKFLOW, ' version: 1,', ' version: 1, budget: { maxUsd: 0.5 },');
      change(sail);
      const { loaded, config } = await load(sail);
      return buildRunHeader({
        runId: RUN_ID,
        source: FAKE_1,
        sailDir: sail,
        loaded,
        config,
        adapters: FAKE_ENTRIES,
        now: NOW,
      });
    });
  const merged = await headerOf(() => {});
  const alone = await headerOf((sail) =>
    edit(sail, 'project.yaml', 'budgets: { run: { maxUsd: 25, maxMinutes: 90 } }', 'budgets: { run: {} }'),
  );
  expect({
    merged: merged.budget,
    alone: alone.budget,
    issues: [...validateRunHeader(merged), ...validateRunHeader(alone)],
  }).toEqual({ merged: { maxUsd: 0.5, maxMinutes: 90 }, alone: { maxUsd: 0.5 }, issues: [] });
});

test('a workflow without a version is version 1, and a config without a run budget leaves budget out', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, WORKFLOW, ' version: 1,', '');
    edit(sail, 'project.yaml', 'budgets: { run: { maxUsd: 25, maxMinutes: 90 } }', 'budgets: { run: {} }');
    const { loaded, config } = await load(sail);
    const header = buildRunHeader({
      runId: 'FAKE-1-1',
      source: FAKE_1,
      sailDir: sail,
      loaded,
      config,
      adapters: FAKE_ENTRIES,
      now: NOW,
    });
    expect(header.workflow.version).toBe(1);
    expect(header).not.toHaveProperty('budget');
    expect(validateRunHeader(header)).toEqual([]);
  });
});

test('a header records the adapters it is handed, with the versions a repository adapter declares', async () => {
  const echo: AdapterEntry = {
    use: './adapters/echo-harness.ts',
    origin: 'repo:.sail/adapters/echo-harness.ts',
    versions: { echo: '1.0.0' },
  };
  const entries: Record<RunPort, AdapterEntry> = { ...FAKE_ENTRIES, harness: echo };
  const header = await fixtureHeader(entries);
  expect(header.adapters).toEqual(entries);
  expect(validateRunHeader(header)).toEqual([]);
});

test('run.json is written once, read-only, and reads back equal', async () => {
  const header = await fixtureHeader();
  expect(validateRunHeader(header)).toEqual([]);
  const dir = tempDir();
  writeRunHeader(dir, header);
  const path = join(dir, RUN_HEADER_FILE);
  expect(statSync(path).mode & 0o777).toBe(0o444);
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(header, null, 2)}\n`);
  expect(readRunHeader(dir)).toEqual(header);
  expect(() => writeRunHeader(dir, header)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
});

test('an invalid header is a bug in sail: it throws, and nothing is written', async () => {
  const { stages: _, ...header } = await fixtureHeader();
  const dir = tempDir();
  expect(() => writeRunHeader(dir, header as RunHeader)).toThrow(
    /sail\.run\.v1, a bug in sail:\n.*\/stages is required/,
  );
  expect(existsSync(join(dir, RUN_HEADER_FILE))).toBe(false);
});

test("the golden run's run.json reads, and one missing runId or not JSON throws naming the problem", () => {
  expect(validateRunHeader(JSON.parse(readFileSync(join(GOLDEN, RUN_HEADER_FILE), 'utf8')))).toEqual([]);
  expect(readRunHeader(GOLDEN).runId).toBe(RUN_ID);

  const dir = tempDir();
  const { runId: _, ...rest } = JSON.parse(readFileSync(join(GOLDEN, RUN_HEADER_FILE), 'utf8'));
  writeFileSync(join(dir, RUN_HEADER_FILE), JSON.stringify(rest));
  expect(() => readRunHeader(dir)).toThrow(/run\.json breaks sail\.run\.v1:\n.*\/runId is required/);

  writeFileSync(join(dir, RUN_HEADER_FILE), '{"schema":');
  expect(() => readRunHeader(dir)).toThrow(`${join(dir, RUN_HEADER_FILE)} is not valid JSON`);
  expect(() => readRunHeader(tempDir())).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

test('a header holds the checks its source lists, as a copy, and no claim, and run.json holds the same', async () => {
  const forced: Source = { ...FAKE_1, forced: ['designation', 'state'] };
  const header = await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const { loaded, config } = await load(sail);
    return buildRunHeader({
      runId: RUN_ID,
      source: forced,
      sailDir: sail,
      loaded,
      config,
      adapters: FAKE_ENTRIES,
      now: NOW,
    });
  });
  expect(header.source).toEqual(forced);
  expect('claim' in header).toBe(false);
  expect(validateRunHeader(header)).toEqual([]);
  // The header is the run's own: a later change to what it was built from doesn't reach it.
  forced.forced.push('state');
  expect(header.source.forced).toEqual(['designation', 'state']);

  const dir = tempDir();
  writeRunHeader(dir, header);
  const written = JSON.parse(readFileSync(join(dir, RUN_HEADER_FILE), 'utf8'));
  expect(written.source.forced).toEqual(['designation', 'state']);
  expect(Object.keys(written).slice(0, 4)).toEqual(['schema', 'runId', 'layout', 'source']);
});

test("a header built with the run's workspace records its branch, repository and base, and validates; one built without it holds none of them", async () => {
  const baseSha = 'a'.repeat(40);
  const workspace: HeaderWorkspace = {
    branch: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
    repository: { url: 'fake://origin', defaultBranch: 'main' },
    baseSha,
  };
  const withWorkspace = await fixtureHeader(FAKE_ENTRIES, workspace);
  const without = await fixtureHeader();
  const { branch, repository, workspace: path, ...rest } = withWorkspace;
  expect({
    issues: validateRunHeader(withWorkspace),
    recorded: { branch, repository, workspace: path },
    rest: JSON.stringify({ ...rest, sail: null, workflow: null }),
    without: Object.keys(without).filter((key) => ['branch', 'repository', 'workspace'].includes(key)),
  }).toEqual({
    issues: [],
    recorded: {
      branch: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
      repository: { url: 'fake://origin', defaultBranch: 'main', baseSha },
      workspace: 'workspace',
    },
    rest: JSON.stringify({ ...without, sail: null, workflow: null }),
    without: [],
  });
});

test('the header of a seeded run records its fromRun after the source and no claim, and validates', async () => {
  const fromRun = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M';
  const header = await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const { loaded, config } = await load(sail);
    return buildRunHeader({
      runId: RUN_ID,
      source: FAKE_1,
      fromRun,
      reused: 2,
      sailDir: sail,
      loaded,
      config,
      adapters: FAKE_ENTRIES,
      now: NOW,
      workspace: {
        branch: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command-seeded-kwd3n0aa',
        repository: { url: 'fake://origin', defaultBranch: 'main' },
        baseSha: 'a'.repeat(40),
      },
    });
  });
  expect([Object.keys(header), header.fromRun, validateRunHeader(header)]).toEqual([
    [
      'schema',
      'runId',
      'layout',
      'source',
      'fromRun',
      'reused',
      'workflow',
      'sail',
      'adapters',
      'intake',
      'stages',
      'budget',
      'startedAt',
      'branch',
      'repository',
      'workspace',
    ],
    fromRun,
    [],
  ]);
  expect(header.reused).toBe(2);
});

test('a header built with definitionsSha records it after startedAt, round-trips through run.json and validates; one built without it has no such key; a value that is not 40 hex is refused', async () => {
  const definitionsSha = 'c'.repeat(40);
  const withSha = await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const { loaded, config } = await load(sail);
    return buildRunHeader({
      runId: RUN_ID,
      source: FAKE_1,
      sailDir: sail,
      loaded,
      config,
      adapters: FAKE_ENTRIES,
      now: NOW,
      definitionsSha,
    });
  });
  const without = await fixtureHeader();
  const dir = tempDir();
  writeRunHeader(dir, withSha);
  const refused = (value: string) => validateRunHeader({ ...withSha, definitionsSha: value }).length;
  expect({
    recorded: withSha.definitionsSha,
    after: Object.keys(withSha).slice(Object.keys(withSha).indexOf('startedAt')),
    issues: validateRunHeader(withSha),
    readBack: readRunHeader(dir).definitionsSha,
    without: 'definitionsSha' in without,
    refused: [refused('c'.repeat(39)), refused('C'.repeat(40)), refused('main')].map((count) => count > 0),
  }).toEqual({
    recorded: definitionsSha,
    after: ['startedAt', 'definitionsSha'],
    issues: [],
    readBack: definitionsSha,
    without: false,
    refused: [true, true, true],
  });
});

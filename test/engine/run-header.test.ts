import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { type Port, type ProjectConfig, readConfig } from '../../src/engine/config';
import { type LoadedWorkflow, loadWorkflow } from '../../src/engine/load-workflow';
import { LOCAL_SOURCE } from '../../src/engine/run-dir';
import {
  type AdapterEntry,
  buildRunHeader,
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

const FAKE: AdapterEntry = { use: 'fake', origin: 'builtin' };
const FAKE_ENTRIES: Record<Port, AdapterEntry> = { ticketSource: FAKE, codeHost: FAKE, harness: FAKE, workspace: FAKE };

/** The fixture's header, built on a fresh copy, recording `adapters`. */
async function fixtureHeader(adapters: Record<Port, AdapterEntry> = FAKE_ENTRIES): Promise<RunHeader> {
  return withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const { loaded, config } = await load(sail);
    return buildRunHeader({
      runId: 'LOCAL-01M3BWNZM08Q4T6V2XRJ5KWD3N',
      source: LOCAL_SOURCE,
      sailDir: sail,
      loaded,
      config,
      adapters,
      now: NOW,
    });
  });
}

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
    "import { intake, z } from 'sail';\nexport const own = intake('own', { accepts: ['ticket'], output: z.object({}) });\n";
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
    runId: 'LOCAL-01M3BWNZM08Q4T6V2XRJ5KWD3N',
    source: { kind: 'ticket', ticketKey: 'LOCAL', via: 'cli', forced: false },
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

test('a workflow without a version is version 1, and a config without a run budget leaves budget out', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, WORKFLOW, ' version: 1,', '');
    edit(sail, 'project.yaml', 'budgets: { run: { maxUsd: 25, maxMinutes: 90 } }', 'budgets: { run: {} }');
    const { loaded, config } = await load(sail);
    const header = buildRunHeader({
      runId: 'LOCAL-1',
      source: LOCAL_SOURCE,
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

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a header records the adapters it is handed, with the versions a repository adapter declares', async () => {
  const echo: AdapterEntry = {
    use: './adapters/echo-harness.ts',
    origin: 'repo:.sail/adapters/echo-harness.ts',
    versions: { echo: '1.0.0' },
  };
  const entries: Record<Port, AdapterEntry> = { ...FAKE_ENTRIES, harness: echo };
  const header = await fixtureHeader(entries);
  expect(header.adapters).toEqual(entries);
  expect(validateRunHeader(header)).toEqual([]);
});

test('run.json is written once, read-only, and reads back equal', async () => {
  const header = await fixtureHeader();
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
  expect(readRunHeader(GOLDEN).runId).toBe('FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

  const dir = tempDir();
  const { runId: _, ...rest } = JSON.parse(readFileSync(join(GOLDEN, RUN_HEADER_FILE), 'utf8'));
  writeFileSync(join(dir, RUN_HEADER_FILE), JSON.stringify(rest));
  expect(() => readRunHeader(dir)).toThrow(/run\.json breaks sail\.run\.v1:\n.*\/runId is required/);

  writeFileSync(join(dir, RUN_HEADER_FILE), '{"schema":');
  expect(() => readRunHeader(dir)).toThrow(`${join(dir, RUN_HEADER_FILE)} is not valid JSON`);
  expect(() => readRunHeader(tempDir())).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

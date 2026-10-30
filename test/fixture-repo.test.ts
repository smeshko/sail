// The fixture repository's .sail/: the stages and ticket-to-pr workflow a repository would write. It must load in Bun
// and match the golden run, which is generated from a run of it: the same roster, and schemas that accept every output
// the golden run recorded. Its review workflow, six reviewers in one group, has no golden run: the roster compared is
// ticket-to-pr's stages, the shared ones and its own.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { StageDefinition, Step, Workflow } from '../src/sdk/index';
import { TicketInput } from '../src/sdk/intakes';

const root = join(import.meta.dir, '..');
const sail = join(import.meta.dir, 'fixtures', 'repo', '.sail');
const golden = join(import.meta.dir, 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

type Roster = Record<string, Record<string, unknown>>;
const run: { workflow: Record<string, unknown>; intake: Record<string, unknown>; stages: Roster } = JSON.parse(
  readFileSync(join(golden, 'run.json'), 'utf8'),
);
const { models } = Bun.YAML.parse(readFileSync(join(sail, 'project.yaml'), 'utf8')) as {
  models: Record<string, string>;
};

const sources = [...new Bun.Glob('**/*.ts').scanSync({ cwd: sail, dot: true })].sort();
/** Each stage folder ticket-to-pr reaches, by name: `spec` → `workflows/ticket-to-pr/stages/spec`. */
const stageFolders = new Map(
  ['stages/*/stage.ts', 'workflows/ticket-to-pr/stages/*/stage.ts']
    .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: sail })])
    .map((path) => [basename(dirname(path)), dirname(path)]),
);
const stageDirs = [...stageFolders.keys()];

type Module = Record<string, unknown>;
const load = async (path: string): Promise<Module> => import(join(sail, path));
const isDefinition = (value: unknown): value is StageDefinition =>
  typeof value === 'object' &&
  value !== null &&
  ['agent', 'script', 'stage'].includes((value as { kind: string }).kind);

/** Each stage directory's module and the definition it exports under the directory's name. */
async function stages(): Promise<Map<string, { module: Module; definition: StageDefinition }>> {
  const found = new Map<string, { module: Module; definition: StageDefinition }>();
  for (const dir of stageDirs) {
    const module = await load(`${stageFolders.get(dir)}/stage.ts`);
    const definition = Object.values(module).find((value) => isDefinition(value) && value.name === dir);
    if (isDefinition(definition)) found.set(dir, { module, definition });
  }
  return found;
}

/** The name a stage module exports a schema under, which the golden roster records as the output. */
const schemaName = (module: Module, schema: unknown): string | undefined =>
  Object.entries(module).find(([, value]) => value === schema)?.[0];

const produced = (produces: Record<string, unknown>) => {
  const names = Object.keys(produces).sort();
  return names.length > 0 ? { produces: names } : {};
};

/**
 * One step as the golden roster records it: kind, output, model and an agent's guardrails. Exit codes belong to a
 * one-step script's entry, since a stage's step entries have no field for them.
 */
function recorded(module: Module, step: Step, flat = true): Record<string, unknown> {
  return {
    kind: step.kind,
    output: schemaName(module, step.output),
    ...produced(step.produces),
    ...(step.kind === 'agent' ? { model: models[step.model ?? 'default'] } : {}),
    ...(step.kind === 'agent' ? { permissions: step.permissions, budget: step.budget } : {}),
    ...(flat && step.kind === 'script' && step.exitCodes !== undefined ? { exitCodes: step.exitCodes } : {}),
  };
}

test('the typecheck includes every fixture .ts file, though tsc skips dot-directories by default', () => {
  const tsc = Bun.spawnSync(
    [process.execPath, 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFilesOnly'],
    { cwd: root },
  );
  expect(tsc.exitCode).toBe(0);
  const listed = new Set(tsc.stdout.toString().split('\n'));
  expect(sources.length).toBe(14);
  expect(sources.filter((path) => !listed.has(join(sail, path)))).toEqual([]);
});

test('the workflow is ticket-to-pr, as the golden run recorded it', async () => {
  const workflow = (await load('workflows/ticket-to-pr/workflow.ts')).default as Workflow;
  expect(workflow).toMatchObject({ kind: 'workflow', name: run.workflow.name, version: run.workflow.version });
  expect(workflow.watch).toEqual({ every: '5m' });
  expect(workflow.maxConcurrentRuns).toBe(2);
  expect(workflow.intake.name).toBe(run.intake.name as string);
  expect(Object.keys(workflow.intake.produces).sort()).toEqual([...(run.intake.produces as string[])].sort());
  expect(workflow.intake.output).toBe(TicketInput);
});

test('each stage directory exports a definition by its name, and together they are the golden roster', async () => {
  const found = await stages();
  expect([...found.keys()].sort()).toEqual(stageDirs.sort());
  expect([...found.keys()].sort()).toEqual(Object.keys(run.stages).sort());
});

test("each golden origin is its definition's folder, in run.json and the run:start event", () => {
  const [start] = readFileSync(join(golden, 'events.ndjson'), 'utf8').split('\n');
  const event: { type: string; workflow: typeof run.workflow; roster: { stages: Roster } } = JSON.parse(start ?? '');
  expect(event.type).toBe('run:start');
  for (const recorded of [run, { ...event.roster, workflow: event.workflow }]) {
    expect(recorded.workflow.origin).toBe('repo:.sail/workflows/ticket-to-pr');
    expect(Object.keys(recorded.stages).sort()).toEqual(stageDirs.sort());
    for (const [name, entry] of Object.entries(recorded.stages)) {
      expect(entry.origin).toBe(`repo:.sail/${stageFolders.get(name)}`);
    }
  }
});

test('each stage matches its golden roster entry', async () => {
  const found = await stages();
  expect(found.size).toBe(Object.keys(run.stages).length);
  for (const [name, { module, definition }] of found) {
    const entry = { ...run.stages[name] };
    delete entry.origin;
    const actual =
      definition.kind === 'stage'
        ? {
            output: schemaName(module, definition.output),
            ...produced(definition.produces),
            steps: definition.steps.map((step) => ({ step: step.name, ...recorded(module, step, false) })),
          }
        : recorded(module, definition);
    expect(actual as Record<string, unknown>).toEqual(entry);
  }
});

test.each([
  ['the short sha git commit prints', '8954145', true],
  ['a full lowercase hex sha', '89541459e5b0696a12a6adb712334ea24cff1a31', true],
  ['a sha shorter than seven characters', '895414', false],
  ['a sha longer than forty characters', '89541459e5b0696a12a6adb712334ea24cff1a310', false],
  ['a non-hex sha', 'zzzzzzz', false],
  ['an uppercase sha', '8954145A', false],
  ['a full-length non-hex sha', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', false],
  ['a full-length uppercase sha', '89541459E5B0696A12A6ADB712334EA24CFF1A31', false],
])("implement's ChangeSet validates %s", async (_behaviour, sha, accepted) => {
  const { ChangeSet } = await import('./fixtures/repo/.sail/stages/implement/stage');
  expect(ChangeSet.safeParse({ commits: [{ sha, message: 'Make the change' }], files: [], notes: '' }).success).toBe(
    accepted,
  );
});

test('the implement prompt tells the agent to copy the sha git commit prints', () => {
  expect(readFileSync(join(sail, 'stages/implement/prompt.md'), 'utf8')).toContain(
    "Give each commit's sha as `git commit` prints it.",
  );
});

test('every golden output parses with the matching fixture schema', async () => {
  const found = await stages();
  const results = [...new Bun.Glob('**/result.json').scanSync({ cwd: golden })].sort();
  const checked: string[] = [];
  for (const path of results) {
    const result = JSON.parse(readFileSync(join(golden, path), 'utf8'));
    const [stageName, step] = parseKey(result.key);
    let schema: { parse(value: unknown): unknown };
    if (stageName === 'intake') schema = TicketInput;
    else {
      const definition = found.get(stageName)?.definition;
      if (definition === undefined) throw new Error(`${path}: no fixture stage ${stageName}`);
      const owner =
        step === undefined || definition.kind !== 'stage' ? definition : definition.steps.find((s) => s.name === step);
      if (owner === undefined) throw new Error(`${path}: stage ${stageName} has no step ${step}`);
      schema = owner.output;
    }
    expect(schema.parse(result.output)).toEqual(result.output);
    checked.push(result.key);
  }
  console.log(`${checked.length} golden outputs parse: ${checked.join(', ')}`);
  expect(checked.length).toBe(results.length);
  expect(checked.slice(-2)).toEqual(['publish#1/describe', 'publish#1/open']);
});

/** `publish#1/describe` → `['publish', 'describe']`, and `spec#1` → `['spec', undefined]`. */
function parseKey(key: string): [string, string | undefined] {
  const [call = '', step] = key.split('/');
  return [call.split('#')[0] ?? '', step];
}

test('no prompt asks the model for a count: a count a validator can derive is derived, never asked for', () => {
  const prompts = [...new Bun.Glob('**/{prompt,describe}.md').scanSync({ cwd: sail, dot: true })].sort();
  expect(prompts).toEqual([
    'stages/implement/prompt.md',
    'workflows/review/stages/architecture/prompt.md',
    'workflows/review/stages/coverage/prompt.md',
    'workflows/review/stages/performance/prompt.md',
    'workflows/review/stages/security/prompt.md',
    'workflows/review/stages/side-effects/prompt.md',
    'workflows/review/stages/style/prompt.md',
    'workflows/ticket-to-pr/stages/publish/describe.md',
    'workflows/ticket-to-pr/stages/self-review/prompt.md',
    'workflows/ticket-to-pr/stages/spec/prompt.md',
  ]);
  const asking = prompts.filter((path) =>
    /\b(how many|count|number of)\b/i.test(readFileSync(join(sail, path), 'utf8')),
  );
  expect(asking).toEqual([]);
});

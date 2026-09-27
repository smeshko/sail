// The fixture repository's .sail/: the stages and ticket-to-pr workflow a repository would write. It must load in Bun
// and match the golden run: the same roster, and schemas that accept every output the golden run recorded.
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
const stageDirs = [...new Bun.Glob('stages/*/stage.ts').scanSync({ cwd: sail })].map((path) => basename(dirname(path)));

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
    const module = await load(`stages/${dir}/stage.ts`);
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

/** One step as the golden roster records it: kind, output and model. A stage's steps go without their guardrails. */
function recorded(module: Module, step: Step, guardrails = true): Record<string, unknown> {
  return {
    kind: step.kind,
    output: schemaName(module, step.output),
    ...produced(step.produces),
    ...(step.kind === 'agent' ? { model: models[step.model ?? 'default'] } : {}),
    ...(guardrails && step.kind === 'agent' ? { permissions: step.permissions, budget: step.budget } : {}),
    ...(guardrails && step.kind === 'script' && step.exitCodes !== undefined ? { exitCodes: step.exitCodes } : {}),
  };
}

test('the typecheck includes every fixture .ts file, though tsc skips dot-directories by default', () => {
  const tsc = Bun.spawnSync(
    [process.execPath, 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFilesOnly'],
    { cwd: root },
  );
  expect(tsc.exitCode).toBe(0);
  const listed = new Set(tsc.stdout.toString().split('\n'));
  expect(sources.length).toBe(6);
  expect(sources.filter((path) => !listed.has(join(sail, path)))).toEqual([]);
});

test('the workflow is ticket-to-pr, as the golden run recorded it', async () => {
  const workflow = (await load('workflows/ticket-to-pr.ts')).default as Workflow;
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
  expect(checked).toContain('publish#1/describe');
});

/** `publish#1/describe` → `['publish', 'describe']`, and `spec#1` → `['spec', undefined]`. */
function parseKey(key: string): [string, string | undefined] {
  const [call = '', step] = key.split('/');
  return [call.split('#')[0] ?? '', step];
}

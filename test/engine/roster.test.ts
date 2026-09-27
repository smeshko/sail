import { expect, test } from 'bun:test';
import { type ProjectConfig, readConfig } from '../../src/engine/config';
import { type LoadedWorkflow, loadWorkflow } from '../../src/engine/load-workflow';
import { buildRoster, origin } from '../../src/engine/roster';
import { validateDocument } from '../../src/engine/schemas';
import { agent, intake, type StageDefinition, script, stage, type Workflow, z } from '../../src/sdk/index';
import * as intakes from '../../src/sdk/intakes';
import { copyFixture } from '../helpers/fixture';
import { withTempRepo } from '../helpers/temp-repo';

const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git diff *'] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };
const Out = z.object({ ok: z.boolean() });

const CONFIG: ProjectConfig = {
  name: 'unit',
  sail: '*',
  adapters: {
    ticketSource: { use: 'fake' },
    codeHost: { use: 'fake' },
    harness: { use: 'fake' },
    workspace: { use: 'fake' },
  },
  models: { default: 'model-default', deep: 'model-deep' },
  budgets: {},
};

/** A loaded workflow reaching `definitions`, each shared, in a module exporting `exports`. */
function loadedOf(
  definitions: StageDefinition[],
  exports: Record<string, unknown> = { Out },
  own: LoadedWorkflow['intake'] = { definition: intakes.ticket, module: { ...intakes } },
  modules: Record<string, unknown>[] = [],
): LoadedWorkflow {
  return {
    name: 'unit',
    workflow: {} as Workflow,
    dir: '/r/.sail/workflows/unit',
    files: [],
    modules: new Map(modules.map((module, i) => [`/r/.sail/m${i}.ts`, module])),
    stages: definitions.map((definition) => ({
      definition,
      dir: `/r/.sail/stages/${definition.name}`,
      module: { ...exports, [definition.name]: definition },
    })),
    intake: own,
  };
}

/** The roster entry `buildRoster` gives the one stage `definition`. */
function entryOf(definition: StageDefinition, config = CONFIG, exports?: Record<string, unknown>) {
  return buildRoster(loadedOf([definition], exports), config, '/r').stages[definition.name];
}

test('an origin is repo: and the POSIX path below the directory holding .sail/', () => {
  expect(origin('/r', '/r/.sail/stages/tests')).toBe('repo:.sail/stages/tests');
  expect(origin('/r/pkg', '/r/pkg/.sail/workflows/w/intake.ts')).toBe('repo:.sail/workflows/w/intake.ts');
});

test("the fixture's roster is its intake and the five stages ticket-to-pr reaches, with resolved values", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const loaded = await loadWorkflow(sail, 'ticket-to-pr');
    const config = readConfig(sail);
    if ('refused' in loaded || 'issues' in config) throw new Error('the fixture should load');
    const roster = buildRoster(loaded, config, repo.dir);

    expect(roster.intake).toEqual({
      name: 'ticket',
      origin: 'builtin',
      output: 'TicketInput',
      produces: ['ticket.json', 'brief.md'],
    });
    expect(Object.keys(roster.stages)).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests']);
    const review = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] };
    expect(roster.stages.spec).toEqual({
      kind: 'agent',
      origin: 'repo:.sail/workflows/ticket-to-pr/stages/spec',
      model: 'claude-opus-5-5',
      output: 'SpecOutput',
      produces: ['spec.md'],
      permissions: review,
      budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 },
    });
    expect(roster.stages.implement).toMatchObject({
      kind: 'agent',
      origin: 'repo:.sail/stages/implement',
      model: 'claude-sonnet-5',
      output: 'ChangeSet',
      produces: ['diff.patch'],
    });
    expect(roster.stages['self-review']).toMatchObject({ model: 'claude-opus-5-5', output: 'ReviewOutput' });
    expect(roster.stages.tests).toEqual({
      kind: 'script',
      origin: 'repo:.sail/stages/tests',
      output: 'TestReport',
      produces: ['junit.xml'],
      exitCodes: { passed: [0], failed: [1] },
    });
    expect(roster.stages.publish).toEqual({
      origin: 'repo:.sail/workflows/ticket-to-pr/stages/publish',
      output: 'PrInfo',
      steps: [
        {
          step: 'describe',
          kind: 'agent',
          model: 'claude-sonnet-5',
          output: 'PrDescription',
          produces: ['pr-body.md'],
          permissions: review,
          budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
        },
        { step: 'open', kind: 'script', output: 'PrInfo' },
      ],
    });

    const header = {
      schema: 'sail.run.v1',
      runId: 'LOCAL-01M3BWNZM08Q4T6V2XRJ5KWD3N',
      source: { kind: 'ticket', ticketKey: 'LOCAL', via: 'cli', forced: false },
      workflow: { name: 'ticket-to-pr', version: 1 },
      sail: { version: '0.0.0', runtime: 'bun' },
      adapters: Object.fromEntries(
        Object.keys(config.adapters).map((port) => [port, { use: 'fake', origin: 'builtin' }]),
      ),
      ...roster,
      startedAt: '2026-09-27T09:00:00.000Z',
    };
    expect(validateDocument('sail.run.v1', header)).toEqual([]);
  });
});

test('a model alias resolves through models, and one missing from it is recorded as written', () => {
  const deep = agent('deep', { prompt: './p.md', output: Out, model: 'deep', permissions, budget });
  const fast = agent('fast', { prompt: './p.md', output: Out, model: 'fast', permissions, budget });
  const plain = agent('plain', { prompt: './p.md', output: Out, permissions, budget });
  expect(entryOf(deep)?.model).toBe('model-deep');
  expect(entryOf(fast)?.model).toBe('fast');
  expect(entryOf(plain)?.model).toBe('model-default');
  const noDefault = { ...CONFIG, models: {} };
  expect(entryOf(plain, noDefault)).not.toHaveProperty('model');
});

test("an agent records its permissions as declared, network included, and leaves out what it doesn't produce", () => {
  const offline = { ...permissions, network: 'none' as const };
  const step = agent('offline', { prompt: './p.md', output: Out, permissions: offline, budget });
  expect(entryOf(step)).toEqual({
    kind: 'agent',
    origin: 'repo:.sail/stages/offline',
    model: 'model-default',
    output: 'Out',
    permissions: offline,
    budget,
  });
});

test("a script's network of none records [], a list stays, and none declared is left out", () => {
  const none = script('none', { run: './r.sh', output: Out, network: 'none' });
  const hosts = script('hosts', { run: './r.sh', output: Out, network: ['api.example.com'] });
  const unset = script('unset', { run: './r.sh', output: Out });
  expect(entryOf(none)?.network).toEqual([]);
  expect(entryOf(hosts)?.network).toEqual(['api.example.com']);
  expect(entryOf(unset)).not.toHaveProperty('network');
});

test("a script's exit codes carry the defaults, and error only when declared", () => {
  const failedOnly = script('failed-only', { run: './r.sh', output: Out, exitCodes: { failed: [2] } });
  const withError = script('with-error', { run: './r.sh', output: Out, exitCodes: { error: [3] } });
  expect(entryOf(failedOnly)?.exitCodes).toEqual({ passed: [0], failed: [2] });
  expect(entryOf(withError)?.exitCodes).toEqual({ passed: [0], failed: [1], error: [3] });
});

test("a one-step stage is recorded flat, as its step, with the stage's own files too", () => {
  const lint = script('lint', { run: './r.sh', output: Out, produces: { 'lint.txt': 'file' } });
  const one = stage('one', { output: Out, produces: { 'summary.md': 'file' }, steps: [lint] });
  expect(entryOf(one)).toEqual({
    kind: 'script',
    origin: 'repo:.sail/stages/one',
    output: 'Out',
    produces: ['lint.txt', 'summary.md'],
    exitCodes: { passed: [0], failed: [1] },
  });
});

test('a multi-step stage records its steps, and its own files when it declares any', () => {
  const first = agent('first', { prompt: './p.md', output: Out, permissions, budget });
  const last = script('last', { run: './r.sh', output: Out, network: 'none' });
  const two = stage('two', { output: Out, produces: { 'report.md': 'file' }, steps: [first, last] });
  expect(entryOf(two)).toEqual({
    origin: 'repo:.sail/stages/two',
    output: 'Out',
    produces: ['report.md'],
    steps: [
      { step: 'first', kind: 'agent', model: 'model-default', output: 'Out', permissions, budget },
      { step: 'last', kind: 'script', output: 'Out', network: [] },
    ],
  });
});

test('an output is named by its own module, then by any module in the graph, and left out when none exports it', () => {
  const Shared = z.object({ shared: z.string() });
  const Hidden = z.object({ hidden: z.string() });
  const shared = script('shared', { run: './r.sh', output: Shared });
  const hidden = script('hidden', { run: './r.sh', output: Hidden });
  const roster = buildRoster(loadedOf([shared, hidden], {}, undefined, [{ Other: Out }, { Shared }]), CONFIG, '/r');
  expect(roster.stages.shared?.output).toBe('Shared');
  expect(roster.stages.hidden).not.toHaveProperty('output');
});

test("a repository's intake records its origin, and its steps like a stage's", () => {
  const Input = z.object({ key: z.string() });
  const fetch = script('fetch', { run: './fetch.sh', output: Input, produces: { 'raw.json': 'file' } });
  const brief = agent('brief', { prompt: './brief.md', output: Input, permissions, budget });
  const one = intake('one', { accepts: ['ticket'], output: Input, steps: [fetch] });
  const two = intake('two', {
    accepts: ['ticket'],
    output: Input,
    produces: { 'brief.md': 'file' },
    steps: [fetch, brief],
  });

  const privately = { definition: one, path: '/r/.sail/workflows/unit/intake.ts', module: { Input, one } };
  expect(buildRoster(loadedOf([], {}, privately), CONFIG, '/r').intake).toEqual({
    name: 'one',
    kind: 'script',
    origin: 'repo:.sail/workflows/unit/intake.ts',
    output: 'Input',
    produces: ['raw.json'],
    exitCodes: { passed: [0], failed: [1] },
  });
  const shared = { definition: two, path: '/r/.sail/intakes/two', module: { Input, two } };
  expect(buildRoster(loadedOf([], {}, shared), CONFIG, '/r').intake).toEqual({
    name: 'two',
    origin: 'repo:.sail/intakes/two',
    output: 'Input',
    produces: ['brief.md'],
    steps: [
      { step: 'fetch', kind: 'script', output: 'Input', produces: ['raw.json'] },
      { step: 'brief', kind: 'agent', model: 'model-default', output: 'Input', permissions, budget },
    ],
  });
});

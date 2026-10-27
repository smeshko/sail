import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  loadDefinitions,
  loadStageFile,
  registerSail,
  stageFileProblem,
  stageFolder,
  stageName,
} from '../../src/engine/definitions';
import { z } from '../../src/sdk/index';
import { dropReview } from '../helpers/review-fixture';
import { withTempRepo } from '../helpers/temp-repo';

const fixture = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/**
 * A copy of the fixture's `.sail/`, whose `publish` is a stage of two steps, `describe` and `open`: these cases hold a
 * multi-step stage beside the one-step ones. The
 * copy is ticket-to-pr's alone: these cases are about its layout, and review's six reviewers would only lengthen them.
 */
function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(fixture, sail, { recursive: true });
  dropReview(sail);
  return sail;
}

/** The workflow folder `ticket-to-pr` under `sail`. */
const ticketToPr = (sail: string, ...path: string[]) => join(sail, 'workflows', 'ticket-to-pr', ...path);

/** Replaces `from` with `to` in a file, which must contain it. */
function replaceIn(file: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(file, text.replace(from, to));
}

/** Renames the stage folder at `path` under `sail` to `to`, with every import that names it, and gives its new path. */
function renameStage(sail: string, path: string, to: string): string {
  const renamed = join(sail, dirname(path), to);
  renameSync(join(sail, path), renamed);
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: sail, absolute: true })) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replaceAll(`/${basename(path)}/stage'`, `/${to}/stage'`));
  }
  return renamed;
}

test("a copy of the fixture .sail/ outside sail's tree loads its workflow, private stages and shared stages", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const shared = (name: string) => join(sail, 'stages', name, 'stage.ts');
    const owned = (name: string) => ticketToPr(sail, 'stages', name, 'stage.ts');
    expect(await loadDefinitions(sail)).toEqual({
      workflows: [
        { name: 'ticket-to-pr', intake: 'ticket', folder: 'ticket-to-pr', file: ticketToPr(sail, 'workflow.ts') },
      ],
      intakes: [],
      stages: [
        { name: 'implement', kind: 'agent', steps: [], workflow: null, file: shared('implement') },
        {
          name: 'publish',
          kind: 'stage',
          steps: [
            { name: 'describe', kind: 'agent' },
            { name: 'open', kind: 'script' },
          ],
          workflow: 'ticket-to-pr',
          file: owned('publish'),
        },
        { name: 'self-review', kind: 'agent', steps: [], workflow: 'ticket-to-pr', file: owned('self-review') },
        { name: 'spec', kind: 'agent', steps: [], workflow: 'ticket-to-pr', file: owned('spec') },
        { name: 'tests', kind: 'script', steps: [], workflow: null, file: shared('tests') },
      ],
      problems: [],
    });
  });
});

test('a workflow file outside a folder is refused with a hint to move it, and is never imported', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const flat = join(sail, 'workflows', 'flat.ts');
    writeFileSync(flat, "throw new Error('imported');\n");
    const { workflows, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([
      { file: flat, message: 'a workflow is a folder: move this file to workflows/flat/workflow.ts' },
    ]);
    expect(workflows.map((w) => w.name)).toEqual(['ticket-to-pr']);
  });
});

test('a private and a shared intake are found with their owners, and an intake.ts with none is a problem', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const declare = (name: string) =>
      "import { intake, z } from 'sail';\n" +
      `export const ${name.replace('-', '')} = intake('${name}', { accepts: ['ticket'], output: z.object({}) });\n`;
    const owned = ticketToPr(sail, 'intake.ts');
    writeFileSync(owned, declare('ticket-plus'));
    mkdirSync(join(sail, 'intakes', 'jira'), { recursive: true });
    const shared = join(sail, 'intakes', 'jira', 'intake.ts');
    writeFileSync(shared, declare('jira'));
    mkdirSync(join(sail, 'intakes', 'none'));
    const none = join(sail, 'intakes', 'none', 'intake.ts');
    writeFileSync(none, "import { z } from 'sail';\nexport const Schema = z.object({});\n");

    const { intakes, problems } = await loadDefinitions(sail);
    expect(intakes).toEqual([
      { name: 'jira', workflow: null, file: shared },
      { name: 'ticket-plus', workflow: 'ticket-to-pr', file: owned },
    ]);
    expect(problems).toEqual([{ file: none, message: 'exports no intake' }]);
  });
});

test('stageName drops a number prefix of digits then a dash, and nothing else', () => {
  expect(['10-spec', 'spec', '1-2-three', '10spec', 'v2-spec', '-spec'].map(stageName)).toEqual([
    'spec',
    'spec',
    '2-three',
    '10spec',
    'v2-spec',
    '-spec',
  ]);
});

test('stageFolder says whether a directory is a shared or a private stage folder, and nothing else is', () => {
  const at = (path: string) => stageFolder('/repo/.sail', join('/repo/.sail', path));
  expect(at('stages/10-tests')).toEqual({ workflow: null });
  expect(at('workflows/ticket-to-pr/stages/spec')).toEqual({ workflow: 'ticket-to-pr' });
  const elsewhere = ['', 'stages', 'stages/tests/deeper', 'workflows/ticket-to-pr', 'workflows/ticket-to-pr/stages'];
  for (const path of [...elsewhere, 'workflows/a/stages/b/c', 'misc/x', '../other/stages/x']) {
    expect([path, at(path)]).toEqual([path, undefined]);
  }
});

test('a numbered stage folder loads under the name it declares, private or shared', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const spec = renameStage(sail, 'workflows/ticket-to-pr/stages/spec', '10-spec');
    const tests = renameStage(sail, 'stages/tests', '20-tests');
    const { stages, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([]);
    expect(stages.map((s) => [s.name, s.file])).toEqual([
      ['implement', join(sail, 'stages', 'implement', 'stage.ts')],
      ['publish', ticketToPr(sail, 'stages', 'publish', 'stage.ts')],
      ['self-review', ticketToPr(sail, 'stages', 'self-review', 'stage.ts')],
      ['spec', join(spec, 'stage.ts')],
      ['tests', join(tests, 'stage.ts')],
    ]);
  });
});

test('a stage named unlike its folder is a problem, and adds no entry', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const spec = join(renameStage(sail, 'workflows/ticket-to-pr/stages/spec', '10-spec'), 'stage.ts');
    replaceIn(spec, "agent('spec',", "agent('specs',");
    const { stages, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([{ file: spec, message: "declares stage 'specs', but its folder 10-spec/ says 'spec'" }]);
    expect(stages.map((s) => s.name)).toEqual(['implement', 'publish', 'self-review', 'tests']);
  });
});

test('a workflow named unlike its folder is a problem, and adds no entry', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const workflow = ticketToPr(sail, 'workflow.ts');
    replaceIn(workflow, "  'ticket-to-pr',\n", "  'other',\n");
    const { workflows, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([
      { file: workflow, message: "declares workflow 'other', but its folder is 'ticket-to-pr'" },
    ]);
    expect(workflows).toEqual([]);
  });
});

test('a folder under workflows/ without a workflow.ts is a problem on the folder', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const empty = join(sail, 'workflows', 'empty');
    mkdirSync(join(empty, 'stages', 'x'), { recursive: true });
    writeFileSync(
      join(empty, 'stages', 'x', 'stage.ts'),
      "import { script, z } from 'sail';\nexport const x = script('x', { run: './x.sh', output: z.object({}) });\n",
    );
    const { workflows, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([{ file: empty, message: 'holds no workflow.ts' }]);
    expect(workflows.map((w) => w.folder)).toEqual(['ticket-to-pr']);
  });
});

test('an intake.ts exporting two intakes is a problem naming both, and adds no entry', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const file = ticketToPr(sail, 'intake.ts');
    writeFileSync(
      file,
      "import { intake, z } from 'sail';\n" +
        "export const a = intake('a', { accepts: ['ticket'], output: z.object({}) });\n" +
        "export const b = intake('b', { accepts: ['pr'], output: z.object({}) });\n",
    );
    expect(await loadDefinitions(sail)).toMatchObject({
      intakes: [],
      problems: [{ file, message: 'exports 2 intakes (a, b), and an intake.ts exports exactly one' }],
    });
  });
});

test('the loaded definitions share src/sdk: one zod', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    await loadDefinitions(sail);
    const { TestReport } = await import(join(sail, 'stages', 'tests', 'stage.ts'));
    expect(TestReport).toBeInstanceOf(z.ZodObject);
  });
});

test('a workflow that throws on import is a problem, and the rest still load', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    mkdirSync(join(sail, 'workflows', 'boom'));
    const boom = join(sail, 'workflows', 'boom', 'workflow.ts');
    writeFileSync(boom, "throw new Error('boom');\n");
    const { workflows, stages, problems } = await loadDefinitions(sail);
    expect(problems).toEqual([{ file: boom, message: 'boom' }]);
    expect(workflows.map((w) => w.name)).toEqual(['ticket-to-pr']);
    expect(stages).toHaveLength(5);
  });
});

test('a workflow file without a default workflow, and a stage.ts without a definition, are problems', async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(join(sail, 'workflows', 'named'), { recursive: true });
    mkdirSync(join(sail, 'stages', 'empty'), { recursive: true });
    const workflow = join(sail, 'workflows', 'named', 'workflow.ts');
    const stage = join(sail, 'stages', 'empty', 'stage.ts');
    writeFileSync(workflow, "import { z } from 'sail';\nexport const named = z.string();\n");
    writeFileSync(stage, "import { z } from 'sail';\nexport const Schema = z.object({});\n");
    expect(await loadDefinitions(sail)).toEqual({
      workflows: [],
      intakes: [],
      stages: [],
      problems: [
        { file: stage, message: 'exports no stage definition' },
        { file: workflow, message: 'default-exports no workflow' },
      ],
    });
  });
});

test('registering twice is harmless, and a .sail/ with neither directory loads nothing', async () => {
  registerSail();
  registerSail();
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(sail);
    expect(await loadDefinitions(sail)).toEqual({ workflows: [], intakes: [], stages: [], problems: [] });
  });
});

test('loadStageFile gives the stage definitions one stage.ts exports, each once, and two are a problem', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const tests = await loadStageFile(join(sail, 'stages', 'tests', 'stage.ts'));
    expect('definitions' in tests && tests.definitions.map((d) => [d.name, d.kind])).toEqual([['tests', 'script']]);
    const publish = await loadStageFile(ticketToPr(sail, 'stages', 'publish', 'stage.ts'));
    expect('definitions' in publish && publish.definitions.map((d) => [d.name, d.kind])).toEqual([
      ['publish', 'stage'],
    ]);

    const twice = join(sail, 'stages', 'twice', 'stage.ts');
    mkdirSync(join(sail, 'stages', 'twice'));
    writeFileSync(
      twice,
      "import { script, z } from 'sail';\n" +
        "export const a = script('a', { run: './a.sh', output: z.object({}) });\n" +
        'export const alias = a;\n' +
        "export const b = script('b', { run: './b.sh', output: z.object({}) });\n",
    );
    const loaded = await loadStageFile(twice);
    const definitions = 'definitions' in loaded ? loaded.definitions : [];
    expect(definitions.map((d) => d.name)).toEqual(['a', 'b']);
    const message = 'exports 2 stage definitions (a, b), and a stage.ts exports exactly one';
    expect(stageFileProblem(twice, definitions)).toBe(message);
    expect(await loadDefinitions(sail)).toMatchObject({ problems: [{ file: twice, message }] });
    expect((await loadDefinitions(sail)).stages.map((s) => s.name)).not.toContain('a');
  });
});

test('a stage.ts that throws on import is a problem', async () => {
  await withTempRepo(async (repo) => {
    const boom = join(repo.dir, 'stage.ts');
    writeFileSync(boom, "throw new Error('boom');\n");
    expect(await loadStageFile(boom)).toEqual({ problem: 'boom' });
  });
});

/** A `.sail/` holding one shared stage, `publish`, whose steps are `steps` and whose own bindings are `consumes`. */
function publishWith(repoDir: string, steps: string, consumes = '{}'): string {
  const sail = join(repoDir, '.sail');
  const file = join(sail, 'stages', 'publish', 'stage.ts');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `import { agent, file, fromStep, gitDiff, script, stage, z } from 'sail';
const Description = z.object({ title: z.string(), bodyFile: z.string() });
const Pr = z.object({ url: z.string() });
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] };
const budget = { maxTurns: 5, maxUsd: 1, maxMinutes: 5 };
const describe = (name: string, more = {}) =>
  agent(name, { prompt: './describe.md', produces: { 'pr-body.md': 'file' }, output: Description, permissions, budget, ...more });
const open = (consumes = {}, more = {}) => script('open', { run: './open.sh', consumes, output: Pr, ...more });
export const publish = stage('publish', { consumes: ${consumes}, output: Pr, steps: [${steps}] } as never);
`,
  );
  return sail;
}

test.each([
  [
    'a fromStep naming no step of the stage',
    "describe('describe'), open({ title: fromStep('nope').output('title') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('nope'), which names no step of the stage",
  ],
  [
    'a fromStep naming a later step',
    "describe('describe', { consumes: { url: fromStep('open').output('url') } }), open()",
    "stage 'publish': step 'describe' binds 'url' to fromStep('open'), a step that runs after it",
  ],
  [
    'a fromStep naming its own step',
    "describe('describe'), open({ pr: fromStep('open').output() })",
    "stage 'publish': step 'open' binds 'pr' to fromStep('open'), its own step",
  ],
  [
    "a file the named step doesn't produce",
    "describe('describe'), open({ body: fromStep('describe').file('x.md') })",
    "stage 'publish': step 'open' binds 'body' to fromStep('describe')'s file 'x.md', which it doesn't produce",
  ],
  [
    "an output key the named step's schema doesn't have",
    "describe('describe'), open({ title: fromStep('describe').output('titel') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'titel', which its output doesn't have",
  ],
  [
    "an output key an optional schema doesn't have",
    "describe('describe', { output: Description.optional() }), open({ title: fromStep('describe').output('titel') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'titel', which its output doesn't have",
  ],
  [
    "an output key a nullable schema doesn't have",
    "describe('describe', { output: Description.nullable() }), open({ title: fromStep('describe').output('titel') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'titel', which its output doesn't have",
  ],
  [
    "an output key a piped schema doesn't have",
    "describe('describe', { output: Description.pipe(Description) }), open({ title: fromStep('describe').output('titel') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'titel', which its output doesn't have",
  ],
  ...[
    ['a defaulted', "Description.default({ title: '', bodyFile: '' })"],
    ['a prefaulted', "Description.prefault({ title: '', bodyFile: '' })"],
    ['a caught', "Description.catch({ title: '', bodyFile: '' })"],
    ['a non-optional', 'Description.optional().nonoptional()'],
    ['a readonly', 'Description.readonly()'],
    ['a lazy', 'z.lazy(() => Description)'],
    ['an intersected', 'Description.and(Pr)'],
  ].map(([which, output]) => [
    `an output key ${which} schema doesn't have`,
    `describe('describe', { output: ${output} }), open({ title: fromStep('describe').output('titel') })`,
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'titel', which its output doesn't have",
  ]),
  [
    'an output key one member of a union lacks',
    "describe('describe', { output: z.union([Description, Pr]) }), open({ title: fromStep('describe').output('title') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'title', which its output doesn't have",
  ],
  [
    'an output key of a string schema',
    "describe('describe', { output: z.string() }), open({ title: fromStep('describe').output('title') })",
    "stage 'publish': step 'open' binds 'title' to fromStep('describe')'s output key 'title', which its output doesn't have",
  ],
  [
    'two steps of one name',
    "describe('describe'), describe('describe', { produces: {} }), open()",
    "stage 'publish': two steps are named 'describe'",
  ],
  [
    'a step named outside [a-z0-9-]+',
    "describe('Describe'), open()",
    "stage 'publish': step 'Describe' has a name outside [a-z0-9-]+",
  ],
  [
    'two steps producing one file',
    "describe('describe'), open({}, { produces: { 'pr-body.md': 'file' } })",
    "stage 'publish': steps 'describe' and 'open' both produce 'pr-body.md'",
  ],
  [
    'two bindings of a step that give one INPUT_ variable (review R1-8)',
    "describe('describe'), open({ title: fromStep('describe').output('title'), Title: fromStep('describe').output('bodyFile') })",
    "stage 'publish': step 'open': 'title' and 'Title' both give INPUT_TITLE",
  ],
  [
    'two bindings of a step written to $STAGE_IN under one name (review R1-8)',
    "describe('describe'), open({ body: fromStep('describe').file('pr-body.md'), notes: file('pr-body.md') })",
    "stage 'publish': step 'open': 'body' and 'notes' are both written to $STAGE_IN as 'pr-body.md'",
  ],
])(
  'a stage wiring its steps with %s is refused at load, naming the stage, the step and the binding, and lists no stage',
  async (_, steps, message) => {
    await withTempRepo(async (repo) => {
      const sail = publishWith(repo.dir, steps);
      const found = await loadDefinitions(sail);
      expect(found.problems).toEqual([{ file: join(sail, 'stages', 'publish', 'stage.ts'), message }]);
      expect(found.stages).toEqual([]);
    });
  },
);

test.each([
  ['optional', 'Description.optional()'],
  ['nullable', 'Description.nullable().default(null)'],
  ['piped', 'Description.pipe(Description)'],
  ['unioned', 'z.union([Description, z.object({ title: z.string() })])'],
  ['union with null', 'z.union([Description, z.null()])'],
  ['intersected', 'z.object({ title: z.string() }).and(z.object({ bodyFile: z.string() }))'],
  ['lazy', 'z.lazy(() => Description)'],
  ['any', 'z.any()'],
  ['transformed', 'Description.transform((d) => d)'],
])(
  "a stage whose step picks an output key its earlier step's %s output holds loads with no problem",
  async (_, output) => {
    await withTempRepo(async (repo) => {
      const sail = publishWith(
        repo.dir,
        `describe('describe', { output: ${output} }), open({ title: fromStep('describe').output('title') })`,
      );
      const found = await loadDefinitions(sail);
      expect(found.problems).toEqual([]);
      expect(found.stages.map((s) => s.name)).toEqual(['publish']);
    });
  },
);

test('a gitDiff the stage declares on itself, rather than on the step that reads it, is refused at load', async () => {
  await withTempRepo(async (repo) => {
    const sail = publishWith(repo.dir, "describe('describe'), open()", "{ diff: gitDiff('origin/main...HEAD') }");
    const found = await loadDefinitions(sail);
    expect(found.problems.map((problem) => problem.message)).toEqual([
      "stage 'publish': 'diff' is a gitDiff binding of the stage itself, which only a step can take",
    ]);
    expect(found.stages).toEqual([]);
  });
});

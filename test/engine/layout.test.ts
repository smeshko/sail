import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDefinitions } from '../../src/engine/definitions';
import { importGraph } from '../../src/engine/imports';
import { layoutProblems, reach } from '../../src/engine/layout';
import { withTempRepo } from '../helpers/temp-repo';

const fixture = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(fixture, sail, { recursive: true });
  return sail;
}

/** Writes `text` to `path` under `sail`, making its folder. */
function write(sail: string, path: string, text: string): string {
  const file = join(sail, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Replaces `from` with `to` in the file at `path` under `sail`, which must contain it. */
function edit(sail: string, path: string, from: string, to: string): string {
  const file = join(sail, path);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(file, text.replace(from, to));
  return file;
}

/** Loads the definitions and the import graph of `sail`, and gives each workflow's reach by name and the problems. */
async function layout(sail: string) {
  const definitions = await loadDefinitions(sail);
  expect(definitions.problems).toEqual([]);
  const result = await importGraph(sail);
  if ('internal' in result) throw new Error(result.internal);
  const reached = Object.fromEntries(
    definitions.workflows.map((w) => [w.name, reach(w, definitions, result.graph).map((s) => s.name)]),
  );
  return { reached, problems: layoutProblems(sail, definitions, result.graph) };
}

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const IMPLEMENT = 'stages/implement/stage.ts';
const SELF_REVIEW = 'workflows/ticket-to-pr/stages/self-review/stage.ts';
const FINDING = `export const Finding = z.object({
  severity: z.enum(['high', 'medium', 'low', 'nit']),
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});
`;

/** A workflow `name` whose body runs `spec`, imported from `from`. */
const specWorkflow = (name: string, from: string) =>
  "import { workflow } from 'sail';\n" +
  "import { ticket } from 'sail/intakes';\n" +
  `import { spec } from '${from}';\n\n` +
  `export default workflow('${name}', { intake: ticket }, async (run) => {\n` +
  "  await run.stage(spec, { brief: run.intake.files['brief.md'] });\n" +
  '});\n';

test("ticket-to-pr reaches its five stages, though self-review's stage.ts also imports implement", async () => {
  await withTempRepo(async (repo) => {
    expect(await layout(copyFixture(repo.dir))).toEqual({
      reached: { 'ticket-to-pr': ['implement', 'publish', 'self-review', 'spec', 'tests'] },
      problems: [],
    });
  });
});

test('a stage imported through a helper is reached', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(sail, 'workflows/ticket-to-pr/helpers.ts', "export { tests } from '../../stages/tests/stage';\n");
    edit(sail, WORKFLOW, "from '../../stages/tests/stage'", "from './helpers'");
    const { reached, problems } = await layout(sail);
    expect(reached['ticket-to-pr']).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests']);
    expect(problems).toEqual([]);
  });
});

test('an import cycle between two helpers ends, and they reach nothing', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(sail, 'workflows/ticket-to-pr/a.ts', "import type { B } from './b';\nexport type A = { b?: B };\n");
    write(sail, 'workflows/ticket-to-pr/b.ts', "import type { A } from './a';\nexport type B = { a?: A };\n");
    edit(
      sail,
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nimport type { A } from './a';\nexport type Helped = A;",
    );
    const { reached, problems } = await layout(sail);
    expect(reached['ticket-to-pr']).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests']);
    expect(problems).toEqual([]);
  });
});

test("the walk stops at an intake.ts: a stage only the workflow's intake imports isn't reached", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(
      sail,
      'stages/lint/stage.ts',
      "import { script, z } from 'sail';\n" +
        'export const LintReport = z.object({ ok: z.boolean() });\n' +
        "export const lint = script('lint', { run: './run.sh', output: LintReport });\n",
    );
    write(
      sail,
      'workflows/ticket-to-pr/intake.ts',
      "import { intake } from 'sail';\n" +
        "import { LintReport } from '../../stages/lint/stage';\n" +
        "export const linted = intake('linted', { accepts: ['ticket'], output: LintReport });\n",
    );
    edit(
      sail,
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nexport { linted } from './intake';",
    );
    const { reached, problems } = await layout(sail);
    expect(reached['ticket-to-pr']).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests']);
    expect(problems).toEqual([]);
  });
});

test("another workflow importing ticket-to-pr's private stage is a problem on its workflow.ts", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const other = write(
      sail,
      'workflows/other/workflow.ts',
      specWorkflow('other', '../ticket-to-pr/stages/spec/stage'),
    );
    expect(await layout(sail)).toEqual({
      reached: { other: ['spec'], 'ticket-to-pr': ['implement', 'publish', 'self-review', 'spec', 'tests'] },
      problems: [
        {
          file: other,
          message: 'imports workflows/ticket-to-pr/stages/spec/stage.ts, which is private to workflow ticket-to-pr',
        },
      ],
    });
  });
});

test.each([
  [
    'a value import',
    (sail: string) => {
      edit(sail, SELF_REVIEW, "import { Finding } from '../../../../stages/implement/stage';\n", FINDING);
      edit(sail, IMPLEMENT, FINDING, '');
      return edit(
        sail,
        IMPLEMENT,
        "import { TestReport } from '../tests/stage';",
        "import { TestReport } from '../tests/stage';\n" +
          "import { Finding } from '../../workflows/ticket-to-pr/stages/self-review/stage';",
      );
    },
  ],
  [
    'a type-only import',
    (sail: string) =>
      edit(
        sail,
        IMPLEMENT,
        "import { TestReport } from '../tests/stage';",
        "import { TestReport } from '../tests/stage';\n" +
          "import type { ReviewOutput } from '../../workflows/ticket-to-pr/stages/self-review/stage';\n" +
          'export type Review = z.infer<typeof ReviewOutput>;',
      ),
  ],
])(
  'the shared implement importing from the private self-review, as %s, is a problem on implement',
  async (_, breach) => {
    await withTempRepo(async (repo) => {
      const sail = copyFixture(repo.dir);
      const implement = breach(sail);
      expect((await layout(sail)).problems).toEqual([
        {
          file: implement,
          message:
            'imports workflows/ticket-to-pr/stages/self-review/stage.ts, which is private to workflow ticket-to-pr',
        },
      ]);
    });
  },
);

test('a workflow reaching a private and a shared stage named alike is a problem naming both', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    cpSync(join(sail, 'stages', 'tests'), join(sail, 'workflows', 'ticket-to-pr', 'stages', 'tests'), {
      recursive: true,
    });
    const workflow = edit(
      sail,
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nimport { tests as ownTests } from './stages/tests/stage';\nexport const own = ownTests;",
    );
    const { reached, problems } = await layout(sail);
    expect(reached['ticket-to-pr']).toEqual(['implement', 'publish', 'self-review', 'spec', 'tests', 'tests']);
    expect(problems).toEqual([
      {
        file: workflow,
        message:
          "reaches two stages named 'tests': stages/tests/stage.ts and workflows/ticket-to-pr/stages/tests/stage.ts",
      },
    ]);
  });
});

test('two workflows may each have a private stage of the same name', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    cpSync(
      join(sail, 'workflows', 'ticket-to-pr', 'stages', 'spec'),
      join(sail, 'workflows', 'other', 'stages', 'spec'),
      {
        recursive: true,
      },
    );
    write(sail, 'workflows/other/workflow.ts', specWorkflow('other', './stages/spec/stage'));
    expect(await layout(sail)).toEqual({
      reached: { other: ['spec'], 'ticket-to-pr': ['implement', 'publish', 'self-review', 'spec', 'tests'] },
      problems: [],
    });
  });
});

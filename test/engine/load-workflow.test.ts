import { expect, test } from 'bun:test';
import { cpSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type LoadedWorkflow, loadWorkflow } from '../../src/engine/load-workflow';
import * as intakes from '../../src/sdk/intakes';
import { copyFixture, edit, write } from '../helpers/fixture';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

/** Loads `name` from `sail`, which must not be refused. */
async function loaded(sail: string, name = 'ticket-to-pr'): Promise<LoadedWorkflow> {
  const result = await loadWorkflow(sail, name);
  if ('refused' in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

/** Loads `name` from `sail`, which must be refused, and gives the reason. */
async function refused(sail: string, name = 'ticket-to-pr'): Promise<string> {
  const result = await loadWorkflow(sail, name);
  if (!('refused' in result)) throw new Error(`loaded ${result.name}`);
  return result.refused;
}

/** An intake declared in a file of its own. */
const intakeFile = (name: string) =>
  "import { intake, z } from 'sail';\n" +
  `export const own = intake('${name}', { accepts: ['ticket'], output: z.object({ key: z.string() }) });\n`;

test('ticket-to-pr loads with its private and shared stages, the built-in intake and every file it imports', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const workflow = await loaded(sail);
    expect(workflow.name).toBe('ticket-to-pr');
    expect(workflow.workflow.kind).toBe('workflow');
    expect(workflow.dir).toBe(join(sail, 'workflows', 'ticket-to-pr'));
    expect(workflow.stages.map((stage) => [stage.definition.name, relative(sail, stage.dir)])).toEqual([
      ['implement', 'stages/implement'],
      ['publish', 'workflows/ticket-to-pr/stages/publish'],
      ['self-review', 'workflows/ticket-to-pr/stages/self-review'],
      ['spec', 'workflows/ticket-to-pr/stages/spec'],
      ['tests', 'stages/tests'],
    ]);
    // The definitions are the objects the workflow imported, found in their own modules' exports.
    const selfReview = workflow.stages.find((stage) => stage.definition.name === 'self-review');
    expect(selfReview?.module.selfReview).toBe(selfReview?.definition);
    expect(workflow.intake).toEqual({ definition: intakes.ticket, module: intakes });
    expect(workflow.intake.definition).toBe(intakes.ticket);
    expect('path' in workflow.intake).toBe(false);
    expect(workflow.files.map((file) => relative(sail, file))).toEqual([
      'stages/implement/stage.ts',
      'stages/tests/stage.ts',
      'workflows/ticket-to-pr/stages/publish/stage.ts',
      'workflows/ticket-to-pr/stages/self-review/stage.ts',
      'workflows/ticket-to-pr/stages/spec/stage.ts',
      'workflows/ticket-to-pr/workflow.ts',
    ]);
  });
});

test.each([['../x'], ['Foo'], ['']])('the name %p is refused before anything is read', async (name) => {
  expect(await refused('/nowhere/.sail', name)).toBe(
    `'${name}' is not a workflow name: lowercase letters, digits and dashes`,
  );
});

test('an unknown workflow is refused, naming the file it looked for', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    expect(await refused(sail, 'nope')).toBe("no workflow 'nope': .sail/workflows/nope/workflow.ts doesn't exist");
  });
});

test.each([
  [
    'throws on import',
    (sail: string) => edit(sail, WORKFLOW, "import { workflow } from 'sail';", "throw new Error('boom');"),
    'boom',
  ],
  [
    'default-exports no workflow',
    (sail: string) => edit(sail, WORKFLOW, 'export default workflow(', 'export const notDefault = workflow('),
    'default-exports no workflow',
  ],
  [
    'declares a name unlike its folder',
    (sail: string) => edit(sail, WORKFLOW, "workflow(\n  'ticket-to-pr',", "workflow(\n  'other',"),
    "declares workflow 'other', but its folder is 'ticket-to-pr'",
  ],
])('a workflow that %s is refused, naming its file', async (_, breakIt, message) => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    breakIt(sail);
    expect(await refused(sail)).toBe(`.sail/${WORKFLOW}: ${message}`);
  });
});

test('a workflow reaching a private and a shared stage both named tests is refused, naming both', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    cpSync(join(sail, 'stages', 'tests'), join(sail, 'workflows', 'ticket-to-pr', 'stages', 'tests'), {
      recursive: true,
    });
    edit(
      sail,
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nimport { tests as ownTests } from './stages/tests/stage';\nexport const own = ownTests;",
    );
    expect(await refused(sail)).toBe(
      `.sail/${WORKFLOW}: reaches two stages named 'tests': stages/tests/stage.ts and ` +
        'workflows/ticket-to-pr/stages/tests/stage.ts',
    );
  });
});

test('a reached stage with a problem refuses the run, and a problem elsewhere does not', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    // An unrelated workflow that breaks the layout, and one that won't import.
    write(
      sail,
      'workflows/other/workflow.ts',
      "import { spec } from '../ticket-to-pr/stages/spec/stage';\nexport const s = spec;\n",
    );
    write(sail, 'workflows/broken/workflow.ts', "throw new Error('broken');\n");
    expect((await loaded(sail)).stages).toHaveLength(5);
    expect(await refused(sail, 'other')).toBe(
      '.sail/workflows/other/workflow.ts: default-exports no workflow\n' +
        '.sail/workflows/other/workflow.ts: imports workflows/ticket-to-pr/stages/spec/stage.ts, ' +
        'which is private to workflow ticket-to-pr',
    );
  });
});

test('a stage the workflow reaches through a problem file is refused, naming that file', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'stages/tests/stage.ts', "script('tests',", "script('unit-tests',");
    expect(await refused(sail)).toBe(
      ".sail/stages/tests/stage.ts: declares stage 'unit-tests', but its folder tests/ says 'tests'",
    );
  });
});

test('a private intake.ts gives the intake with its file, and a shared one with its folder', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(sail, 'workflows/ticket-to-pr/intake.ts', intakeFile('ticket-plus'));
    edit(sail, WORKFLOW, "import { ticket } from 'sail/intakes';", "import { own as ticket } from './intake';");
    const privately = await loaded(sail);
    expect(privately.intake.definition.name).toBe('ticket-plus');
    expect(privately.intake.path).toBe(join(sail, 'workflows', 'ticket-to-pr', 'intake.ts'));
    expect(privately.intake.module.own).toBe(privately.intake.definition);
    expect(privately.files).toContain(join(sail, 'workflows', 'ticket-to-pr', 'intake.ts'));
  });
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(sail, 'intakes/jira/intake.ts', intakeFile('jira'));
    edit(
      sail,
      WORKFLOW,
      "import { ticket } from 'sail/intakes';",
      "import { own as ticket } from '../../intakes/jira/intake';",
    );
    const shared = await loaded(sail);
    expect(shared.intake.definition.name).toBe('jira');
    expect(shared.intake.path).toBe(join(sail, 'intakes', 'jira'));
  });
});

test('an intake that is neither built in nor exported by an intake.ts the workflow imports is refused', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(
      sail,
      WORKFLOW,
      "import { ticket } from 'sail/intakes';",
      "import { intake } from 'sail';\nimport { TicketInput } from 'sail/intakes';\n" +
        "const ticket = intake('inline', { accepts: ['ticket'], output: TicketInput });",
    );
    expect(await refused(sail)).toBe(
      `.sail/${WORKFLOW}: its intake 'inline' is neither built in nor exported by an intake.ts it imports`,
    );
  });
});

test('a workflow whose imports are gone is refused, naming each file that no longer imports', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    rmSync(join(sail, 'stages'), { recursive: true });
    const lines = (await refused(sail)).split('\n');
    expect(lines.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([
      '.sail/workflows/ticket-to-pr/stages/self-review/stage.ts',
      `.sail/${WORKFLOW}`,
    ]);
    expect(lines[1]).toContain("Cannot find module '../../stages/implement/stage'");
  });
});

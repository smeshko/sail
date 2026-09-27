import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDefinitions, registerSail } from '../../src/engine/definitions';
import { z } from '../../src/sdk/index';
import { withTempRepo } from '../helpers/temp-repo';

const fixture = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(fixture, sail, { recursive: true });
  return sail;
}

test("a copy of the fixture .sail/ outside sail's tree loads its workflow and stages", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const stage = (name: string) => join(sail, 'stages', name, 'stage.ts');
    expect(await loadDefinitions(sail)).toEqual({
      workflows: [{ name: 'ticket-to-pr', intake: 'ticket', file: join(sail, 'workflows', 'ticket-to-pr.ts') }],
      stages: [
        { name: 'implement', kind: 'agent', steps: [], file: stage('implement') },
        {
          name: 'publish',
          kind: 'stage',
          steps: [
            { name: 'describe', kind: 'agent' },
            { name: 'open', kind: 'script' },
          ],
          file: stage('publish'),
        },
        { name: 'self-review', kind: 'agent', steps: [], file: stage('self-review') },
        { name: 'spec', kind: 'agent', steps: [], file: stage('spec') },
        { name: 'tests', kind: 'script', steps: [], file: stage('tests') },
      ],
      problems: [],
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
    const boom = join(sail, 'workflows', 'boom.ts');
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
    mkdirSync(join(sail, 'workflows'), { recursive: true });
    mkdirSync(join(sail, 'stages', 'empty'), { recursive: true });
    const workflow = join(sail, 'workflows', 'named.ts');
    const stage = join(sail, 'stages', 'empty', 'stage.ts');
    writeFileSync(workflow, "import { z } from 'sail';\nexport const named = z.string();\n");
    writeFileSync(stage, "import { z } from 'sail';\nexport const Schema = z.object({});\n");
    expect(await loadDefinitions(sail)).toEqual({
      workflows: [],
      stages: [],
      problems: [
        { file: workflow, message: 'default-exports no workflow' },
        { file: stage, message: 'exports no stage definition' },
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
    expect(await loadDefinitions(sail)).toEqual({ workflows: [], stages: [], problems: [] });
  });
});

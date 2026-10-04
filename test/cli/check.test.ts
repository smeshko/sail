// `sail check`, in process through run(): the lookup, project.yaml, the type-check and the definitions, in order.
import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

const inRepoFixture = join(import.meta.dir, '..', 'fixtures', 'repo');
const BROKEN = "s.files['spec.md'], feedback";

function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(join(inRepoFixture, '.sail'), sail, { recursive: true });
  return sail;
}

function subdirectory(repoDir: string): string {
  const deep = join(repoDir, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  return deep;
}

function nodeModulesAbove(dir: string): string[] {
  const found: string[] = [];
  for (let at = dirname(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) found.push(at);
    if (dirname(at) === at) return found;
  }
}

/** Wires run.input where implement takes spec.md, and returns where tsc reports it: `line:column`. */
function breakBinding(sail: string): string {
  const workflow = join(sail, 'workflows', 'ticket-to-pr', 'workflow.ts');
  const mutated = readFileSync(workflow, 'utf8').replace(BROKEN, 'run.input, feedback');
  writeFileSync(workflow, mutated);
  const lines = mutated.split('\n');
  const index = lines.findIndex((text) => text.includes('spec: run.input'));
  return `${index + 1}:${(lines[index] ?? '').indexOf('spec: run.input') + 1}`;
}

test('check --list in the in-repo fixture groups its stages under its workflow, then lists the shared ones', async () => {
  expect(await runCaptured(['check', '--list'], inRepoFixture)).toEqual({
    code: EXIT_OK,
    stdout: [
      '.sail/ checked: 1 workflow, 5 stages',
      '',
      'workflows',
      '  ticket-to-pr  intake ticket  .sail/workflows/ticket-to-pr/workflow.ts',
      '    private',
      '      publish      stage   describe (agent), open (script)',
      '      self-review  agent',
      '      spec         agent',
      '    shared',
      '      implement    agent',
      '      tests        script',
      '',
      'shared stages',
      '  implement  agent   used by ticket-to-pr  .sail/stages/implement/stage.ts',
      '  tests      script  used by ticket-to-pr  .sail/stages/tests/stage.ts',
      '',
    ].join('\n'),
    stderr: '',
  });
});

test('check --list orders private stages by folder, intake first, and marks a shared stage no one uses', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(sail, path)), { recursive: true });
      writeFileSync(join(sail, path), text);
    };
    const scriptStage = (name: string) =>
      `import { script, z } from 'sail';\nexport const ${name} = script('${name}', { run: './run.sh', output: z.object({}) });\n`;
    write('workflows/other/stages/20-spec/stage.ts', scriptStage('spec'));
    write('workflows/other/stages/10-lint/stage.ts', scriptStage('lint'));
    write('stages/format/stage.ts', scriptStage('format'));
    write(
      'workflows/other/intake.ts',
      "import { intake, z } from 'sail';\n" +
        "export const ticketed = intake('ticketed', { accepts: ['ticket'], output: z.object({ key: z.string() }) });\n",
    );
    write(
      'workflows/other/workflow.ts',
      "import { workflow } from 'sail';\n" +
        "import { tests } from '../../stages/tests/stage';\n" +
        "import { ticketed } from './intake';\n" +
        "import { lint } from './stages/10-lint/stage';\n" +
        "import { spec } from './stages/20-spec/stage';\n\n" +
        "export default workflow('other', { intake: ticketed }, async (run) => {\n" +
        '  await run.stage(lint);\n' +
        '  await run.stage(spec);\n' +
        '  await run.stage(tests);\n' +
        '});\n',
    );
    expect(await runCaptured(['check', '--list'], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: [
        '.sail/ checked: 2 workflows, 8 stages',
        '',
        'workflows',
        '  other         intake ticketed  .sail/workflows/other/workflow.ts',
        '    private',
        '      ticketed     intake',
        '      lint         script',
        '      spec         script',
        '    shared',
        '      tests        script',
        '  ticket-to-pr  intake ticket    .sail/workflows/ticket-to-pr/workflow.ts',
        '    private',
        '      publish      stage   describe (agent), open (script)',
        '      self-review  agent',
        '      spec         agent',
        '    shared',
        '      implement    agent',
        '      tests        script',
        '',
        'shared stages',
        '  format     script  unused                       .sail/stages/format/stage.ts',
        '  implement  agent   used by ticket-to-pr         .sail/stages/implement/stage.ts',
        '  tests      script  used by other, ticket-to-pr  .sail/stages/tests/stage.ts',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});

test('check without --list prints only the summary', async () => {
  expect(await runCaptured(['check'], inRepoFixture)).toEqual({
    code: EXIT_OK,
    stdout: '.sail/ checked: 1 workflow, 5 stages\n',
    stderr: '',
  });
});

test('a copy of the fixture checks from a subdirectory with no node_modules in reach', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['check', '--list'], subdirectory(repo.dir));
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toStartWith('../../.sail/ checked: 1 workflow, 5 stages\n');
    expect(stdout).toContain('  ../../.sail/workflows/ticket-to-pr/workflow.ts\n');
    expect(stdout).toContain('used by ticket-to-pr  ../../.sail/stages/tests/stage.ts\n');
    expect(stdout).not.toContain(repo.dir);
    expect(nodeModulesAbove(repo.dir)).toEqual([]);
    expect([...new Bun.Glob('**/node_modules').scanSync({ cwd: repo.dir, dot: true, onlyFiles: false })]).toEqual([]);
  });
});

test('a wrongly wired binding is refused with its location relative to the working directory', async () => {
  await withTempRepo(async (repo) => {
    const at = breakBinding(copyFixture(repo.dir));
    const { code, stdout, stderr } = await runCaptured(['check'], subdirectory(repo.dir));
    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toBe('');
    expect(stderr).toStartWith(`../../.sail/workflows/ticket-to-pr/workflow.ts:${at}  TS2739  Type '`);
    expect(stderr).toEndWith('sail check: 1 type error in ../../.sail/\n');
  });
});

test.each([
  ['a missing project.yaml', () => '', '/ is missing'],
  ['an unknown key', (text: string) => `${text}bogus: 1\n`, '/bogus is not allowed'],
  ['no name', (text: string) => text.replace(/^name: .*\n/m, ''), '/name is required'],
])('%s is refused, naming the file and the path', async (label, edit, problem) => {
  await withTempRepo(async (repo) => {
    const project = join(copyFixture(repo.dir), 'project.yaml');
    const text = edit(readFileSync(project, 'utf8'));
    if (label === 'a missing project.yaml') rmSync(project);
    else writeFileSync(project, text);
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `.sail/project.yaml  [sail.project.v1]  ${problem}\n`,
    });
  });
});

test('a repository with no .sail/ is refused', async () => {
  await withTempRepo(async (repo) => {
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail check: no .sail/ between ${repo.dir} and the git root ${repo.dir}\n`,
    });
  });
});

test('a directory outside any git repository is refused', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sail-no-git-')));
  try {
    expect(await runCaptured(['check'], outside)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail check: not inside a git repository: ${outside}\n`,
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a stage named unlike its folder is refused, naming the file', async () => {
  await withTempRepo(async (repo) => {
    const stage = join(copyFixture(repo.dir), 'workflows', 'ticket-to-pr', 'stages', 'spec', 'stage.ts');
    writeFileSync(stage, readFileSync(stage, 'utf8').replace("agent('spec',", "agent('specs',"));
    expect(await runCaptured(['check'], subdirectory(repo.dir))).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        "../../.sail/workflows/ticket-to-pr/stages/spec/stage.ts  declares stage 'specs', but its folder spec/ says 'spec'\n",
    });
  });
});

test("a workflow importing another's private stage is refused, naming the importing file", async () => {
  await withTempRepo(async (repo) => {
    const other = join(copyFixture(repo.dir), 'workflows', 'other');
    mkdirSync(other);
    writeFileSync(
      join(other, 'workflow.ts'),
      "import { workflow } from 'sail';\n" +
        "import { ticket } from 'sail/intakes';\n" +
        "import { spec } from '../ticket-to-pr/stages/spec/stage';\n\n" +
        "export default workflow('other', { intake: ticket }, async (run) => {\n" +
        "  await run.stage(spec, { brief: run.intake.files['brief.md'] });\n" +
        '});\n',
    );
    expect(await runCaptured(['check'], subdirectory(repo.dir))).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        '../../.sail/workflows/other/workflow.ts  imports workflows/ticket-to-pr/stages/spec/stage.ts, which is private ' +
        'to workflow ticket-to-pr\n',
    });
  });
});

test('a workflow reaching two stages named alike is refused, naming its workflow.ts and both stages', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const owned = join(sail, 'workflows', 'ticket-to-pr');
    cpSync(join(sail, 'stages', 'tests'), join(owned, 'stages', 'tests'), { recursive: true });
    const workflow = join(owned, 'workflow.ts');
    writeFileSync(
      workflow,
      readFileSync(workflow, 'utf8').replace(
        "import { workflow } from 'sail';",
        "import { workflow } from 'sail';\nimport { tests as ownTests } from './stages/tests/stage';\nexport const own = ownTests;",
      ),
    );
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        ".sail/workflows/ticket-to-pr/workflow.ts  reaches two stages named 'tests': stages/tests/stage.ts and " +
        'workflows/ticket-to-pr/stages/tests/stage.ts\n',
    });
  });
});

test('a workflow that throws on import is refused, naming the file', async () => {
  await withTempRepo(async (repo) => {
    const boom = join(copyFixture(repo.dir), 'workflows', 'boom');
    mkdirSync(boom);
    writeFileSync(join(boom, 'workflow.ts'), "throw new Error('boom');\n");
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: '.sail/workflows/boom/workflow.ts  boom\n',
    });
  });
});

test('a sail range the running version does not satisfy is refused, naming the file and /sail', async () => {
  await withTempRepo(async (repo) => {
    const project = join(copyFixture(repo.dir), 'project.yaml');
    writeFileSync(project, readFileSync(project, 'utf8').replace('>=0.0.0 <1', '>=1.0 <2'));
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `.sail/project.yaml  /sail is '>=1.0 <2', which sail ${pkg.version} doesn't satisfy\n`,
    });
  });
});

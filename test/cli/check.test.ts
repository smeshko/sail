// `sail check`, in process through run(): the lookup, project.yaml, the type-check and the definitions, in order.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { editorDeclarations } from '../../src/engine/editor';
import { writePublish } from '../helpers/fixture';
import { dropReview } from '../helpers/review-fixture';
import { runCaptured } from '../helpers/run-captured';
import { copyRun, writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

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
      '.sail/ checked: 2 workflows, 12 stages',
      '',
      'workflows',
      '  review        intake ticket  .sail/workflows/review/workflow.ts',
      '    private',
      '      architecture  agent',
      '      coverage      agent',
      '      performance   agent',
      '      security      agent',
      '      side-effects  agent',
      '      style         agent',
      '  ticket-to-pr  intake ticket  .sail/workflows/ticket-to-pr/workflow.ts',
      '    private',
      '      describe      agent',
      '      open          script',
      '      self-review   agent',
      '      spec          agent',
      '    shared',
      '      implement     agent',
      '      tests         script',
      '',
      'shared stages',
      '  implement  agent   used by ticket-to-pr  .sail/stages/implement/stage.ts',
      '  tests      script  used by ticket-to-pr  .sail/stages/tests/stage.ts',
      '',
    ].join('\n'),
    stderr: '',
  });
});

test('check --list orders private stages by folder, intake first, lists a multi-step stage with its steps, and marks a shared stage no one uses', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    dropReview(sail);
    writePublish(sail);
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
    stdout: '.sail/ checked: 2 workflows, 12 stages\n',
    stderr: '',
  });
});

test('a copy of the fixture checks from a subdirectory with no node_modules in reach', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['check', '--list'], subdirectory(repo.dir));
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toStartWith('../../.sail/ checked: 2 workflows, 12 stages\n');
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

test('a watched workflow with a cap of 0, written past the types, is refused, naming its workflow.ts', async () => {
  await withTempRepo(async (repo) => {
    const workflow = join(copyFixture(repo.dir), 'workflows', 'ticket-to-pr', 'workflow.ts');
    const text = readFileSync(workflow, 'utf8');
    expect(text).toContain('maxConcurrentRuns: 2 }');
    writeFileSync(workflow, text.replace('maxConcurrentRuns: 2 }', 'maxConcurrentRuns: 0 as never }'));
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        '.sail/workflows/ticket-to-pr/workflow.ts  has maxConcurrentRuns 0, which is not a whole number of 1 or more\n',
    });
  });
});

test('a watched workflow whose own intake accepts only pr is refused, naming its workflow.ts', async () => {
  await withTempRepo(async (repo) => {
    const reviews = join(copyFixture(repo.dir), 'workflows', 'reviews');
    mkdirSync(reviews);
    writeFileSync(
      join(reviews, 'intake.ts'),
      "import { intake, z } from 'sail';\n\n" +
        "export const reviewIntake = intake('reviews', { accepts: ['pr'], output: z.object({}) });\n",
    );
    writeFileSync(
      join(reviews, 'workflow.ts'),
      "import { workflow } from 'sail';\n" +
        "import { reviewIntake } from './intake';\n\n" +
        "export default workflow('reviews', { intake: reviewIntake, watch: { every: '5m' }, maxConcurrentRuns: 1 }, " +
        'async () => {});\n',
    );
    expect(await runCaptured(['check'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        ".sail/workflows/reviews/workflow.ts  its intake 'reviews' accepts pr, and sail polls only ticket sources so far\n",
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

test('run.stage() given an intake is a type error sail check reports with exit 3, at its line in workflow.ts', async () => {
  await withTempRepo(async (repo) => {
    const workflow = join(copyFixture(repo.dir), 'workflows', 'ticket-to-pr', 'workflow.ts');
    const first = '    const s = await run.stage(spec,';
    const text = readFileSync(workflow, 'utf8').replace(first, `    await run.stage(ticket);\n${first}`);
    writeFileSync(workflow, text);
    const line = text.split('\n').findIndex((each) => each.includes('run.stage(ticket)')) + 1;
    expect(line).toBeGreaterThan(1);

    const { code, stdout, stderr } = await runCaptured(['check'], repo.dir);
    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toBe('');
    expect(stderr).toStartWith(`.sail/workflows/ticket-to-pr/workflow.ts:${line}:`);
    expect(stderr).toContain('  TS2345  ');
    expect(stderr).toEndWith('sail check: 1 type error in .sail/\n');
  });
});

// The editor declarations (D15): `sail check` rewrites the ones that are missing or stale, where a `tsconfig.json` shows
// the repository uses them.

const CONFIG = `name: clone
sail: ">=0.0.0 <1"
adapters:
  ticketSource: { use: fake }
  codeHost: { use: fake }
  harness: { use: fake }
  workspace: { use: fake }
`;
const DECLARATIONS = ['sail.d.ts', 'sail-intakes.d.ts'];
const WROTE_BOTH = 'sail check: wrote .sail/sail.d.ts and .sail/sail-intakes.d.ts for the editor\n';
const CHECKED_NONE = '.sail/ checked: 0 workflows, 0 stages\n';

/**
 * A fresh clone of a repository that uses the editor declarations: a `.sail/` with a config and a `tsconfig.json`, and
 * neither declaration, since git ignores them. The check never reads `tsconfig.json`, so it holds nothing here.
 */
function clone(repo: TempRepo): string {
  const sail = join(repo.dir, '.sail');
  mkdirSync(sail);
  writeFileSync(join(sail, 'project.yaml'), CONFIG);
  writeFileSync(join(sail, 'tsconfig.json'), '{}\n');
  return sail;
}

/** Each editor declaration in `sail`: what it holds, or null when it isn't there. */
const declared = (sail: string): (string | null)[] =>
  DECLARATIONS.map((name) => (existsSync(join(sail, name)) ? readFileSync(join(sail, name), 'utf8') : null));
/** What each editor declaration should hold on this machine. */
const current = (): string[] => editorDeclarations().map((declaration) => declaration.text);
const checked = (repo: TempRepo, ...args: string[]) => runCaptured(['check', ...args], repo.dir, { env: repo.env });

test('in a .sail/ with a tsconfig.json and no editor declarations, sail check writes both, says so, then prints its checked line and exits 0; with both current it writes nothing and says nothing', async () => {
  await withTempRepo(async (repo) => {
    const sail = clone(repo);
    expect(await checked(repo)).toEqual({ code: EXIT_OK, stdout: `${WROTE_BOTH}${CHECKED_NONE}`, stderr: '' });
    expect(declared(sail)).toEqual(current());
    expect(readdirSync(sail).sort()).toEqual(['project.yaml', 'sail-intakes.d.ts', 'sail.d.ts', 'tsconfig.json']);

    const stamps = DECLARATIONS.map((name) => statSync(join(sail, name)).mtimeMs);
    await Bun.sleep(20);
    expect(await checked(repo)).toEqual({ code: EXIT_OK, stdout: CHECKED_NONE, stderr: '' });
    expect(DECLARATIONS.map((name) => statSync(join(sail, name)).mtimeMs)).toEqual(stamps);
  });
});

test('with one declaration naming another path, it rewrites that one alone and names it alone', async () => {
  await withTempRepo(async (repo) => {
    const sail = clone(repo);
    await checked(repo);
    const kept = existsSync(join(sail, 'sail.d.ts')) ? statSync(join(sail, 'sail.d.ts')).mtimeMs : 0;
    writeFileSync(join(sail, 'sail-intakes.d.ts'), 'export * from "/another/machine/sail/types/intakes";\n');
    await Bun.sleep(20);
    expect(await checked(repo)).toEqual({
      code: EXIT_OK,
      stdout: `sail check: wrote .sail/sail-intakes.d.ts for the editor\n${CHECKED_NONE}`,
      stderr: '',
    });
    expect(declared(sail)).toEqual(current());
    expect(statSync(join(sail, 'sail.d.ts')).mtimeMs).toBe(kept);
  });
});

test("a stale declaration never reaches the type-check: with one that names a path that doesn't exist, the check passes and the file is current afterwards", async () => {
  await withTempRepo(async (repo) => {
    const sail = clone(repo);
    writeFileSync(join(sail, 'sail.d.ts'), 'export * from "/no/such/sail/types/index";\n');
    const { code, stdout } = await checked(repo);
    expect(declared(sail)).toEqual(current());
    expect([code, stdout]).toEqual([EXIT_OK, `${WROTE_BOTH}${CHECKED_NONE}`]);
  });
});

test('in a .sail/ with no tsconfig.json it writes nothing, and once the repository has one the same check writes both', async () => {
  await withTempRepo(async (repo) => {
    const sail = clone(repo);
    rmSync(join(sail, 'tsconfig.json'));
    expect(await checked(repo)).toEqual({ code: EXIT_OK, stdout: CHECKED_NONE, stderr: '' });
    expect(declared(sail)).toEqual([null, null]);
    writeFileSync(join(sail, 'tsconfig.json'), '{}\n');
    expect((await checked(repo)).stdout).toBe(`${WROTE_BOTH}${CHECKED_NONE}`);
    expect(declared(sail)).toEqual(current());
  });
});

test('the declarations are written once the config validates, whatever the type-check says after: with type errors it writes them and still exits 3, and with an invalid project.yaml it refuses as before and writes nothing', async () => {
  await withTempRepo(async (repo) => {
    const sail = clone(repo);
    writeFileSync(join(sail, 'broken.ts'), "export const n: number = 'not a number';\n");
    const typed = await checked(repo);
    expect(declared(sail)).toEqual(current());
    expect([typed.code, typed.stdout]).toEqual([EXIT_REFUSED, WROTE_BOTH]);
    expect(typed.stderr).toEndWith('sail check: 1 type error in .sail/\n');

    for (const name of DECLARATIONS) rmSync(join(sail, name));
    writeFileSync(join(sail, 'project.yaml'), CONFIG.replace('name: clone', 'name: Not A Slug'));
    const invalid = await checked(repo);
    expect([invalid.code, invalid.stdout]).toEqual([EXIT_REFUSED, '']);
    expect(invalid.stderr).toStartWith('.sail/project.yaml  ');
    expect(declared(sail)).toEqual([null, null]);
  });
});

test.skipIf(process.getuid?.() === 0)(
  "where the declarations can't be written, it says which on stderr and goes on: its exit code is the check's own",
  async () => {
    await withTempRepo(async (repo) => {
      const sail = clone(repo);
      chmodSync(sail, 0o555);
      try {
        const { code, stdout, stderr } = await checked(repo);
        expect(stderr).toStartWith('sail check: could not write .sail/sail.d.ts: EACCES');
        expect(stderr.split('\n')).toHaveLength(2);
        expect([code, stdout]).toEqual([EXIT_OK, CHECKED_NONE]);
        expect(readdirSync(sail).sort()).toEqual(['project.yaml', 'tsconfig.json']);
      } finally {
        chmodSync(sail, 0o755);
      }
    });
  },
);

test('with --list, the line that says what it wrote comes first, then the checked line, then the listing', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    writeFileSync(join(sail, 'tsconfig.json'), '{}\n');
    const { code, stdout } = await checked(repo, '--list');
    const lines = stdout.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      WROTE_BOTH.trimEnd(),
      '.sail/ checked: 2 workflows, 12 stages',
      '',
      'workflows',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(declared(sail)).toEqual(current());
  });
}, 60_000);

test('only sail check writes them: a run and a resume in a clone that lacks them leave .sail/ without them, and the check that follows writes both', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    writeFileSync(join(sail, 'tsconfig.json'), '{}\n');
    const ran = await runCaptured(['FAKE-1', '--until', 'spec', '-q'], repo.dir, { env: repo.env });
    expect(ran.code).toBe(2);
    expect(declared(sail)).toEqual([null, null]);
    const runId = readdirSync(join(repo.dir, '.sail-runs')).find((name) => name !== 'fake') ?? '';
    await withTempRepo(async (other) => {
      copyRun(repo.dir, other.dir);
      const resumed = await runCaptured(['resume', runId, '-q'], other.dir, { env: other.env });
      expect(resumed.code).toBe(EXIT_OK);
      expect(declared(join(other.dir, '.sail'))).toEqual([null, null]);
      const { stdout } = await runCaptured(['check'], other.dir, { env: other.env });
      expect(stdout).toBe(`${WROTE_BOTH}.sail/ checked: 1 workflow, 5 stages\n`);
      expect(declared(join(other.dir, '.sail'))).toEqual(current());
    });
  });
}, 60_000);

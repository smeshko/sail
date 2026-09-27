// `sail check`, in process through run(): the lookup, project.yaml, the type-check and the definitions, in order.
import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('check --list in the in-repo fixture lists its workflow and stages', async () => {
  const { code, stdout, stderr } = await runCaptured(['check', '--list'], inRepoFixture);
  expect(stderr).toBe('');
  expect(code).toBe(EXIT_OK);
  expect(stdout).toStartWith('.sail/ checked: 1 workflow, 5 stages\n');
  expect(stdout).toMatch(/^ {2}ticket-to-pr {2}intake ticket {2}\.sail\/workflows\/ticket-to-pr\/workflow\.ts$/m);
  for (const [name, kind] of [
    ['implement', 'agent'],
    ['publish', 'stage'],
    ['self-review', 'agent'],
    ['spec', 'agent'],
    ['tests', 'script'],
  ]) {
    expect(stdout).toMatch(
      new RegExp(`^ {2}${name} +${kind} .*\\.sail/(workflows/ticket-to-pr/)?stages/${name}/stage\\.ts$`, 'm'),
    );
  }
  expect(stdout).toMatch(
    /^ {2}publish +stage +describe \(agent\), open \(script\) {2}\.sail\/workflows\/ticket-to-pr\/stages\/publish/m,
  );
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

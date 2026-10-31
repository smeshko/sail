// scripts/workspace-docs.ts: the Markdown under a clone's docs/ lands in a run's workspace, and nothing else does.
import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneOf, copyDocs } from '../../scripts/workspace-docs';
import { createGitWorktreeWorkspace } from '../../src/adapters/workspace/git-worktree';
import { withOrigin } from '../helpers/origin';
import { withTempRepo } from '../helpers/temp-repo';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'workspace-docs.ts');

function put(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'sail-workspace-docs-')));
}

test('copyDocs copies each Markdown file under docs/ byte for byte and leaves non-Markdown files out', () => {
  const clone = tempDir();
  const workspace = tempDir();
  put(clone, 'docs/adr/0001-a.md', '# ADR 1\nDecision: yes.\n');
  put(clone, 'docs/artifacts/plans/archive/p/DECISIONS.md', 'D1\n');
  put(clone, 'docs/artifacts/plans/archive/p/evidence/shot.png', 'png');
  const copied = copyDocs(clone, workspace);
  expect({
    copied,
    adr: readFileSync(join(workspace, 'docs/adr/0001-a.md'), 'utf8'),
    decisions: readFileSync(join(workspace, 'docs/artifacts/plans/archive/p/DECISIONS.md'), 'utf8'),
    png: existsSync(join(workspace, 'docs/artifacts/plans/archive/p/evidence/shot.png')),
  }).toEqual({
    copied: ['adr/0001-a.md', 'artifacts/plans/archive/p/DECISIONS.md'],
    adr: '# ADR 1\nDecision: yes.\n',
    decisions: 'D1\n',
    png: false,
  });
});

test('copyDocs copies nothing and writes nothing when the clone has no docs/', () => {
  const clone = tempDir();
  const workspace = tempDir();
  expect({ copied: copyDocs(clone, workspace), made: existsSync(join(workspace, 'docs')) }).toEqual({
    copied: [],
    made: false,
  });
});

test('copyDocs copies nothing when the clone and the workspace are the same directory', () => {
  const clone = tempDir();
  put(clone, 'docs/adr/0001-a.md', 'x\n');
  expect(copyDocs(clone, clone)).toEqual([]);
});

test('copyDocs leaves a file the workspace already has unchanged', () => {
  const clone = tempDir();
  const workspace = tempDir();
  put(clone, 'docs/adr/0001-a.md', 'clone\n');
  put(clone, 'docs/adr/0002-b.md', 'two\n');
  put(workspace, 'docs/adr/0001-a.md', 'tracked\n');
  const copied = copyDocs(clone, workspace);
  expect({ copied, kept: readFileSync(join(workspace, 'docs/adr/0001-a.md'), 'utf8') }).toEqual({
    copied: ['adr/0002-b.md'],
    kept: 'tracked\n',
  });
});

test('as the git-worktree workspace setup, the script puts the clone docs/ in the workspace as regular files that git status does not show', async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), 'docs/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '--quiet', '-m', 'ignore docs');
    withOrigin(repo);
    put(repo.dir, 'docs/adr/0001-a.md', '# ADR 1\n');
    const runDir = join(tempDir(), 'r1');
    mkdirSync(runDir, { recursive: true });
    const adapter = createGitWorktreeWorkspace({
      repo: repo.dir,
      env: repo.env,
      leasesDir: tempDir(),
      setup: `bun ${SCRIPT}`,
    });
    const created = await adapter.create({ runId: 'r1', runDir }, { branch: 'sail/FAKE-1-docs' });
    const path = 'rejected' in created ? '' : created.path;
    expect({
      isFile: lstatSync(join(path, 'docs/adr/0001-a.md')).isFile(),
      content: readFileSync(join(path, 'docs/adr/0001-a.md'), 'utf8'),
      status: repo.git('-C', path, 'status', '--porcelain'),
    }).toEqual({ isFile: true, content: '# ADR 1\n', status: '' });
  });
});

test('cloneOf run in a worktree returns the clone, and throws outside a git checkout', async () => {
  await withTempRepo(async (repo) => {
    const tree = join(tempDir(), 'tree');
    repo.git('worktree', 'add', '--quiet', '--detach', tree);
    expect(realpathSync(cloneOf(tree, repo.env))).toBe(realpathSync(repo.dir));
    expect(() => cloneOf(tempDir(), { ...repo.env, GIT_CEILING_DIRECTORIES: tmpdir() })).toThrow();
  });
});

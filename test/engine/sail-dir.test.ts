import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findSailDir, projectIssues } from '../../src/engine/sail-dir';
import { withTempRepo } from '../helpers/temp-repo';

const fixtureProject = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail', 'project.yaml');

function sailAt(dir: string): string {
  const sail = join(dir, '.sail');
  mkdirSync(sail, { recursive: true });
  copyFileSync(fixtureProject, join(sail, 'project.yaml'));
  return sail;
}

test('finds .sail/ at the git root from the root, a subdirectory and inside .sail/ itself', async () => {
  await withTempRepo((repo) => {
    const sail = sailAt(repo.dir);
    mkdirSync(join(repo.dir, 'a', 'b'), { recursive: true });
    mkdirSync(join(sail, 'stages', 'x'), { recursive: true });
    for (const cwd of [repo.dir, join(repo.dir, 'a', 'b'), join(sail, 'stages', 'x')]) {
      expect(findSailDir(cwd)).toEqual({ root: repo.dir, dir: sail });
    }
  });
});

test('the nearest .sail/ wins over one nearer the root', async () => {
  await withTempRepo((repo) => {
    sailAt(repo.dir);
    const nested = sailAt(join(repo.dir, 'pkg'));
    mkdirSync(join(repo.dir, 'pkg', 'src'));
    expect(findSailDir(join(repo.dir, 'pkg', 'src'))).toEqual({ root: repo.dir, dir: nested });
  });
});

test('a .sail file is not a .sail/ directory', async () => {
  await withTempRepo((repo) => {
    const sail = sailAt(repo.dir);
    mkdirSync(join(repo.dir, 'a'));
    writeFileSync(join(repo.dir, 'a', '.sail'), '');
    expect(findSailDir(join(repo.dir, 'a'))).toEqual({ root: repo.dir, dir: sail });
  });
});

test('a .sail/ above the git root is never used: the ~/.sail/ guard', async () => {
  await withTempRepo((repo) => {
    sailAt(dirname(repo.dir));
    mkdirSync(join(repo.dir, 'src'));
    const cwd = join(repo.dir, 'src');
    expect(findSailDir(cwd)).toEqual({ refused: `no .sail/ between ${cwd} and the git root ${repo.dir}` });
  });
});

test('a .git file, as in a worktree, marks the git root', async () => {
  await withTempRepo((repo) => {
    sailAt(repo.dir);
    const worktree = join(repo.dir, 'wt');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const cwd = join(worktree, 'src');
    expect(findSailDir(cwd)).toEqual({ refused: `no .sail/ between ${cwd} and the git root ${worktree}` });
  });
});

test('a directory outside any git repository is refused', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sail-no-git-')));
  try {
    sailAt(outside);
    expect(findSailDir(outside)).toEqual({ refused: `not inside a git repository: ${outside}` });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("projectIssues passes the fixture's project.yaml", async () => {
  await withTempRepo((repo) => {
    expect(projectIssues(sailAt(repo.dir))).toEqual([]);
  });
});

test('projectIssues reports a missing project.yaml', async () => {
  await withTempRepo((repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(sail);
    expect(projectIssues(sail)).toEqual([{ schema: 'sail.project.v1', path: '/', message: 'is missing' }]);
  });
});

test.each([
  ['an unknown key', (text: string) => `${text}bogus: 1\n`, { path: '/bogus', message: 'is not allowed' }],
  ['no name', (text: string) => text.replace(/^name: .*\n/m, ''), { path: '/name', message: 'is required' }],
])('projectIssues reports %s', async (_, edit, issue) => {
  await withTempRepo((repo) => {
    const sail = sailAt(repo.dir);
    const path = join(sail, 'project.yaml');
    writeFileSync(path, edit(readFileSync(path, 'utf8')));
    expect(projectIssues(sail)).toEqual([{ schema: 'sail.project.v1', ...issue }]);
  });
});

test('projectIssues reports invalid YAML as one issue at /', async () => {
  await withTempRepo((repo) => {
    const sail = sailAt(repo.dir);
    writeFileSync(join(sail, 'project.yaml'), 'name: [unclosed\n');
    const issues = projectIssues(sail);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ schema: 'sail.project.v1', path: '/' });
  });
});

// The review's gate-files script reports only the head's gate changes against the current base, on fake ports.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVERYTHING } from '../../scripts/affected-tests';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '../..');
const lib = await import(join(ROOT, '.sail/workflows/review/stages/22-gate-files/gate-files.mjs'));

function put(repo: TempRepo, path: string, text = 'changed\n'): void {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), path.endsWith('.json') ? JSON.stringify({ note: text }) : `# ${text}`);
}
function commit(repo: TempRepo, ...paths: string[]): string {
  repo.git('add', ...paths);
  repo.git('commit', '-qm', 'change');
  return repo.git('rev-parse', 'HEAD').trim();
}
function setup(repo: TempRepo): string {
  writeOwnSail(repo);
  for (const path of ['bunfig.toml', 'tsconfig.json']) put(repo, path, 'original\n');
  return commit(repo, 'bunfig.toml', 'tsconfig.json');
}
function stage(repo: TempRepo, base: string, head = repo.git('rev-parse', 'HEAD').trim()) {
  const seed = join(repo.dir, '.sail/fake/prs.json');
  const world = JSON.parse(readFileSync(seed, 'utf8'));
  Object.assign(world.pullRequests[0], { base: 'staging', baseSha: base, headSha: head });
  writeFileSync(seed, JSON.stringify(world));
  const pr = join(repo.home, 'pr');
  const sha = join(repo.home, 'head');
  writeFileSync(pr, JSON.stringify({ number: 7, url: 'fake://codehost/sail/pull/7' }));
  writeFileSync(sha, head);
  const child = Bun.spawnSync([join(repo.dir, '.sail/workflows/review/stages/22-gate-files/run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      PATH: `${join(ROOT, 'bin')}:${repo.env.PATH}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail/project.yaml'),
      INPUT_PR: pr,
      INPUT_HEADSHA: sha,
    },
  });
  if (child.exitCode !== 0) console.error(child.stderr.toString());
  return { code: child.exitCode, output: JSON.parse(child.stdout.toString() || 'null') };
}

test('a head changing only notes reports no gate files', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    put(repo, 'notes.txt');
    commit(repo, 'notes.txt');
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: [] } });
  });
});

test('changed and added gate files are named exactly in git order', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    const paths = [
      '.github/workflows/other.yml',
      '.github/workflows/verify.yml',
      'biome.json',
      'bunfig.toml',
      'package.json',
      'scripts/full-suite.ts',
    ];
    for (const path of paths) put(repo, path);
    commit(repo, ...paths);
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: paths } });
  });
});

test('a deleted tsconfig is named', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    repo.git('rm', 'tsconfig.json');
    repo.git('commit', '-qm', 'delete');
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: ['tsconfig.json'] } });
  });
});

test('renaming a gate file away still names its old path', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    repo.git('mv', 'bunfig.toml', 'old.toml');
    repo.git('commit', '-qm', 'rename');
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: ['bunfig.toml'] } });
  });
});

test('gate changes only on a moved base are excluded before and after merging it into the head', async () => {
  await withTempRepo((repo) => {
    const start = setup(repo);
    put(repo, 'notes.txt');
    const head = commit(repo, 'notes.txt');
    repo.git('checkout', '--detach', start);
    put(repo, 'bunfig.toml');
    const base = commit(repo, 'bunfig.toml');
    expect(stage(repo, base, head)).toEqual({ code: 0, output: { base, touched: [] } });
    repo.git('checkout', '--detach', head);
    repo.git('merge', '--no-edit', base);
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: [] } });
  });
});

test('origin supplies the current base even when the host reports a stale sha', async () => {
  await withTempRepo((repo) => {
    const stale = setup(repo);
    put(repo, 'bunfig.toml');
    const base = commit(repo, 'bunfig.toml');
    repo.git('branch', 'staging', base);
    repo.git('remote', 'add', 'origin', repo.dir);
    put(repo, 'notes.txt');
    commit(repo, 'notes.txt');
    expect(stage(repo, stale)).toEqual({ code: 0, output: { base, touched: [] } });
  });
});

test('a failed base fetch exits without reporting a safe diff', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    repo.git('remote', 'add', 'origin', join(repo.home, 'missing'));
    expect(stage(repo, base)).toEqual({ code: 1, output: null });
  });
});

test('an invalid head exits without reporting a safe diff', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    expect(stage(repo, base, 'missing-head')).toEqual({ code: 1, output: null });
  });
});

test('the literal gate list includes every full-suite selection file', () => {
  expect(EVERYTHING.filter((path) => !lib.GATE_FILES.includes(path))).toEqual([]);
});

// The review's gate-files script reports only the head's gate changes against the current base, on fake ports.
import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { EVERYTHING } from '../../scripts/affected-tests';
import { reachFiles } from '../../src/engine/references';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '../..');
const lib = (await import(join(ROOT, '.sail/lib/gate-files.mjs'))) as {
  GATE_FILES: string[];
  GUARD_FILES: string[];
  GUARD_DIRS: string[];
  GUARD_CODE_DIRS: string[];
  isGateFile(path: string): boolean;
};

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

test('gate paths with non-ASCII and control characters are named verbatim', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    const paths = ['.github/workflows/vérify.yml', '.github/workflows/verify\n.yml\n'];
    for (const path of paths) put(repo, path);
    commit(repo, ...paths);
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: paths.toSorted() } });
  });
});

test('ignore files and nested Biome configs are gate files at any depth', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    const paths = ['.gitignore', 'biome.jsonc', 'src/.gitignore', 'src/biome.json', 'src/deep/biome.jsonc'];
    for (const path of paths) put(repo, path);
    commit(repo, ...paths);
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: paths } });
    expect(lib.isGateFile('src/not-biome.json')).toBe(false);
    expect(lib.isGateFile('src/not.gitignore')).toBe(false);
  });
});

test('the Bun version preflight script is a gate file', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    put(repo, 'scripts/bun-version.ts');
    commit(repo, 'scripts/bun-version.ts');
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: ['scripts/bun-version.ts'] } });
  });
});

test('the config and the workspace setup script are gate files', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    appendFileSync(join(repo.dir, '.sail/project.yaml'), '\n# a harmless change\n');
    put(repo, 'scripts/workspace-docs.ts');
    commit(repo, '.sail/project.yaml', 'scripts/workspace-docs.ts');
    expect(stage(repo, base)).toEqual({
      code: 0,
      output: { base, touched: ['.sail/project.yaml', 'scripts/workspace-docs.ts'] },
    });
  });
});

test('the silence watchdog the test launcher runs is a gate file', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    put(repo, 'scripts/test-watchdog.ts');
    commit(repo, 'scripts/test-watchdog.ts');
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: ['scripts/test-watchdog.ts'] } });
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

const MERGE = '.sail/workflows/review/stages/18-merge';

test('the guard and the merge path are gate files', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    const paths = [
      '.sail/lib/gate-files.mjs',
      `${MERGE}/merge.mjs`,
      '.sail/workflows/review/stages/21-hand-over/hand-over.mjs',
      '.sail/workflows/review/stages/22-gate-files/gate-files.mjs',
      '.sail/workflows/review/workflow.ts',
    ];
    for (const path of paths) appendFileSync(join(repo.dir, path), '\n// a harmless change\n');
    commit(repo, ...paths);
    expect(stage(repo, base)).toEqual({ code: 0, output: { base, touched: paths } });
  });
});

test('a deleted gate-files stage is named', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    repo.git('rm', '-r', '.sail/workflows/review/stages/22-gate-files/stage.ts');
    repo.git('commit', '-qm', 'delete');
    expect(stage(repo, base)).toEqual({
      code: 0,
      output: { base, touched: ['.sail/workflows/review/stages/22-gate-files/stage.ts'] },
    });
  });
});

test('renaming the merge stage away names its old paths and its new ones', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    const moved = '.sail/workflows/review/stages/30-merge';
    repo.git('mv', MERGE, moved);
    repo.git('commit', '-qm', 'rename');
    const files = ['merge.mjs', 'run.sh', 'stage.ts'];
    expect(stage(repo, base)).toEqual({
      code: 0,
      output: { base, touched: [...files.map((f) => `${MERGE}/${f}`), ...files.map((f) => `${moved}/${f}`)] },
    });
  });
});

test("the review's modules, scripts and shared stages are gate files", () => {
  const paths = [
    '.sail/workflows/review/reviewer.ts',
    '.sail/workflows/review/schemas.ts',
    '.sail/workflows/review/stages/19-sync-base/stage.ts',
    '.sail/workflows/review/stages/19-sync-base/sync.mjs',
    '.sail/workflows/review/stages/14-push/run.sh',
    '.sail/stages/validate/stage.ts',
    '.sail/stages/file-follow-ups/file.mjs',
    '.sail/lib/permissions.ts',
    '.sail/lib/jev-check.mjs',
    '.sail/workflows/review/workflow.ts.bak',
    '.sail/workflows/review/stages/23-new/stage.ts',
  ];
  expect(paths.filter((path) => !lib.isGateFile(path))).toEqual([]);
});

test('review prompts and files outside the graph merge on their own', () => {
  const paths = [
    '.sail/workflows/review/stages/06-review-architecture/prompt.md',
    '.sail/workflows/review/stages/18-merge-notes/x.md',
    '.sail/lib/demo.mjs',
    '.sail/lib/demo.sh',
    '.sail/workflows/factory/workflow.ts',
    '.sail/workflows/groom/workflow.ts',
  ];
  expect(paths.filter((path) => lib.isGateFile(path))).toEqual([]);
});

function reach(entries: string[]): string[] {
  const { files, problems } = reachFiles(
    entries.map((entry) => join(ROOT, entry)),
    join(ROOT, '.sail'),
  );
  expect(problems).toEqual([]);
  return files.map((file) => relative(ROOT, file)).sort();
}

function adapterModules(config: unknown): string[] {
  const adapters = (config as { adapters?: Record<string, unknown> }).adapters ?? {};
  const uses: unknown[] = [];
  for (const [name, entry] of Object.entries(adapters)) {
    if (name === 'harnesses') {
      for (const named of Object.values((entry ?? {}) as Record<string, { use?: unknown }>)) uses.push(named?.use);
    } else {
      uses.push((entry as { use?: unknown } | null)?.use);
    }
  }
  return uses
    .filter((use): use is string => typeof use === 'string' && (use.startsWith('./') || use.startsWith('../')))
    .map((use) => relative(ROOT, join(ROOT, '.sail', use)));
}

// The modules the review workflow, the guard and the config's adapters reach that are not gate files.
function ungatedGraph(config: unknown): { reached: string[]; ungated: string[] } {
  const reached = reach(['.sail/workflows/review/workflow.ts', '.sail/lib/gate-files.mjs', ...adapterModules(config)]);
  return { reached, ungated: reached.filter((path) => !lib.isGateFile(path)) };
}

test('an adapter module the config names joins the derived graph', () => {
  const config = {
    adapters: {
      codeHost: { use: './adapters/gh.ts' },
      harness: { use: 'claude-code' },
      harnesses: { pi: { use: '../x.ts' } },
    },
  };
  expect(adapterModules(config)).toEqual(['.sail/adapters/gh.ts', 'x.ts']);
});

test('a config naming an ungated adapter module fails the derived graph', () => {
  const config = { adapters: { codeHost: { use: './lib/demo.mjs' } } };
  expect(ungatedGraph(config).ungated).toEqual(['.sail/lib/demo.mjs']);
});

test('every module the review workflow and the guard reach is a gate file', () => {
  const config = Bun.YAML.parse(readFileSync(join(ROOT, '.sail/project.yaml'), 'utf8'));
  const { reached, ungated } = ungatedGraph(config);
  expect(lib.isGateFile('.sail/project.yaml')).toBe(true);
  expect(reached).toEqual(
    expect.arrayContaining([
      '.sail/workflows/review/schemas.ts',
      '.sail/workflows/review/reviewer.ts',
      '.sail/lib/permissions.ts',
      '.sail/lib/jev-check.mjs',
      '.sail/lib/play.sh',
      '.sail/lib/play.mjs',
      '.sail/stages/file-follow-ups/stage.ts',
      '.sail/stages/validate/validate.mjs',
      '.sail/workflows/review/stages/19-sync-base/sync.mjs',
    ]),
  );
  expect(ungated).toEqual([]);
  const missesSchemas = (path: string) => lib.isGateFile(path) && path !== '.sail/workflows/review/schemas.ts';
  expect(reached.filter((path) => !missesSchemas(path))).toEqual(['.sail/workflows/review/schemas.ts']);
});

test('a schemas edit that empties touched is a gate change', async () => {
  await withTempRepo((repo) => {
    const base = setup(repo);
    appendFileSync(
      join(repo.dir, '.sail/workflows/review/schemas.ts'),
      "\nimport { gateFiles } from './stages/22-gate-files/stage';\ngateFiles.output = GateFiles.transform((g) => ({ ...g, touched: [] }));\n",
    );
    commit(repo, '.sail/workflows/review/schemas.ts');
    expect(stage(repo, base)).toEqual({
      code: 0,
      output: { base, touched: ['.sail/workflows/review/schemas.ts'] },
    });
  });
});

test('the literal gate list includes every full-suite selection file', () => {
  expect(EVERYTHING.filter((path) => !lib.GATE_FILES.includes(path))).toEqual([]);
});

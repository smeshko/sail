// packSail() packs the package from the files git doesn't ignore. The main checkout's README.md is ignored because it
// names internal work, and `bun pm pack` packs a README.md whatever .gitignore and `files` say, so the pack copies git's
// file set to a temp directory first. These tests pack this checkout and a small temp repository.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSail } from '../../scripts/pack';
import { withTempRepo } from '../helpers/temp-repo';

const checkout = join(import.meta.dir, '..', '..');
const DEAD_REGISTRY = 'http://127.0.0.1:9/';
// The pack, git and bun publish run as subprocesses, so each case gets a timeout a loaded machine can meet.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sail-pack-test-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let tarball = '';
let listing: string[] = [];
let verbose: string[] = [];
let extracted = '';

function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const result = Bun.spawnSync(cmd, { cwd, env: env ?? ({ ...process.env } as Record<string, string>) });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const entries = (path: string, flags: string) => run(['tar', flags, path], scratch).stdout.split('\n').filter(Boolean);

function checkoutFiles(): string[] {
  const out = run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], checkout).stdout;
  return out
    .split('\0')
    .filter(Boolean)
    .filter((path) => /^(bin|src|schemas|types)\//.test(path));
}

beforeAll(async () => {
  const outDir = join(scratch, 'out');
  mkdirSync(outDir);
  tarball = await packSail({ outDir });
  listing = entries(tarball, '-tzf').map((path) => path.replace(/^package\//, ''));
  verbose = entries(tarball, '-tvzf');
  extracted = join(scratch, 'extracted');
  mkdirSync(extracted);
  run(['tar', '-xzf', tarball, '-C', extracted], scratch);
}, 30_000);

const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
const packed = () => JSON.parse(readFileSync(join(extracted, 'package', 'package.json'), 'utf8'));

test('packs the package into <outDir>/<scope>-<name>-<version>.tgz', () => {
  expect(tarball).toBe(join(scratch, 'out', `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`));
}, 30_000);

test('holds package.json, LICENSE and every file git lists under bin, src, schemas and types, and nothing else', () => {
  expect([...listing].sort()).toEqual(['LICENSE', 'package.json', ...checkoutFiles()].sort());
  expect(listing.filter((path) => /^(test|scripts|docs)\//.test(path) || /README/i.test(path))).toEqual([]);
}, 30_000);

test('keeps bin/sail and src/cli/main.ts executable', () => {
  for (const path of ['bin/sail', 'src/cli/main.ts']) {
    const line = verbose.find((entry) => entry.endsWith(`package/${path}`));
    expect(line?.startsWith('-rwxr-xr-x')).toBe(true);
  }
}, 30_000);

test('carries the files the installed sail reads at run time', () => {
  for (const path of [
    'types/index.d.ts',
    'types/intakes.d.ts',
    'schemas/sail.project.v1.json',
    'src/builtins/prompts/_shared/finish.md',
  ]) {
    expect(listing).toContain(path);
  }
}, 30_000);

test('the packed package.json keeps name, version, bin, engines and dependencies, and is publishable', () => {
  const manifest = packed();
  for (const key of ['name', 'version', 'bin', 'engines', 'dependencies']) expect(manifest[key]).toEqual(pkg[key]);
  expect(manifest.publishConfig.access).toBe('public');
  expect('private' in manifest).toBe(false);
}, 30_000);

test('exports map . and ./intakes to a .d.ts under types and a .ts that are both in the tarball', () => {
  const exportsMap = packed().exports;
  for (const key of ['.', './intakes']) {
    const { types, default: source } = exportsMap[key];
    expect(types.startsWith('./types/') && types.endsWith('.d.ts')).toBe(true);
    expect(source.endsWith('.ts')).toBe(true);
    expect(listing).toContain(types.slice(2));
    expect(listing).toContain(source.slice(2));
  }
}, 30_000);

test('a directory publish is refused by prepublishOnly before the registry is contacted', () => {
  const env = { ...process.env, NPM_CONFIG_TOKEN: 'dummy', NPM_CONFIG_REGISTRY: DEAD_REGISTRY } as Record<
    string,
    string
  >;
  const result = run(
    [process.execPath, 'publish', '--dry-run', '--registry', DEAD_REGISTRY],
    join(extracted, 'package'),
    env,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('publish the tarball bun run pack makes');
}, 30_000);

test('packs what git does not ignore, skips a deleted file, and leaves out an ignored README.md', async () => {
  await withTempRepo(async (repo) => {
    repo.git('rm', '-q', 'README.md');
    mkdirSync(join(repo.dir, 'a'));
    writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.2.3', files: ['a/'] }));
    writeFileSync(join(repo.dir, '.gitignore'), 'README.md\n');
    writeFileSync(join(repo.dir, 'a', 'kept.ts'), 'export {};\n');
    writeFileSync(join(repo.dir, 'a', 'gone.ts'), 'export {};\n');
    repo.git('add', 'package.json', '.gitignore', 'a/kept.ts', 'a/gone.ts');
    repo.git('commit', '-m', 'tiny');
    rmSync(join(repo.dir, 'a', 'gone.ts'));
    writeFileSync(join(repo.dir, 'a', 'new.ts'), 'export {};\n');
    chmodSync(join(repo.dir, 'a', 'new.ts'), 0o755);
    writeFileSync(join(repo.dir, 'README.md'), 'internal\n');

    const outDir = join(scratch, 'tiny-out');
    mkdirSync(outDir);
    const packedPath = await packSail({ root: repo.dir, outDir });
    expect(packedPath).toBe(join(outDir, 'tiny-1.2.3.tgz'));
    const names = entries(packedPath, '-tzf').map((path) => path.replace(/^package\//, ''));
    expect([...names].sort()).toEqual(['a/kept.ts', 'a/new.ts', 'package.json']);

    // The reason for the copy: a plain pack in the same directory takes the ignored README.md.
    const plain = run(
      [process.execPath, 'pm', 'pack', '--ignore-scripts', '--quiet', '--destination', outDir],
      repo.dir,
      {
        ...repo.env,
      },
    );
    const plainNames = entries(plain.stdout.trim(), '-tzf');
    expect(plainNames).toContain('package/README.md');
  });
}, 30_000);

// A link would copy its target's bytes, so a packed path could carry an ignored file: every link is refused, by path.
for (const [label, make, named] of [
  ['a link to an ignored file', (dir: string) => symlinkSync('../README.md', join(dir, 'a', 'leak.md')), 'a/leak.md'],
  [
    'a tracked path under a directory that became a link',
    (dir: string) => {
      rmSync(join(dir, 'a'), { recursive: true });
      mkdirSync(join(dir, 'private'));
      writeFileSync(join(dir, 'private', 'kept.ts'), 'internal\n');
      symlinkSync('private', join(dir, 'a'));
      // Ignore the link itself, so only the tracked path through it is listed.
      writeFileSync(join(dir, '.gitignore'), 'README.md\nprivate/\n/a\n');
    },
    'a/kept.ts',
  ],
  ['a link to a directory outside the packed folders', (dir: string) => symlinkSync('a', join(dir, 'docs')), 'docs'],
] as const) {
  test(`refuses ${label}, naming it, and writes no tarball`, async () => {
    await withTempRepo(async (repo) => {
      repo.git('rm', '-q', 'README.md');
      mkdirSync(join(repo.dir, 'a'));
      writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.2.3', files: ['a/'] }));
      writeFileSync(join(repo.dir, '.gitignore'), 'README.md\nprivate/\n');
      writeFileSync(join(repo.dir, 'a', 'kept.ts'), 'export {};\n');
      repo.git('add', 'package.json', '.gitignore', 'a/kept.ts');
      repo.git('commit', '-m', 'tiny');
      writeFileSync(join(repo.dir, 'README.md'), 'internal\n');
      make(repo.dir);

      const outDir = join(scratch, `link-out-${named.replace(/\W/g, '-')}`);
      mkdirSync(outDir);
      await expect(packSail({ root: repo.dir, outDir })).rejects.toThrow(`${named} is a symbolic link or under one`);
      expect(existsSync(outDir) && readdirSync(outDir)).toEqual([]);
    });
  }, 30_000);
}

// On a case-insensitive disk (macOS) a rename outside git leaves the index's spelling, which still opens the file; on a
// case-sensitive one (Linux CI) the indexed name is gone and the new one is untracked. Either way the file is packed.
test('packs a file whose spelling on disk differs from the index only in case', async () => {
  await withTempRepo(async (repo) => {
    repo.git('rm', '-q', 'README.md');
    mkdirSync(join(repo.dir, 'a'));
    writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.2.3', files: ['a/'] }));
    writeFileSync(join(repo.dir, 'a', 'Kept.ts'), 'export {};\n');
    repo.git('add', 'package.json', 'a/Kept.ts');
    repo.git('commit', '-m', 'tiny');
    renameSync(join(repo.dir, 'a', 'Kept.ts'), join(repo.dir, 'a', 'kept.ts'));

    const outDir = join(scratch, 'case-out');
    mkdirSync(outDir);
    const names = entries(await packSail({ root: repo.dir, outDir }), '-tzf');
    expect(names.map((path) => path.toLowerCase()).sort()).toEqual(['package/a/kept.ts', 'package/package.json']);
  });
}, 30_000);

test('throws git error text outside a git repository', async () => {
  const bare = join(scratch, 'not-a-repo');
  mkdirSync(bare);
  await expect(packSail({ root: bare, outDir: scratch })).rejects.toThrow(/not a git repository/);
}, 30_000);

test('throws the pack output when package.json is not valid JSON', async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, 'package.json'), '{ not json');
    repo.git('add', 'package.json');
    await expect(packSail({ root: repo.dir, outDir: scratch })).rejects.toThrow(/pack/i);
  });
}, 30_000);

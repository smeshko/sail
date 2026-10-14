// packSail() packs the package from the files git doesn't ignore. The main checkout's README.md is ignored because it
// names internal work, and `bun pm pack` packs a README.md whatever .gitignore and `files` say, so the pack copies git's
// file set to a temp directory first. These tests pack this checkout and a small temp repository.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSail } from '../../scripts/pack';
import { withTempRepo } from '../helpers/temp-repo';

const checkout = join(import.meta.dir, '..', '..');
const DEAD_REGISTRY = 'http://127.0.0.1:9/';
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
});

const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
const packed = () => JSON.parse(readFileSync(join(extracted, 'package', 'package.json'), 'utf8'));

test('packs the package into <outDir>/<scope>-<name>-<version>.tgz', () => {
  expect(tarball).toBe(join(scratch, 'out', `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`));
});

test('holds package.json, LICENSE and every file git lists under bin, src, schemas and types, and nothing else', () => {
  expect([...listing].sort()).toEqual(['LICENSE', 'package.json', ...checkoutFiles()].sort());
  expect(listing.filter((path) => /^(test|scripts|docs)\//.test(path) || /README/i.test(path))).toEqual([]);
});

test('keeps bin/sail and src/cli/main.ts executable', () => {
  for (const path of ['bin/sail', 'src/cli/main.ts']) {
    const line = verbose.find((entry) => entry.endsWith(`package/${path}`));
    expect(line?.startsWith('-rwxr-xr-x')).toBe(true);
  }
});

test('carries the files the installed sail reads at run time', () => {
  for (const path of [
    'types/index.d.ts',
    'types/intakes.d.ts',
    'schemas/sail.project.v1.json',
    'src/builtins/prompts/_shared/finish.md',
  ]) {
    expect(listing).toContain(path);
  }
});

test('the packed package.json keeps name, version, bin, engines and dependencies, and is publishable', () => {
  const manifest = packed();
  for (const key of ['name', 'version', 'bin', 'engines', 'dependencies']) expect(manifest[key]).toEqual(pkg[key]);
  expect(manifest.publishConfig.access).toBe('public');
  expect('private' in manifest).toBe(false);
});

test('exports map . and ./intakes to a .d.ts under types and a .ts that are both in the tarball', () => {
  const exportsMap = packed().exports;
  for (const key of ['.', './intakes']) {
    const { types, default: source } = exportsMap[key];
    expect(types.startsWith('./types/') && types.endsWith('.d.ts')).toBe(true);
    expect(source.endsWith('.ts')).toBe(true);
    expect(listing).toContain(types.slice(2));
    expect(listing).toContain(source.slice(2));
  }
});

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
});

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
});

test('throws git error text outside a git repository', async () => {
  const bare = join(scratch, 'not-a-repo');
  mkdirSync(bare);
  await expect(packSail({ root: bare, outDir: scratch })).rejects.toThrow(/not a git repository/);
});

test('throws the pack output when package.json is not valid JSON', async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, 'package.json'), '{ not json');
    repo.git('add', 'package.json');
    await expect(packSail({ root: repo.dir, outDir: scratch })).rejects.toThrow(/pack/i);
  });
});

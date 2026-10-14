// The packed package, installed into an empty directory without the network, and run: version, bunx, the script-step
// bin, `sail check`, a fixture run, the refusal of a range the installed version misses, and `import 'sail'`
// resolution. Every spawn points the registry at a dead address, so a registry access fails at once.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSail } from '../scripts/pack';
import { FIXTURE_SAIL } from './helpers/fixture';
import { type Installed, installTarball } from './helpers/install-tarball';

const checkout = join(import.meta.dir, '..');
const DEAD_REGISTRY = 'http://127.0.0.1:9/';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'sail-install-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let installed: Installed;
let installDir = '';
let repo = '';
let env: Record<string, string> = {};

async function sh(argv: string[], cwd: string, over: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...env, ...over }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  const outDir = join(base, 'tarball');
  mkdirSync(outDir);
  const tarball = await packSail({ outDir });
  installDir = join(base, 'install');
  mkdirSync(installDir);
  installed = installTarball(tarball, installDir, checkout);

  const tools = join(base, 'tools');
  mkdirSync(tools);
  // Bun 1.3.14 is named `bun` only inside its own package; a script step's `#!/usr/bin/env bun` needs one on the PATH.
  symlinkSync(process.execPath, join(tools, 'bun'));
  const home = join(base, 'home');
  mkdirSync(home);
  env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'sail test',
    GIT_AUTHOR_EMAIL: 'test@sail.invalid',
    GIT_COMMITTER_NAME: 'sail test',
    GIT_COMMITTER_EMAIL: 'test@sail.invalid',
    PATH: `${installed.bin}:${tools}:/usr/bin:/bin`,
    NPM_CONFIG_REGISTRY: DEAD_REGISTRY,
    BUN_CONFIG_REGISTRY: DEAD_REGISTRY,
  };

  repo = join(installDir, 'repo');
  mkdirSync(repo);
  cpSync(FIXTURE_SAIL, join(repo, '.sail'), { recursive: true });
  cpSync(join(installed.root, 'src', 'builtins', 'init', 'tsconfig.json'), join(repo, '.sail', 'tsconfig.json'));
  writeFileSync(join(repo, '.gitignore'), '.sail-runs/\n');
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    ['commit', '-q', '-m', 'initial'],
  ]) {
    const result = await sh(['git', ...args], repo);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
});

const runs = () => {
  try {
    return readdirSync(join(repo, '.sail-runs')).filter((name) => name !== 'fake');
  } catch {
    return [];
  }
};

test('sail --version prints the packed version', async () => {
  expect(await sh(['sail', '--version'], repo)).toEqual({ code: 0, stdout: `${installed.version}\n`, stderr: '' });
});

test('bun x --no-install runs the installed package without a global install', async () => {
  const result = await sh([process.execPath, 'x', '--no-install', installed.name, '--version'], installDir);
  expect(result).toEqual({ code: 0, stdout: `${installed.version}\n`, stderr: '' });
});

test("the package's own bin/sail, the one a script step finds first, prints the version", async () => {
  expect(await sh([join(installed.root, 'bin', 'sail'), '--version'], repo)).toEqual({
    code: 0,
    stdout: `${installed.version}\n`,
    stderr: '',
  });
});

test('sail check passes on the fixture, with sail resolved from the installed package', async () => {
  const result = await sh(['sail', 'check'], repo);
  expect(result.code).toBe(0);
  expect(result.stdout.trimEnd().endsWith('.sail/ checked: 1 workflow, 6 stages')).toBe(true);
  const declarations = readFileSync(join(repo, '.sail', 'sail.d.ts'), 'utf8');
  expect(declarations).toContain(join(installed.root, 'types'));
});

test('sail FAKE-1 completes, and run.json records the packed version', async () => {
  const result = await sh(['sail', 'FAKE-1', '-q'], repo);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const [run] = runs();
  expect(runs()).toHaveLength(1);
  const header = JSON.parse(readFileSync(join(repo, '.sail-runs', run as string, 'run.json'), 'utf8'));
  expect(header.sail.version).toBe(installed.version);
});

test('exports resolve to the SDK entries inside the install', async () => {
  const script = `console.log(Bun.resolveSync(${JSON.stringify(installed.name)}, ${JSON.stringify(repo)}));console.log(Bun.resolveSync(${JSON.stringify(`${installed.name}/intakes`)}, ${JSON.stringify(repo)}))`;
  const result = await sh([process.execPath, '-e', script], base);
  expect(result.stdout.trim().split('\n')).toEqual([
    join(installed.root, 'src', 'sdk', 'index.ts'),
    join(installed.root, 'src', 'sdk', 'intakes.ts'),
  ]);
});

test('a project.yaml range the installed version misses is refused with exit 3, and no run starts', async () => {
  const before = runs();
  const file = join(repo, '.sail', 'project.yaml');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace(/^sail: .*$/m, 'sail: ">=1.0 <2"'));
  try {
    const result = await sh(['sail', 'FAKE-2'], repo);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `.sail/project.yaml  /sail is '>=1.0 <2', which sail ${installed.version} doesn't satisfy\n`,
    );
    expect(runs()).toEqual(before);
  } finally {
    writeFileSync(file, original);
  }
});

test('installTarball throws, naming a dependency the checkout lacks', async () => {
  const src = join(base, 'tiny-src', 'package');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({ name: 'tiny', version: '1.0.0', dependencies: { 'sail-test-no-such-package': '1.0.0' } }),
  );
  const tiny = join(base, 'tiny.tgz');
  expect(Bun.spawnSync(['tar', '-czf', tiny, '-C', join(base, 'tiny-src'), 'package']).exitCode).toBe(0);
  const dir = join(base, 'tiny-install');
  mkdirSync(dir);
  expect(() => installTarball(tiny, dir, checkout)).toThrow('dependency sail-test-no-such-package is not installed in');
});

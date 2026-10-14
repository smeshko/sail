// The watcher registry's repository entries: `<machine dir>/watchers/<name>.json`, one `sail.registry.v1` entry per
// repository name, written atomically and read without ever throwing for a bad file.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDocument } from '../../src/engine/schemas';
import {
  cloneRemote,
  machineDir,
  type RegistryEntry,
  readEntry,
  readRegistry,
  recordEntry,
  withoutUserinfo,
} from '../../src/watch/registry';
import { withTempRepo } from '../helpers/temp-repo';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory for one test's registry: it doesn't exist yet. */
function registry(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-registry-')));
  dirs.push(root);
  return join(root, 'watchers');
}

const entry = (name: string, fields: Partial<RegistryEntry> = {}): RegistryEntry => ({
  schema: 'sail.registry.v1',
  name,
  remote: 'https://example.com/o/r.git',
  clone: `/work/${name}`,
  sailDir: `/work/${name}/.sail`,
  updatedAt: '2026-10-14T09:00:00.000Z',
  ...fields,
});

/** Writes `data` as `file` in `dir`, as JSON unless it is already text. */
function put(dir: string, file: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof data === 'string' ? data : `${JSON.stringify(data)}\n`);
}

test('machineDir is SAIL_HOME when it is set and not empty, and ~/.sail otherwise', () => {
  expect(machineDir({ SAIL_HOME: '/x' })).toBe('/x');
  expect(machineDir({})).toBe(join(homedir(), '.sail'));
  expect(machineDir({ SAIL_HOME: '' })).toBe(join(homedir(), '.sail'));
});

test('a recorded entry reads back, a second record of the name replaces it, and no temp file is left', () => {
  const dir = registry();
  recordEntry(dir, entry('alpha'));
  expect(readRegistry(dir)).toEqual({ entries: [entry('alpha')], problems: [] });
  const moved = entry('alpha', { remote: null, clone: '/elsewhere', sailDir: '/elsewhere/.sail' });
  recordEntry(dir, moved);
  expect(readRegistry(dir)).toEqual({ entries: [moved], problems: [] });
  expect(readdirSync(dir)).toEqual(['alpha.json']);
});

test('readRegistry keeps the valid entries, sorted by name, and names each file that is not one', () => {
  const dir = registry();
  expect(readRegistry(dir)).toEqual({ entries: [], problems: [] });
  put(dir, 'zeta.json', entry('zeta'));
  put(dir, 'alpha.json', entry('alpha', { remote: null }));
  put(dir, 'broken.json', '{"schema": "sail.registry.v1", "name": ');
  put(dir, 'extra.json', { ...entry('extra'), pid: 42 });
  const { remote: _, ...noRemote } = entry('noremote');
  put(dir, 'noremote.json', noRemote);
  put(dir, 'Bad_Name.json', entry('Bad_Name'));
  put(dir, 'wrong.json', entry('right'));
  put(dir, 'alpha.json.4242.tmp', '{"half": ');
  expect(readRegistry(dir)).toEqual({
    entries: [entry('alpha', { remote: null }), entry('zeta')],
    problems: [
      { file: 'Bad_Name.json', message: expect.stringContaining('/name') },
      { file: 'broken.json', message: expect.stringContaining('JSON') },
      { file: 'extra.json', message: expect.stringContaining('/pid is not allowed') },
      { file: 'noremote.json', message: expect.stringContaining('/remote is required') },
      { file: 'wrong.json', message: expect.stringContaining('right.json') },
    ],
  });
  expect(readEntry(dir, 'zeta')).toEqual(entry('zeta'));
  expect(readEntry(dir, 'extra')).toBeUndefined();
  expect(readEntry(dir, 'missing')).toBeUndefined();
});

test('a sail.registry.v1 entry is valid with or without a remote, and an updatedAt that is no timestamp is not', () => {
  expect(validateDocument('sail.registry.v1', entry('alpha'))).toEqual([]);
  expect(validateDocument('sail.registry.v1', entry('alpha', { remote: null }))).toEqual([]);
  expect(validateDocument('sail.registry.v1', entry('alpha', { updatedAt: 'yesterday' }))).toEqual([
    { schema: 'sail.registry.v1', path: '/updatedAt', message: expect.stringContaining('pattern') },
  ]);
});

test('cloneRemote is null for a clone with no remote, and for a directory git cannot run in', async () => {
  await withTempRepo(async (repo) => {
    expect(await cloneRemote(repo.dir, repo.env)).toBeNull();
    expect(await cloneRemote(join(repo.dir, 'no-such-dir'), repo.env)).toBeNull();
  });
});

test('cloneRemote drops the userinfo of a URL remote, and keeps an scp-style remote as it is', async () => {
  await withTempRepo(async (repo) => {
    repo.git('remote', 'add', 'origin', 'https://user:tok@example.com/o/r.git');
    expect(await cloneRemote(repo.dir, repo.env)).toBe('https://example.com/o/r.git');
    repo.git('remote', 'set-url', 'origin', 'git@example.com:o/r.git');
    expect(await cloneRemote(repo.dir, repo.env)).toBe('git@example.com:o/r.git');
  });
});

test.each([
  ['https://alice:secret@part@example.com/org/repo.git', 'https://example.com/org/repo.git'],
  ['https://user:token@example.com', 'https://example.com'],
  ['ssh://git@example.com:22/o/r.git', 'ssh://example.com:22/o/r.git'],
  ['https://example.com/o/r@v2.git', 'https://example.com/o/r@v2.git'],
  ['git@example.com:o/r.git', 'git@example.com:o/r.git'],
])(
  'withoutUserinfo(%s) is %s: the whole userinfo, up to its last @, and nothing past the authority (review #1.3)',
  (url, stripped) => {
    expect(withoutUserinfo(url)).toBe(stripped);
  },
);

test.each([
  ['a relative sailDir', { sailDir: '.sail' }],
  ['a relative clone', { clone: 'work/alpha' }],
])(
  'an entry with %s is a problem, not an entry: the dashboard would read from its own directory (review #1.8)',
  (_, fields) => {
    const dir = registry();
    put(dir, 'alpha.json', entry('alpha', fields));
    put(dir, 'beta.json', entry('beta'));
    const read = readRegistry(dir);
    expect(read.entries).toEqual([entry('beta')]);
    expect(read.problems).toEqual([{ file: 'alpha.json', message: expect.any(String) }]);
  },
);

// The watcher registry's repository entries: `<machine dir>/watchers/<name>.json`, one `sail.registry.v1` entry per
// repository name, written atomically and read without ever throwing for a bad file.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDocument } from '../../src/engine/schemas';
import {
  claimWatcher,
  clearWatcher,
  cloneRemote,
  findHolder,
  keepWatcher,
  machineDir,
  type RegistryEntry,
  readEntry,
  readRegistry,
  recordEntry,
  type WatcherFields,
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

// A live watcher in its repository's entry (DECISIONS D11).

const watcher = (pid: number, sailDir: string, labels: string[], ticketSource = 'fake'): WatcherFields => ({
  pid,
  startedAt: '2026-10-15T08:00:00.000Z',
  sailDir,
  ticketSource,
  labels,
});
/** An isAlive for which exactly `pids` are alive. */
const alive =
  (...pids: number[]) =>
  (pid: number) =>
    pids.includes(pid);
const ME = watcher(222, '/work/fixture/.sail', ['sail-a', 'sail-b']);

test('claimWatcher answers a live watcher of the name in another .sail/ and writes nothing; with that pid dead it claims, and the entry holds its field', () => {
  const dir = registry();
  const other = watcher(111, '/elsewhere/fixture/.sail', ['sail']);
  const theirs = entry('fixture', { clone: '/elsewhere/fixture', sailDir: '/elsewhere/fixture/.sail', watcher: other });
  recordEntry(dir, theirs);
  const before = readFileSync(join(dir, 'fixture.json'), 'utf8');
  expect(claimWatcher(dir, entry('fixture'), ME, alive(111, 222))).toEqual({
    holder: { kind: 'name', entry: theirs, watcher: other },
  });
  expect(readFileSync(join(dir, 'fixture.json'), 'utf8')).toBe(before);
  expect(claimWatcher(dir, entry('fixture'), ME, alive(222))).toEqual({ claimed: true });
  expect(readEntry(dir, 'fixture')).toEqual(entry('fixture', { watcher: ME }));
});

test('findHolder names a live watcher polling one of my labels on my ticket source, not on another, a live one of my name here, and ignores dead pids and my own', () => {
  const claim = { name: 'fixture', ...ME };
  const pollingWatcher = watcher(111, '/work/other/.sail', ['sail-b']);
  const polling = entry('other', { watcher: pollingWatcher });
  const onLinear = entry('linear', { watcher: watcher(333, '/work/linear/.sail', ['sail-a'], 'linear') });
  const dead = entry('dead', { watcher: watcher(444, '/work/dead/.sail', ['sail-a']) });
  const mine = entry('fixture', { watcher: ME });
  const hereWatcher = watcher(555, ME.sailDir, ['sail-c']);
  const here = entry('fixture', { watcher: hereWatcher });
  const everyone = alive(111, 222, 333, 555);
  expect({
    label: findHolder([onLinear, dead, polling, mine], claim, everyone),
    linearOnly: findHolder([onLinear, dead, mine], claim, everyone),
    here: findHolder([polling, here], claim, everyone),
    deadOnly: findHolder([dead, here], claim, alive(222)),
  }).toEqual({
    label: { kind: 'label', label: 'sail-b', entry: polling, watcher: pollingWatcher },
    linearOnly: undefined,
    here: { kind: 'here', entry: here, watcher: hereWatcher },
    deadOnly: undefined,
  });
});

test('a holder that writes between the claim and its read-back makes claimWatcher take its field back and answer it', () => {
  const dir = registry();
  recordEntry(dir, entry('fixture', { watcher: watcher(333, ME.sailDir, ['sail-a']) }));
  const racing = watcher(111, '/work/other/.sail', ['sail-a']);
  const racer = entry('other', { watcher: racing });
  let raced = false;
  // The first liveness check comes after the registry was read, and before the claim is written: the racer writes then.
  const isAlive = (pid: number) => {
    if (!raced) {
      raced = true;
      recordEntry(dir, racer);
    }
    return pid === 111 || pid === 222;
  };
  expect(claimWatcher(dir, entry('fixture'), ME, isAlive)).toEqual({
    holder: { kind: 'label', label: 'sail-a', entry: racer, watcher: racing },
  });
  expect(readEntry(dir, 'fixture')).toEqual(entry('fixture'));
});

test("clearWatcher drops the field only while it is its own pid's", () => {
  const dir = registry();
  recordEntry(dir, entry('fixture', { watcher: ME }));
  clearWatcher(dir, 'fixture', 999);
  expect(readEntry(dir, 'fixture')?.watcher).toEqual(ME);
  clearWatcher(dir, 'fixture', 222);
  expect(readEntry(dir, 'fixture')).toEqual(entry('fixture'));
});

test('an entry with a watcher reads as one, and a watcher with a pid of 0, a relative .sail/ or no labels is a problem', () => {
  const dir = registry();
  put(dir, 'fixture.json', entry('fixture', { watcher: ME }));
  put(dir, 'zero.json', entry('zero', { watcher: { ...ME, pid: 0 } }));
  put(dir, 'relative.json', entry('relative', { watcher: { ...ME, sailDir: '.sail' } }));
  const { labels: _, ...unlabelled } = ME;
  put(dir, 'unlabelled.json', { ...entry('unlabelled'), watcher: unlabelled });
  expect(readRegistry(dir)).toEqual({
    entries: [entry('fixture', { watcher: ME })],
    problems: [
      { file: 'relative.json', message: expect.stringContaining('/watcher/sailDir') },
      { file: 'unlabelled.json', message: expect.stringContaining('/watcher/labels is required') },
      { file: 'zero.json', message: expect.stringContaining('/watcher/pid') },
    ],
  });
});

test('keepWatcher writes its field back when a write dropped it, left it stale or dead, and answers a live watcher of another pid in it, writing nothing (review R1-1)', () => {
  const dir = registry();
  const mine = entry('fixture');
  const kept = (on: RegistryEntry | undefined, isAlive = alive(222)) => {
    if (on === undefined) rmSync(join(dir, 'fixture.json'), { force: true });
    else recordEntry(dir, on);
    return { answer: keepWatcher(dir, mine, ME, isAlive), entry: readEntry(dir, 'fixture') };
  };
  const winner = watcher(111, ME.sailDir, ['sail-a']);
  const registered = entry('fixture', { updatedAt: '2026-10-15T09:30:00.000Z' });
  expect({
    gone: kept(undefined),
    dropped: kept(registered),
    stale: kept(entry('fixture', { watcher: { ...ME, labels: ['sail-a'] } })),
    dead: kept(entry('fixture', { watcher: winner })),
    same: kept(entry('fixture', { watcher: ME })),
    lost: kept(entry('fixture', { watcher: winner }), alive(111, 222)),
  }).toEqual({
    gone: { answer: { kept: true }, entry: entry('fixture', { watcher: ME }) },
    dropped: { answer: { kept: true }, entry: { ...registered, watcher: ME } },
    stale: { answer: { kept: true }, entry: entry('fixture', { watcher: ME }) },
    dead: { answer: { kept: true }, entry: entry('fixture', { watcher: ME }) },
    same: { answer: { kept: true }, entry: entry('fixture', { watcher: ME }) },
    lost: { answer: { lost: winner }, entry: entry('fixture', { watcher: winner }) },
  });
});

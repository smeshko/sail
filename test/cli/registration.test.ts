// Registration, in process through run(): `sail <ticket>` and `sail resume` record their repository in the watcher
// registry under `SAIL_HOME` just before the run opens. Each case runs a copy of the fixture repository in a temp
// repository of its own, because a process opens one run per .sail/.
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { validateDocument } from '../../src/engine/schemas';
import { copyFixture } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { copyRun } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

/** `sail <argv>` in `repo`, with the registry under `sailHome`. */
const sail = (repo: TempRepo, sailHome: string, argv: string[]) =>
  runCaptured(argv, repo.dir, { env: { ...repo.env, SAIL_HOME: sailHome } });

/** The `fixture` entry, parsed, after checking it against `sail.registry.v1`. */
function fixtureEntry(sailHome: string): Record<string, unknown> {
  const file = join(sailHome, 'watchers', 'fixture.json');
  expect(existsSync(file)).toBe(true);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  expect(validateDocument('sail.registry.v1', entry)).toEqual([]);
  return entry;
}

/** Writes an entry for `fixture` from another clone at `clone`, whose `.sail/` exists when `live`. */
function otherClone(sailHome: string, clone: string, remote: string | null, live: boolean): void {
  if (live) mkdirSync(join(clone, '.sail'), { recursive: true });
  mkdirSync(join(sailHome, 'watchers'), { recursive: true });
  const entry = {
    schema: 'sail.registry.v1',
    name: 'fixture',
    remote,
    clone,
    sailDir: join(clone, '.sail'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  writeFileSync(join(sailHome, 'watchers', 'fixture.json'), `${JSON.stringify(entry)}\n`);
}

test('sail FAKE-1 records its repository: the name, no remote, the clone and its .sail/; a start refused first records nothing', async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'sail-home');
    copyFixture(repo.dir);
    const refused = await sail(repo, sailHome, ['FAKE-1', '--workflow', 'no-such-workflow', '-q']);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(readdirSync(repo.home)).toEqual([]);
    const before = new Date().toISOString();
    const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '-q']);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const entry = fixtureEntry(sailHome);
    expect(entry).toEqual({
      schema: 'sail.registry.v1',
      name: 'fixture',
      remote: null,
      clone: realpathSync(repo.dir),
      sailDir: join(realpathSync(repo.dir), '.sail'),
      updatedAt: expect.any(String),
    });
    expect(String(entry.updatedAt) >= before).toBe(true);
    expect(readdirSync(join(sailHome, 'watchers'))).toEqual(['fixture.json']);
  });
}, 60_000);

test('sail resume records its repository again: an entry deleted since the run started is written anew, later', async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'sail-home');
    copyFixture(repo.dir);
    const started = await sail(repo, sailHome, ['FAKE-1', '--until', 'spec', '-q']);
    expect(started.code).toBe(EXIT_SUSPENDED);
    const first = fixtureEntry(sailHome);
    rmSync(join(sailHome, 'watchers', 'fixture.json'));
    const runId = readdirSync(join(repo.dir, '.sail-runs')).find((name) => name !== 'fake') ?? '';
    await withTempRepo(async (other) => {
      copyRun(repo.dir, other.dir);
      const resumed = await sail(other, sailHome, ['resume', runId, '-q']);
      expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
      const entry = fixtureEntry(sailHome);
      expect(entry.clone).toBe(realpathSync(other.dir));
      expect(String(entry.updatedAt) > String(first.updatedAt)).toBe(true);
    });
  });
}, 90_000);

test('another live clone with another remote under the same name: one warning, the run goes on, and this clone takes the entry', async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'sail-home');
    const elsewhere = join(repo.home, 'elsewhere');
    otherClone(sailHome, elsewhere, 'https://example.com/other.git', true);
    copyFixture(repo.dir);
    const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '-q']);
    expect(code).toBe(EXIT_OK);
    const lines = stderr.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`sail FAKE-1: warning: 'fixture' was registered from ${elsewhere}`);
    expect(fixtureEntry(sailHome).clone).toBe(realpathSync(repo.dir));
  });
}, 60_000);

test.each([
  ['a live clone with the same remote', null, true],
  ['a clone whose .sail/ is gone, with another remote', 'https://example.com/other.git', false],
] as const)(
  'the entry of %s moves to this clone without a warning',
  async (_, remote, live) => {
    await withTempRepo(async (repo) => {
      const sailHome = join(repo.home, 'sail-home');
      otherClone(sailHome, join(repo.home, 'elsewhere'), remote, live);
      copyFixture(repo.dir);
      const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '--until', 'spec', '-q']);
      expect({ code, stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
      expect(fixtureEntry(sailHome).clone).toBe(realpathSync(repo.dir));
    });
  },
  60_000,
);

test('a registry that cannot be written is a warning, and the run still completes', async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'not-a-directory');
    writeFileSync(sailHome, 'a file\n');
    copyFixture(repo.dir);
    const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '-q']);
    expect(code).toBe(EXIT_OK);
    expect(stderr).toStartWith(
      `sail FAKE-1: warning: could not record this repository in ${join(sailHome, 'watchers')}: `,
    );
    expect(stderr.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });
}, 60_000);

test('a .sail/ that is a symlink is recorded where the run writes: beside the link, in its own clone (review #3.2)', async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'sail-home');
    copyFixture(repo.dir);
    const shared = join(repo.home, 'shared', 'config');
    mkdirSync(join(repo.home, 'shared'));
    renameSync(join(repo.dir, '.sail'), shared);
    symlinkSync(shared, join(repo.dir, '.sail'));
    const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '-q']);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const clone = realpathSync(repo.dir);
    expect(fixtureEntry(sailHome)).toMatchObject({ clone, sailDir: join(clone, '.sail') });
    expect(readdirSync(join(clone, '.sail-runs')).length).toBeGreaterThan(0);
  });
});

test("sail FAKE-1 keeps the entry's live watcher as it was, and still refreshes updatedAt", async () => {
  await withTempRepo(async (repo) => {
    const sailHome = join(repo.home, 'sail-home');
    copyFixture(repo.dir);
    const clone = realpathSync(repo.dir);
    const watcher = {
      pid: process.pid,
      startedAt: '2026-10-15T08:00:00.000Z',
      sailDir: join(clone, '.sail'),
      ticketSource: 'fake',
      labels: ['sail'],
    };
    const old = { schema: 'sail.registry.v1', name: 'fixture', remote: null, clone, sailDir: join(clone, '.sail') };
    mkdirSync(join(sailHome, 'watchers'), { recursive: true });
    const updatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(sailHome, 'watchers', 'fixture.json'), JSON.stringify({ ...old, updatedAt, watcher }));
    const { code, stderr } = await sail(repo, sailHome, ['FAKE-1', '--until', 'spec', '-q']);
    expect({ code, stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    const entry = fixtureEntry(sailHome);
    expect(entry).toEqual({ ...old, updatedAt: expect.any(String), watcher });
    expect(String(entry.updatedAt) > updatedAt).toBe(true);
  });
}, 60_000);

// sail's code version and the timer that reports its change: a temp git repository for the checkout case, a folder with
// no .git for the packed one, and fake timers for the watch.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sailCodeChanged, sailVersion, watchSailChange } from '../../src/cli/sail-change';
import { fakeTimers } from '../helpers/fake-timers';
import { withTempRepo } from '../helpers/temp-repo';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the code version of a git checkout differs before and after a commit, and is that commit's HEAD", async () => {
  await withTempRepo(async (repo) => {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo.dir, env: repo.env });
    writeFileSync(join(repo.dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-m', 'one');
    const before = await sailVersion(repo.dir, repo.env);
    writeFileSync(join(repo.dir, 'a.txt'), 'two');
    git('commit', '-am', 'two');
    const after = await sailVersion(repo.dir, repo.env);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
    expect(after).toBe(git('rev-parse', 'HEAD').stdout.toString().trim());
  });
});

test("with no .git the code version is a hash that changes with package.json's text and with the SDK's declarations", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-change-')));
  dirs.push(dir);
  mkdirSync(join(dir, 'types'));
  writeFileSync(join(dir, 'types', 'a.d.ts'), 'export {}');
  writeFileSync(join(dir, 'package.json'), '{"version":"0.0.0"}');
  const first = await sailVersion(dir, {});
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(await sailVersion(dir, {})).toBe(first);
  writeFileSync(join(dir, 'package.json'), '{"version":"0.0.1"}');
  const second = await sailVersion(dir, {});
  expect(second).not.toBe(first);
  writeFileSync(join(dir, 'types', 'a.d.ts'), 'export type X = 1');
  expect(await sailVersion(dir, {})).not.toBe(second);
});

test('a code version that cannot be read is undefined', async () => {
  expect(await sailVersion(join(tmpdir(), 'sail-change-no-such-dir'), {})).toBeUndefined();
});

function watched(answers: (string | undefined)[]) {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const changes: [string, string][] = [];
  let index = 0;
  const stop = watchSailChange({
    read: () => answers[Math.min(index++, answers.length - 1)],
    everyMs: 60_000,
    timers,
    onChange: (before, after) => changes.push([before, after]),
  });
  return { timers, changes, stop, reads: () => index };
}

test('the change watch reads at once, again each interval, and calls back once with the old and the new version', async () => {
  const w = watched(['v1', 'v1', 'v2', 'v3']);
  await Bun.sleep(0);
  expect(w.reads()).toBe(1);
  await w.timers.advance(60_000);
  expect(w.changes).toEqual([]);
  await w.timers.advance(60_000);
  expect(w.changes).toEqual([['v1', 'v2']]);
  await w.timers.advance(600_000);
  expect(w.changes).toEqual([['v1', 'v2']]);
});

test('the change watch ignores a failed read: it never calls back and keeps the last version', async () => {
  const w = watched(['v1', undefined, undefined, 'v1']);
  await Bun.sleep(0);
  await w.timers.advance(180_000);
  expect(w.changes).toEqual([]);
  expect(w.reads()).toBe(4);
});

test('a change watch that was cleared reads no more and calls back no more', async () => {
  const w = watched(['v1', 'v2']);
  await Bun.sleep(0);
  w.stop();
  await w.timers.advance(600_000);
  expect(w.changes).toEqual([]);
  expect(w.reads()).toBe(1);
  expect(w.timers.pending()).toEqual([]);
});

function commitIn(repo: { dir: string; env: Record<string, string> }) {
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo.dir, env: repo.env });
  const head = () => git('rev-parse', 'HEAD').stdout.toString().trim();
  return {
    head,
    /** Writes the files, commits them, and returns the new HEAD. */
    commit(files: Record<string, string>): string {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo.dir, path, '..'), { recursive: true });
        writeFileSync(join(repo.dir, path), text);
        git('add', path);
      }
      git('commit', '-m', 'change', '--allow-empty');
      return head();
    },
  };
}

test('sailCodeChanged is true across a commit that adds a file under src/', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const before = g.commit({ 'README.md': 'a' });
    const after = g.commit({ 'src/a.ts': 'export {}' });
    expect(await sailCodeChanged(before, after, repo.dir, repo.env)).toBe(true);
  });
});

test('sailCodeChanged is true across a commit that changes only package.json', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const before = g.commit({ 'package.json': '{"a":1}' });
    const after = g.commit({ 'package.json': '{"a":2}' });
    expect(await sailCodeChanged(before, after, repo.dir, repo.env)).toBe(true);
  });
});

test('sailCodeChanged is true across a commit that changes only bun.lock', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const before = g.commit({ 'bun.lock': '1' });
    const after = g.commit({ 'bun.lock': '2' });
    expect(await sailCodeChanged(before, after, repo.dir, repo.env)).toBe(true);
  });
});

test('sailCodeChanged is false across a commit that changes only other files', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const before = g.commit({ 'src/a.ts': 'export {}' });
    const after = g.commit({ 'docs/a.md': 'x', 'README.md': 'y' });
    expect(await sailCodeChanged(before, after, repo.dir, repo.env)).toBe(false);
  });
});

test('sailCodeChanged is false when the second commit reverts the first change to src/', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const before = g.commit({ 'src/a.ts': 'one' });
    g.commit({ 'src/a.ts': 'two' });
    const after = g.commit({ 'src/a.ts': 'one' });
    expect(await sailCodeChanged(before, after, repo.dir, repo.env)).toBe(false);
  });
});

test('sailCodeChanged is true for versions that are no commit id, an unknown commit and a root with no .git', async () => {
  await withTempRepo(async (repo) => {
    const g = commitIn(repo);
    const head = g.commit({ 'README.md': 'a' });
    expect(await sailCodeChanged('v1', 'v2', repo.dir, repo.env)).toBe(true);
    expect(await sailCodeChanged(head, 'f'.repeat(40), repo.dir, repo.env)).toBe(true);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'sail-change-')));
    dirs.push(bare);
    expect(await sailCodeChanged(head, head, bare, repo.env)).toBe(true);
  });
});

test('the change watch with a changed filter skips a version judged unchanged, asks once about it, and reports a later change against the first', async () => {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const answers = ['v1', 'v2', 'v2', 'v3'];
  let index = 0;
  const asked: string[] = [];
  const changes: [string, string][] = [];
  watchSailChange({
    read: () => answers[Math.min(index++, answers.length - 1)],
    everyMs: 60_000,
    timers,
    changed: (_before, after) => {
      asked.push(after);
      return after === 'v3';
    },
    onChange: (before, after) => changes.push([before, after]),
  });
  await Bun.sleep(0);
  await timers.advance(60_000);
  expect(changes).toEqual([]);
  expect(asked).toEqual(['v2']);
  await timers.advance(60_000);
  expect(changes).toEqual([]);
  expect(asked).toEqual(['v2']);
  await timers.advance(60_000);
  expect(changes).toEqual([['v1', 'v3']]);
  expect(asked).toEqual(['v2', 'v3']);
});

test('the change watch counts a changed filter that throws as a change', async () => {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const answers = ['v1', 'v2'];
  let index = 0;
  const changes: [string, string][] = [];
  watchSailChange({
    read: () => answers[Math.min(index++, answers.length - 1)],
    everyMs: 60_000,
    timers,
    changed: () => {
      throw new Error('no git');
    },
    onChange: (before, after) => changes.push([before, after]),
  });
  await Bun.sleep(0);
  await timers.advance(60_000);
  expect(changes).toEqual([['v1', 'v2']]);
});

// The Workspace port suite: what every Workspace adapter must do (D9, D12, ADR-0018, and D2 and D10 of the git-worktree
// plan). The fake runs it in test/adapters/fake/workspace.test.ts, and git-worktree in
// test/adapters/workspace/git-worktree.test.ts, over a clone of a local bare origin. Each case starts from a fresh
// make(), and every event it captures must validate against sail.event.v1 with no key.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Status } from '../../src/engine/run-dir';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import {
  Diff,
  LeaseResult,
  Released,
  Repository,
  Swept,
  Workspace,
  WorkspaceCapabilities,
  WorkspaceReleased,
} from '../../src/ports/types';
import type { RunRef, WorkspacePort } from '../../src/ports/workspace';
import {
  type Captured,
  captureEvents,
  eventIssues,
  messageOf,
  parseIssues,
  portFailure,
  settle,
  timed,
} from '../helpers/ports';

/** The repository and runs a suite run works in. */
export interface WorkspaceWorld {
  readonly remote: string;
  /** A ref to create workspaces from. */
  readonly base: string;
  /** The branch `repository()` names, whose tip `base` is. */
  readonly defaultBranch: string;
  /** The commit `base` names. */
  readonly baseSha: string;
  /** A file tracked at `base`. */
  readonly tracked: string;
  /** Where run directories are made. */
  readonly runsDir: string;
  /**
   * Makes `<runsDir>/<runId>` with `status` in its STATUS (`running` when left out, none for `'none'`), and returns the
   * run with a pid that is alive, or dead when `alive` is false.
   */
  run(runId: string, status?: Status | 'none', alive?: boolean): Promise<RunRef & { pid: number }>;
  /** Runs git in `cwd`, giving its exit code and trimmed stdout. */
  git(cwd: string, ...args: string[]): { code: number; stdout: string };
}

export type MakeWorkspace = (emit: ProviderEmit) => Promise<{ adapter: WorkspacePort; world: WorkspaceWorld }>;

const BRANCH = 'sail/FAKE-1';

/** A result without its raw. */
function bare(result: { raw: unknown }): Record<string, unknown> {
  const { raw: _raw, ...rest } = result;
  return rest;
}

/** A workspace's path, branch and base, without its raw: what a test compares, or the rejection `settle()` gave. */
function held(workspace: { path: string; branch: string; baseSha: string } | { rejected: unknown }) {
  return 'rejected' in workspace
    ? workspace
    : { path: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha };
}

/** The pid of a process that stays alive until `stop()`. */
function liveProcess(): { pid: number; stop: () => void } {
  const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return { pid: child.pid, stop: () => child.kill('SIGKILL') };
}

/** Every captured event validates against sail.event.v1 with no key. */
function expectValidEvents(capture: Pick<Captured<ProviderEvent>, 'stamped'>): void {
  expect(eventIssues(capture.stamped())).toEqual([]);
}

export function workspaceSuite(label: string, make: MakeWorkspace): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, ...(await make(capture.emit)) };
  };

  test(`${label}: a lease on a free branch is taken, and emits workspace:leased`, async () => {
    const { adapter, world, capture } = await start();
    const result = await adapter.lease(world.remote, BRANCH, await world.run('r1'));
    expect(parseIssues(LeaseResult, result)).toEqual([]);
    expect(result.leased).toBe(true);
    expect(capture.events).toEqual([{ type: 'workspace:leased', remote: world.remote, branch: BRANCH }]);
    expectValidEvents(capture);
  });

  test(`${label}: a second run is refused the leased branch, naming the holder, and the holder renews it`, async () => {
    const { adapter, world, capture } = await start();
    const r1 = await world.run('r1');
    await adapter.lease(world.remote, BRANCH, r1);
    const refused = await adapter.lease(world.remote, BRANCH, await world.run('r2'));
    const renewed = await adapter.lease(world.remote, BRANCH, r1);
    expect([refused.leased ? 'leased' : refused.holder.runId, renewed.leased]).toEqual(['r1', true]);
    const leased = { type: 'workspace:leased', remote: world.remote, branch: BRANCH } as const;
    expect(capture.events).toEqual([leased, leased]);
    expectValidEvents(capture);
  });

  test(`${label}: a stale lease is taken over, and the event names the run it took from`, async () => {
    const { adapter, world, capture } = await start();
    await adapter.lease(world.remote, BRANCH, await world.run('r1', 'running', false));
    const taken = await adapter.lease(world.remote, BRANCH, await world.run('r2'));
    expect(parseIssues(LeaseResult, taken)).toEqual([]);
    expect({ leased: taken.leased, took: taken.leased ? taken.took : undefined }).toEqual({ leased: true, took: 'r1' });
    expect(capture.events.at(-1)).toEqual({
      type: 'workspace:leased',
      remote: world.remote,
      branch: BRANCH,
      took: 'r1',
    });
    expectValidEvents(capture);
  });

  test(`${label}: only the holder releases a lease, which frees the branch, and emits workspace:lease_released`, async () => {
    const { adapter, world, capture } = await start();
    await adapter.lease(world.remote, BRANCH, await world.run('r1'));
    const byOther = await adapter.releaseLease(world.remote, BRANCH, 'r2');
    const byHolder = await adapter.releaseLease(world.remote, BRANCH, 'r1');
    expect([byOther, byHolder].flatMap((result) => parseIssues(Released, result))).toEqual([]);
    expect([byOther.released, byHolder.released]).toEqual([false, true]);
    expect((await adapter.lease(world.remote, BRANCH, await world.run('r2'))).leased).toBe(true);
    expect(capture.events).toEqual([
      { type: 'workspace:leased', remote: world.remote, branch: BRANCH },
      { type: 'workspace:lease_released', remote: world.remote, branch: BRANCH },
      { type: 'workspace:leased', remote: world.remote, branch: BRANCH },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: a workspace is a detached checkout of the base, in the run directory, and emits workspace:created`, async () => {
    const { adapter, world, capture } = await start();
    const r1 = await world.run('r1');
    const workspace = await adapter.create(r1, { base: world.base, branch: BRANCH });
    expect(parseIssues(Workspace, workspace)).toEqual([]);
    const { path, branch, baseSha } = workspace;
    expect({ path, branch, baseSha }).toEqual({
      path: join(r1.runDir, 'workspace'),
      branch: BRANCH,
      baseSha: world.baseSha,
    });
    expect(world.git(path, 'rev-parse', 'HEAD')).toEqual({ code: 0, stdout: world.baseSha });
    expect(world.git(path, 'symbolic-ref', '-q', 'HEAD')).toEqual({ code: 1, stdout: '' });
    expect(timed(capture.events)).toEqual([
      { type: 'workspace:created', path, branch: BRANCH, baseSha: world.baseSha, durationMs: 'ms' },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: two runs hold workspaces for the same branch name, since neither checks it out`, async () => {
    const { adapter, world } = await start();
    const r1 = await world.run('r1');
    const r2 = await world.run('r2');
    const first = await adapter.create(r1, { base: world.base, branch: BRANCH });
    const second = await adapter.create(r2, { base: world.base, branch: BRANCH });
    expect([first.path, second.path].map((path) => [path, existsSync(path)])).toEqual([
      [join(r1.runDir, 'workspace'), true],
      [join(r2.runDir, 'workspace'), true],
    ]);
  });

  test(`${label}: diff gives the working tree's edits against the base`, async () => {
    const { adapter, world } = await start();
    const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
    writeFileSync(join(workspace.path, world.tracked), 'an edit in the workspace\n', { flag: 'a' });
    const diff = await adapter.diff(workspace.path, workspace.baseSha);
    expect(parseIssues(Diff, diff)).toEqual([]);
    expect(diff.patch).toContain(`+++ b/${world.tracked}`);
    expect(diff.patch).toContain('+an edit in the workspace');
  });

  test(`${label}: diff's patch is whole, so it applies to a fresh checkout of the base`, async () => {
    const { adapter, world } = await start();
    const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
    writeFileSync(join(workspace.path, world.tracked), 'an edit, then a blank line\n\n', { flag: 'a' });
    const { patch } = await adapter.diff(workspace.path, workspace.baseSha);
    const fresh = await adapter.create(await world.run('r2'), { base: world.base, branch: BRANCH });
    const file = join(world.runsDir, 'r2', 'edit.patch');
    writeFileSync(file, patch);
    expect(world.git(fresh.path, 'apply', '--check', file)).toEqual({ code: 0, stdout: '' });
  });

  test(`${label}: diff includes the files the run created, so its patch creates them, but not the ignored ones`, async () => {
    const { adapter, world } = await start();
    const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
    mkdirSync(join(workspace.path, 'src', 'new dir'), { recursive: true });
    writeFileSync(join(workspace.path, 'src', 'new dir', 'created.ts'), 'export const created = true;\n');
    writeFileSync(join(workspace.path, '.gitignore'), '\n*.log\n', { flag: 'a' });
    writeFileSync(join(workspace.path, 'run.log'), 'noise\n');
    const { patch } = await adapter.diff(workspace.path, workspace.baseSha);
    expect(patch).toContain('+++ b/src/new dir/created.ts');
    expect(patch).not.toContain('run.log');
    const fresh = await adapter.create(await world.run('r2'), { base: world.base, branch: BRANCH });
    const file = join(world.runsDir, 'r2', 'created.patch');
    writeFileSync(file, patch);
    expect(world.git(fresh.path, 'apply', file)).toEqual({ code: 0, stdout: '' });
    expect(readFileSync(join(fresh.path, 'src', 'new dir', 'created.ts'), 'utf8')).toBe(
      'export const created = true;\n',
    );
  });

  test(`${label}: release removes a workspace unless it is kept, and emits workspace:released either way`, async () => {
    const { adapter, world, capture } = await start();
    const r1 = await world.run('r1');
    const r2 = await world.run('r2');
    const removed = await adapter.create(r1, { base: world.base, branch: BRANCH });
    const kept = await adapter.create(r2, { base: world.base, branch: BRANCH });
    const results = [await adapter.release(r1, false), await adapter.release(r2, true)];
    expect(results.flatMap((result) => parseIssues(WorkspaceReleased, result))).toEqual([]);
    expect(results.map(bare)).toEqual([
      { path: removed.path, kept: false },
      { path: kept.path, kept: true },
    ]);
    expect([existsSync(removed.path), existsSync(kept.path)]).toEqual([false, true]);
    // The removed worktree is gone from the repository's list too, not only from the disk.
    const listed = world.git(kept.path, 'worktree', 'list', '--porcelain').stdout.split('\n');
    expect([listed.includes(`worktree ${removed.path}`), listed.includes(`worktree ${kept.path}`)]).toEqual([
      false,
      true,
    ]);
    expect(capture.events.filter((event) => event.type === 'workspace:released')).toEqual([
      { type: 'workspace:released', path: removed.path, kept: false },
      { type: 'workspace:released', path: kept.path, kept: true },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: sweep removes the workspaces of completed and failed runs, and keeps the rest`, async () => {
    const { adapter, world } = await start();
    const statuses: (Status | 'none')[] = ['completed', 'failed', 'running', 'suspended', 'none'];
    const paths: string[] = [];
    for (const status of statuses) {
      const run = await world.run(`r-${status}`, status);
      paths.push((await adapter.create(run, { base: world.base, branch: BRANCH })).path);
    }
    const swept = await adapter.sweep(world.runsDir);
    expect(parseIssues(Swept, swept)).toEqual([]);
    expect(swept.paths).toEqual(paths.slice(0, 2).sort());
    expect(paths.map((path) => existsSync(path))).toEqual([false, false, true, true, true]);
  });

  test(`${label}: repository() names the remote that keys the leases, and the default branch`, async () => {
    const { adapter, world } = await start();
    const repository = await settle(adapter.repository());
    expect(parseIssues(Repository, repository)).toEqual([]);
    expect('rejected' in repository ? repository : bare(repository)).toEqual({
      url: world.remote,
      defaultBranch: world.defaultBranch,
    });
  });

  test(`${label}: a workspace created with no base starts from the default branch's tip`, async () => {
    const { adapter, world } = await start();
    const r1 = await world.run('r1');
    const workspace = held(await settle(adapter.create(r1, { branch: BRANCH })));
    expect(workspace).toEqual({ path: join(r1.runDir, 'workspace'), branch: BRANCH, baseSha: world.baseSha });
    const path = 'path' in workspace ? workspace.path : r1.runDir;
    expect(world.git(path, 'rev-parse', 'HEAD')).toEqual({ code: 0, stdout: world.baseSha });
  });

  test(`${label}: diff over <rev>...HEAD is taken against the merge-base, and diff over a sha against that sha`, async () => {
    const { adapter, world } = await start();
    const { path } = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
    const commit = (file: string) => {
      writeFileSync(join(path, file), `${file}\n`);
      world.git(path, 'add', file);
      world.git(path, 'commit', '-q', '-m', file);
      return world.git(path, 'rev-parse', 'HEAD').stdout;
    };
    // Two lines of work from the base: `aside` on one, then `ahead` and an uncommitted edit on the other, checked out.
    const aside = commit('aside.txt');
    world.git(path, 'checkout', '-q', '--detach', world.baseSha);
    const ahead = commit('ahead.txt');
    writeFileSync(join(path, world.tracked), 'an uncommitted edit\n', { flag: 'a' });
    const files = (patch: string) => [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).sort();
    const patchOf = async (range: string) => {
      const diff = await settle(adapter.diff(path, range));
      return 'rejected' in diff ? diff : files(diff.patch);
    };
    expect({
      threeDots: await patchOf(`${aside}...HEAD`),
      openEnded: await patchOf(`${aside}...`),
      sha: await patchOf(ahead),
    }).toEqual({
      threeDots: ['ahead.txt', world.tracked].sort(),
      openEnded: ['ahead.txt', world.tracked].sort(),
      sha: [world.tracked],
    });
  });

  test(`${label}: diff refuses as invalid a range outside <rev>, <rev>... and <rev>...HEAD, and a rev that names nothing`, async () => {
    const { adapter, world } = await start();
    const { path } = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
    /** How `diff()` refused `range`, and whether it said the range itself is none: `'diffed'` when it didn't refuse. */
    const refusal = async (range: string) => {
      try {
        await adapter.diff(path, range);
        return 'diffed';
      } catch (error) {
        const said = messageOf(error).includes('is not a range') ? 'not a range' : 'a range';
        return { rejected: portFailure(error), range: said };
      }
    };
    const invalid = { port: 'workspace', op: 'diff', code: 'invalid' };
    expect({
      twoDots: await refusal(`${world.base}..HEAD`),
      otherRight: await refusal(`${world.base}...${world.base}`),
      option: await refusal('--output=/dev/null'),
      optionOnTheLeft: await refusal('-p...HEAD'),
      nothing: await refusal('no-such-rev...HEAD'),
    }).toEqual({
      twoDots: { rejected: invalid, range: 'not a range' },
      otherRight: { rejected: invalid, range: 'not a range' },
      option: { rejected: invalid, range: 'not a range' },
      optionOnTheLeft: { rejected: invalid, range: 'not a range' },
      nothing: { rejected: invalid, range: 'a range' },
    });
  });

  test(`${label}: reopen gives back the run's workspace while its HEAD descends from its base, and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const r1 = await world.run('r1');
    const created = await adapter.create(r1, { base: world.base, branch: BRANCH });
    writeFileSync(join(created.path, 'work.txt'), 'work\n');
    world.git(created.path, 'add', 'work.txt');
    world.git(created.path, 'commit', '-q', '-m', 'work');
    const before = capture.events.length;
    const reopened = await settle(adapter.reopen(r1, { branch: BRANCH, baseSha: world.baseSha }));
    expect(parseIssues(Workspace, reopened)).toEqual([]);
    expect(held(reopened)).toEqual({ path: created.path, branch: BRANCH, baseSha: world.baseSha });
    expect(capture.events.length).toBe(before);
  });

  test(`${label}: reopen refuses as invalid a workspace that is gone, is no worktree, or has lost its base`, async () => {
    const { adapter, world } = await start();
    const reopened = async (spoil: (path: string) => void) => {
      const run = await world.run(`r-${Math.random().toString(36).slice(2, 8)}`);
      const { path } = await adapter.create(run, { base: world.base, branch: BRANCH });
      spoil(path);
      return settle(adapter.reopen(run, { branch: BRANCH, baseSha: world.baseSha }));
    };
    const invalid = { rejected: { port: 'workspace', op: 'reopen', code: 'invalid' } };
    expect({
      gone: await reopened((path) => rmSync(path, { recursive: true, force: true })),
      notAWorktree: await reopened((path) => rmSync(join(path, '.git'), { force: true })),
      baseLost: await reopened((path) => {
        const orphan = world.git(path, 'commit-tree', 'HEAD^{tree}', '-m', 'orphan').stdout;
        world.git(path, 'checkout', '-q', '--detach', orphan);
      }),
    }).toEqual({ gone: invalid, notAWorktree: invalid, baseLost: invalid });
  });

  test(`${label}: a renewal is refused while its run is alive in another process, and taken once that process is gone`, async () => {
    const { adapter, world } = await start();
    const r1 = await world.run('r1');
    const other = liveProcess();
    try {
      await adapter.lease(world.remote, BRANCH, { ...r1, pid: other.pid });
      const whileAlive = await adapter.lease(world.remote, BRANCH, r1);
      other.stop();
      await Bun.sleep(50);
      const once = await adapter.lease(world.remote, BRANCH, r1);
      expect({
        whileAlive: whileAlive.leased ? 'renewed' : { runId: whileAlive.holder.runId, pid: whileAlive.holder.pid },
        once: once.leased ? once.lease.pid : 'refused',
      }).toEqual({ whileAlive: { runId: 'r1', pid: other.pid }, once: r1.pid });
    } finally {
      other.stop();
    }
  });

  test(`${label}: holder names a live or suspended run's lease, nothing for a free branch or an ended run, and takes nothing`, async () => {
    const { adapter, world, capture } = await start();
    const branch = (n: number) => `sail/FAKE-${n}`;
    const live = await world.run('r1');
    const suspended = await world.run('r2', 'suspended', false);
    await adapter.lease(world.remote, branch(1), live);
    await adapter.lease(world.remote, branch(2), suspended);
    await adapter.lease(world.remote, branch(3), await world.run('r3', 'completed'));
    await adapter.lease(world.remote, branch(4), await world.run('r4', 'running', false));
    const leasedEvents = capture.events.length;
    const runIds = [];
    for (const n of [1, 2, 3, 4, 5]) runIds.push((await adapter.holder(world.remote, branch(n)))?.runId);
    expect(runIds).toEqual(['r1', 'r2', undefined, undefined, undefined]);
    expect(await adapter.holder(world.remote, branch(1))).toMatchObject({
      remote: world.remote,
      branch: branch(1),
      pid: live.pid,
    });
    expect(capture.events).toHaveLength(leasedEvents);
    const taken = await adapter.lease(world.remote, branch(4), await world.run('r5'));
    expect(taken.leased ? taken.took : 'refused').toBe('r4');
  });

  test(`${label}: capabilities parse`, async () => {
    const { adapter } = await start();
    expect(parseIssues(WorkspaceCapabilities, adapter.capabilities())).toEqual([]);
  });
}

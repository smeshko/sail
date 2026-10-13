// The Workspace port suite: what every Workspace adapter must do (D9, D12, ADR-0018). The fake runs it in
// test/adapters/fake/workspace.test.ts, and the git-worktree adapter in test/adapters/git-worktree/workspace.test.ts. Each
// case starts from a fresh make(), and every event it captures must validate against sail.event.v1 with no key.
// Events carry paths relative to the clone (D7), so a suite run never writes a machine path into a run.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Status } from '../../src/engine/run-dir';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import {
  Diff,
  LeaseResult,
  Released,
  Swept,
  Workspace,
  WorkspaceCapabilities,
  WorkspaceReleased,
} from '../../src/ports/types';
import type { RunRef, WorkspacePort } from '../../src/ports/workspace';
import { type Captured, captureEvents, eventIssues, parseIssues, timed } from '../helpers/ports';

/** The repository and runs a suite run works in. */
export interface WorkspaceWorld {
  /** The name leases are keyed by, as the adapter's `remoteKey` names it for this repository. */
  readonly remote: string;
  /** The clone the workspaces are made in. Events name paths relative to it. */
  readonly clone: string;
  /** A ref to create workspaces from. */
  readonly base: string;
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

/** Every captured event validates against sail.event.v1 with no key. */
function expectValidEvents(capture: Pick<Captured<ProviderEvent>, 'stamped'>): void {
  expect(eventIssues(capture.stamped())).toEqual([]);
}

/**
 * Commits `text` to the tracked file on top of `from`, in a detached worktree of its own that is removed afterwards, and
 * returns the new commit. The clone's own checkout and its workspaces are left as they were.
 */
function commitOn(world: WorkspaceWorld, from: string, text: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'sail-suite-commit-'));
  const path = join(parent, 'tree');
  try {
    world.git(world.clone, 'worktree', 'add', '--detach', path, from);
    writeFileSync(join(path, world.tracked), text);
    world.git(path, 'commit', '-am', 'a commit made for the suite');
    const sha = world.git(path, 'rev-parse', 'HEAD').stdout;
    world.git(world.clone, 'worktree', 'remove', '--force', path);
    return sha;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export function workspaceSuite(label: string, make: MakeWorkspace): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, ...(await make(capture.emit)) };
  };

  // STICKER: each case below carries the TASK that makes it pass for every adapter it runs for (see its sticker line).
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
    expect({ leased: taken.leased, took: taken.leased ? taken.took : undefined }).toEqual({
      leased: true,
      took: 'r1',
    });
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

  test(`${label}: remoteKey names the remote the same way on every call, and it is no path`, async () => {
    const { adapter, world } = await start();
    const key = await adapter.remoteKey(world.clone);
    expect({
      empty: key === '',
      stable: key === (await adapter.remoteKey(world.clone)),
      absolute: isAbsolute(key),
    }).toEqual({ empty: false, stable: true, absolute: false });
  });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: a workspace is a detached checkout of the base, in the run directory, and emits workspace:created`, async () => {
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
        {
          type: 'workspace:created',
          path: relative(world.clone, path),
          branch: BRANCH,
          baseSha: world.baseSha,
          durationMs: 'ms',
        },
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

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: diff gives the working tree's edits against the base`, async () => {
      const { adapter, world } = await start();
      const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
      writeFileSync(join(workspace.path, world.tracked), 'an edit in the workspace\n', { flag: 'a' });
      const diff = await adapter.diff(workspace.path, workspace.baseSha);
      expect(parseIssues(Diff, diff)).toEqual([]);
      expect(diff.patch).toContain(`+++ b/${world.tracked}`);
      expect(diff.patch).toContain('+an edit in the workspace');
    });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: diff's patch is whole, so it applies to a fresh checkout of the base`, async () => {
      const { adapter, world } = await start();
      const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
      writeFileSync(join(workspace.path, world.tracked), 'an edit, then a blank line\n\n', { flag: 'a' });
      const { patch } = await adapter.diff(workspace.path, workspace.baseSha);
      const fresh = await adapter.create(await world.run('r2'), { base: world.base, branch: BRANCH });
      const file = join(world.runsDir, 'r2', 'edit.patch');
      writeFileSync(file, patch);
      expect(world.git(fresh.path, 'apply', '--check', file)).toEqual({ code: 0, stdout: '' });
    });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: diff includes the files the run created, so its patch creates them, but not the ignored ones`, async () => {
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
    });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: diff is three-dot: from's commits that HEAD lacks are not reverted, only the workspace's own edits show`, async () => {
      const { adapter, world } = await start();
      const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
      const landed = commitOn(world, world.baseSha, 'landed on the base\n');
      writeFileSync(join(workspace.path, 'run.txt'), 'the run\n');
      const { patch } = await adapter.diff(workspace.path, landed);
      expect([patch.includes('+++ b/run.txt'), patch.includes(world.tracked)]).toEqual([true, false]);
    });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: release removes a workspace unless it is kept, and emits workspace:released either way`, async () => {
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
        { type: 'workspace:released', path: relative(world.clone, removed.path), kept: false },
        { type: 'workspace:released', path: relative(world.clone, kept.path), kept: true },
      ]);
      expectValidEvents(capture);
    });

  // biome-ignore format: TDD-PENDING TASK-004
  test
    .skip // TDD-PENDING TASK-004
    (`${label}: sweep removes the workspaces of completed and failed runs, and keeps the rest`, async () => {
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

  // biome-ignore format: TDD-PENDING TASK-009
  test
    .skip // TDD-PENDING TASK-009
    (`${label}: isBasedOn holds for the base a workspace is on, and for a commit above it, and not for a commit above the base it is not on`, async () => {
      const { adapter, world } = await start();
      const workspace = await adapter.create(await world.run('r1'), { base: world.base, branch: BRANCH });
      const above = commitOn(world, world.baseSha, 'landed on the base\n');
      expect([
        await adapter.isBasedOn(workspace.path, world.baseSha),
        await adapter.isBasedOn(workspace.path, above),
      ]).toEqual([true, false]);
      writeFileSync(join(workspace.path, 'run.txt'), 'the run\n');
      world.git(workspace.path, 'add', 'run.txt');
      world.git(workspace.path, 'commit', '-m', 'the run');
      expect(await adapter.isBasedOn(workspace.path, world.baseSha)).toBe(true);
    });

  test(`${label}: capabilities parse`, async () => {
    const { adapter } = await start();
    expect(parseIssues(WorkspaceCapabilities, adapter.capabilities())).toEqual([]);
  });
}

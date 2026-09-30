// The CodeHost port suite: what every CodeHost adapter must do. The fake runs it in test/adapters/fake/code-host.test.ts,
// and a real adapter's test runs it against its provider on demand (SAIL_LIVE_CODE_HOST=1). Each case starts from a
// fresh make(), and every event it captures must validate against sail.event.v1, with a call's key and without one.
import { expect, test } from 'bun:test';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import type { CodeHost } from '../../src/ports/code-host';
import {
  Checks,
  CodeHostCapabilities,
  Labelled,
  MergeResult,
  Posted,
  PullRequest,
  Pushed,
} from '../../src/ports/types';
import { type Captured, captureEvents, eventIssues, parseIssues, portFailure, rejection } from '../helpers/ports';

/** The pull requests a suite run needs, by number, in the host behind the adapter. */
export interface CodeHostWorld {
  /** The designation label. */
  readonly label: string;
  /** The branch a new pull request targets. */
  readonly base: string;
  /** Open, not a draft, and labelled. */
  readonly designated: number;
  /** Labelled, and a draft. */
  readonly draft: number;
  /** No such pull request. */
  readonly missing: number;
  /** One whose first merge the host reports pending, and a later one merged. Left out where that can't be arranged. */
  readonly pendingMerge?: number;
  /** Refs the adapter accepts, each with the number it names. */
  readonly refs: readonly (readonly [string, number])[];
  /** A checkout holding a new commit, a branch no pull request uses, and that commit's sha. */
  pushable(): Promise<{ cwd: string; branch: string; headSha: string }>;
}

export type MakeCodeHost = (emit: ProviderEmit) => Promise<{ adapter: CodeHost; world: CodeHostWorld }>;

const numbers = (pullRequests: readonly PullRequest[]): number[] => pullRequests.map((pr) => pr.number);

/** A merge result without its raw. */
function merge(result: MergeResult): Record<string, unknown> {
  const { raw: _raw, ...rest } = result;
  return rest;
}

/** Every captured event validates against sail.event.v1, stamped with a call's key and without one. */
function expectValidEvents(capture: Pick<Captured<ProviderEvent>, 'stamped'>): void {
  expect(eventIssues(capture.stamped('publish#1/open'))).toEqual([]);
  expect(eventIssues(capture.stamped())).toEqual([]);
}

export function codeHostSuite(label: string, make: MakeCodeHost): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, ...(await make(capture.emit)) };
  };

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: parseRef gives the number each ref names, and nothing for anything else`, async () => {
    const { adapter, world } = await start();
    expect(world.refs.map(([ref]) => adapter.parseRef(ref))).toEqual(world.refs.map(([, number]) => number));
    expect(adapter.parseRef('nope')).toBeUndefined();
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: push records the checkout's HEAD on the branch, and emits codehost:pushed`, async () => {
    const { adapter, world, capture } = await start();
    const { cwd, branch, headSha } = await world.pushable();
    const pushed = await adapter.push(cwd, branch);
    expect(parseIssues(Pushed, pushed)).toEqual([]);
    expect({ branch: pushed.branch, headSha: pushed.headSha }).toEqual({ branch, headSha });
    expect(capture.events).toEqual([{ type: 'codehost:pushed', branch, headSha }]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: a pull request opened from a pushed branch is open, designated, and announced, then labelled`, async () => {
    const { adapter, world, capture } = await start();
    const { cwd, branch, headSha } = await world.pushable();
    await adapter.push(cwd, branch);
    const before = numbers(await adapter.listDesignated(world.label));
    const pr = await adapter.openPullRequest({
      base: world.base,
      head: branch,
      title: 'Add a --shout flag',
      body: 'Prints the whole greeting in upper case.',
      ticketKey: 'FAKE-1',
      labels: [world.label],
    });
    expect(parseIssues(PullRequest, pr)).toEqual([]);
    const { state, draft, base, head, labels, ticketKey } = pr;
    expect({ state, draft, base, head, headSha: pr.headSha, labels, ticketKey }).toEqual({
      state: 'open',
      draft: false,
      base: world.base,
      head: branch,
      headSha,
      labels: [world.label],
      ticketKey: 'FAKE-1',
    });
    expect(before).not.toContain(pr.number);
    expect(numbers(await adapter.listDesignated(world.label))).toContain(pr.number);
    expect(capture.events.slice(1)).toEqual([
      {
        type: 'codehost:pr_opened',
        number: pr.number,
        url: pr.url,
        draft: false,
        base: world.base,
        head: branch,
        ticketKey: 'FAKE-1',
      },
      { type: 'codehost:labelled', number: pr.number, label: world.label, change: 'added' },
    ]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: listDesignated holds the designated pull request, but not the draft`, async () => {
    const { adapter, world } = await start();
    const listed = await adapter.listDesignated(world.label);
    expect(listed.flatMap((pr) => parseIssues(PullRequest, pr))).toEqual([]);
    expect(numbers(listed)).toContain(world.designated);
    expect(numbers(listed)).not.toContain(world.draft);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: every operation on an unknown pull request rejects with not_found, naming the operation`, async () => {
    const { adapter, world, capture } = await start();
    const { missing } = world;
    const failures = [
      portFailure(await rejection(adapter.getPullRequest(missing))),
      portFailure(await rejection(adapter.checks(missing))),
      portFailure(await rejection(adapter.merge(missing, 'squash'))),
      portFailure(await rejection(adapter.addLabel(missing, world.label))),
      portFailure(await rejection(adapter.removeLabel(missing, world.label))),
      portFailure(await rejection(adapter.comment(missing, 'hello'))),
    ];
    expect(failures).toEqual(
      ['getPullRequest', 'checks', 'merge', 'addLabel', 'removeLabel', 'comment'].map((op) => ({
        port: 'codeHost',
        op,
        code: 'not_found',
      })),
    );
    expect(capture.events).toEqual([]);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: checks are read on the pull request's head sha, and emit codehost:checks`, async () => {
    const { adapter, world, capture } = await start();
    const pr = await adapter.getPullRequest(world.designated);
    const checks = await adapter.checks(world.designated);
    expect(parseIssues(Checks, checks)).toEqual([]);
    expect({ number: checks.number, headSha: checks.headSha }).toEqual({ number: world.designated, headSha: pr.headSha });
    expect(capture.events).toEqual([
      {
        type: 'codehost:checks',
        number: world.designated,
        headSha: pr.headSha,
        checks: checks.checks.map(({ name, status }) => ({ name, status })),
      },
    ]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: a merge the host reports reads merged, and merging again gives the same merge with no second event`, async () => {
    const { adapter, world, capture } = await start();
    const result = await adapter.merge(world.designated, 'squash');
    expect(parseIssues(MergeResult, result)).toEqual([]);
    expect(result.state).toBe('merged');
    expect((await adapter.getPullRequest(world.designated)).state).toBe('merged');
    expect(merge(await adapter.merge(world.designated, 'squash'))).toEqual(merge(result));
    expect(capture.events).toEqual([
      { type: 'codehost:merged', number: world.designated, method: 'squash', sha: merge(result).sha as string },
    ]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: a pending merge reads open and emits nothing, until a later merge is reported merged`, async () => {
    const { adapter, world, capture } = await start();
    if (world.pendingMerge === undefined) return;
    const first = await adapter.merge(world.pendingMerge, 'squash');
    expect(parseIssues(MergeResult, first)).toEqual([]);
    expect(first.state).toBe('pending');
    expect((await adapter.getPullRequest(world.pendingMerge)).state).toBe('open');
    expect(capture.events).toEqual([]);

    const later = await adapter.merge(world.pendingMerge, 'squash');
    expect(later.state).toBe('merged');
    expect(capture.events).toEqual([
      { type: 'codehost:merged', number: world.pendingMerge, method: 'squash', sha: merge(later).sha as string },
    ]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: a label added then removed is reflected each time, and only a change emits codehost:labelled`, async () => {
    const { adapter, world, capture } = await start();
    const added = await adapter.addLabel(world.designated, 'needs-review');
    const removed = await adapter.removeLabel(world.designated, 'needs-review');
    await adapter.removeLabel(world.designated, 'needs-review');
    await adapter.addLabel(world.designated, world.label);
    expect([added, removed].flatMap((result) => parseIssues(Labelled, result))).toEqual([]);
    expect([added.labels.includes('needs-review'), removed.labels.includes('needs-review')]).toEqual([true, false]);
    expect(capture.events).toEqual([
      { type: 'codehost:labelled', number: world.designated, label: 'needs-review', change: 'added' },
      { type: 'codehost:labelled', number: world.designated, label: 'needs-review', change: 'removed' },
    ]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: a comment is posted, and emits codehost:commented`, async () => {
    const { adapter, world, capture } = await start();
    const posted = await adapter.comment(world.designated, 'Checks passed.');
    expect(parseIssues(Posted, posted)).toEqual([]);
    expect(capture.events).toEqual([{ type: 'codehost:commented', number: world.designated, body: 'Checks passed.' }]);
    expectValidEvents(capture);
  });

  // biome-ignore format: TDD-PENDING TASK-005
  test
    .skip // TDD-PENDING TASK-005
    (`${label}: capabilities parse, and offer the squash merge the suite uses`, async () => {
    const { adapter } = await start();
    const capabilities = adapter.capabilities();
    expect(parseIssues(CodeHostCapabilities, capabilities)).toEqual([]);
    expect(capabilities.mergeMethods).toContain('squash');
  });
}

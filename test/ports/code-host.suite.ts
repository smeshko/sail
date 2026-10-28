// The CodeHost port suite: what every CodeHost adapter must do. The fake runs it in test/adapters/fake/code-host.test.ts,
// github runs it offline on a scripted GitHub, and against GitHub itself on demand (SAIL_LIVE_CODE_HOST=1). Each case
// starts from a fresh make(), and every event it captures must validate against sail.event.v1, with a call's key and
// without one.
import { expect, test } from 'bun:test';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import type { CodeHost } from '../../src/ports/code-host';
import {
  CheckLog,
  Checks,
  CodeHostCapabilities,
  Labelled,
  type MergeMethod,
  type MergeRequest,
  MergeResult,
  Posted,
  PullRequest,
  PullRequestDetails,
  Pushed,
  Rerun,
} from '../../src/ports/types';
import {
  type Captured,
  captureEvents,
  eventIssues,
  parseIssues,
  portFailure,
  rejection,
  settle,
} from '../helpers/ports';

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
  /** Open, not a draft, and without the label. */
  readonly unlabelled: number;
  /** Labelled, and closed. */
  readonly closed: number;
  /** No such pull request. */
  readonly missing: number;
  /**
   * One whose first merge the host reports pending, and a later one merged. Where that can't be arranged, it is left
   * out and named unarranged.
   */
  readonly pendingMerge?: number;
  /** One whose merge the host rejects. Where that can't be arranged, it is left out and named unarranged. */
  readonly rejectedMerge?: number;
  /**
   * An open pull request with a failed check the host can rerun and read the log of, that check's name and its log
   * (short). Where that can't be arranged, it is left out and named unarranged.
   */
  readonly failedCheck?: { readonly number: number; readonly name: string; readonly log: string };
  /** Refs the adapter accepts, each with the number it names. */
  readonly refs: readonly (readonly [string, number])[];
  /** A checkout holding a new commit, a branch no pull request uses, and that commit's sha. */
  pushable(): Promise<{ cwd: string; branch: string; headSha: string }>;
  /**
   * An open pull request that isn't a draft, which the case may merge: a new one on each call where the host is real,
   * so a case never merges one the world keeps. Its number and its head sha.
   */
  mergeable(): Promise<{ number: number; headSha: string }>;
}

/** The cases a world may be unable to arrange. */
export type Unarranged = 'pendingMerge' | 'rejectedMerge' | 'failedCheck';

export type MakeCodeHost = (emit: ProviderEmit) => Promise<{ adapter: CodeHost; world: CodeHostWorld }>;

const numbers = (pullRequests: readonly PullRequest[]): number[] => pullRequests.map((pr) => pr.number);

/** A sha that is well-formed, and not `headSha`. */
const otherSha = (headSha: string): string => (headSha === '0'.repeat(40) ? '1' : '0').repeat(40);

/** The numbers `listDesignated` lists, or how it rejected: settled, so a rejection fails the case's assertion. */
async function listedNumbers(adapter: CodeHost, label: string): Promise<number[] | { rejected: unknown }> {
  const listed = await settle(adapter.listDesignated(label));
  return 'rejected' in listed ? listed : numbers(listed);
}

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

/**
 * Runs the suite. A case the world can't arrange is named in `unarranged`, and shows as skipped: a world that leaves
 * one out without naming it fails that case.
 */
export function codeHostSuite(label: string, make: MakeCodeHost, unarranged: readonly Unarranged[] = []): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, ...(await make(capture.emit)) };
  };

  test(`${label}: parseRef gives the number each ref names, and nothing for anything else`, async () => {
    const { adapter, world } = await start();
    expect(world.refs.map(([ref]) => adapter.parseRef(ref))).toEqual(world.refs.map(([, number]) => number));
    expect(adapter.parseRef('nope')).toBeUndefined();
  });

  test(`${label}: push records the checkout's HEAD on the branch, and emits codehost:pushed`, async () => {
    const { adapter, world, capture } = await start();
    const { cwd, branch, headSha } = await world.pushable();
    const pushed = await adapter.push(cwd, branch);
    expect(parseIssues(Pushed, pushed)).toEqual([]);
    expect({ branch: pushed.branch, headSha: pushed.headSha }).toEqual({ branch, headSha });
    expect(capture.events).toEqual([{ type: 'codehost:pushed', branch, headSha }]);
    expectValidEvents(capture);
  });

  test(`${label}: a pull request opened from a pushed branch is open and announced, then labelled`, async () => {
    const { adapter, world, capture } = await start();
    const { cwd, branch, headSha } = await world.pushable();
    await adapter.push(cwd, branch);
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

  test(`${label}: a pull request opened from a pushed branch is then listed as designated`, async () => {
    const { adapter, world } = await start();
    const { cwd, branch } = await world.pushable();
    await adapter.push(cwd, branch);
    const before = await listedNumbers(adapter, world.label);
    const request = { base: world.base, head: branch, title: 'Listed', body: '', labels: [world.label] };
    const pr = await adapter.openPullRequest(request);
    const after = await listedNumbers(adapter, world.label);
    expect({
      before: Array.isArray(before) ? before.includes(pr.number) : before,
      after: Array.isArray(after) ? after.includes(pr.number) : after,
    }).toEqual({ before: false, after: true });
  });

  test(`${label}: opening again from an open pull request's head into its base returns it, adds only the labels it lacks, and emits only those`, async () => {
    const { adapter, world, capture } = await start();
    const { cwd, branch } = await world.pushable();
    await adapter.push(cwd, branch);
    const request = { base: world.base, head: branch, title: 'Add a --shout flag', body: 'First.' };
    const first = await adapter.openPullRequest(request);
    const opened = capture.events.length;
    // Settled, so an adapter that refuses the second open fails the assertion below rather than the case.
    const again = await settle(
      adapter.openPullRequest({ ...request, title: 'Again', body: 'Second.', labels: [world.label] }),
    );
    const afterSecond = capture.events.slice(opened);
    const third = await settle(adapter.openPullRequest({ ...request, labels: [world.label] }));
    expect({
      again: 'rejected' in again ? again : [again.number, again.url, again.title, again.labels],
      third: 'rejected' in third ? third : [third.number, third.labels],
      read: (await adapter.getPullRequest(first.number)).title,
      afterSecond,
      afterThird: capture.events.slice(opened + afterSecond.length),
    }).toEqual({
      again: [first.number, first.url, 'Add a --shout flag', [world.label]],
      third: [first.number, [world.label]],
      read: 'Add a --shout flag',
      afterSecond: [{ type: 'codehost:labelled', number: first.number, label: world.label, change: 'added' }],
      afterThird: [],
    });
    expectValidEvents(capture);
  });

  test(`${label}: a push to the default branch rejects as invalid, and records nothing`, async () => {
    const { adapter, world, capture } = await start();
    const before = await adapter.getPullRequest(world.designated);
    const { cwd } = await world.pushable();
    const error = await rejection(adapter.push(cwd, world.base));
    const after = await adapter.getPullRequest(world.designated);
    expect({
      failure: portFailure(error),
      message: error instanceof Error ? error.message : String(error),
      events: capture.events,
      unchanged: [after.headSha, after.labels, after.state],
    }).toEqual({
      failure: { port: 'codeHost', op: 'push', code: 'invalid' },
      message: `codeHost.push: ${world.base} is the default branch`,
      events: [],
      unchanged: [before.headSha, before.labels, before.state],
    });
  });

  test(`${label}: a draft's merge is refused, and it stays open with nothing emitted`, async () => {
    const { adapter, world, capture } = await start();
    const { headSha } = await adapter.getPullRequest(world.draft);
    const result = await adapter.merge(world.draft, { method: 'squash', expectedHeadSha: headSha });
    expect(parseIssues(MergeResult, result)).toEqual([]);
    expect(result.state).toBe('refused');
    expect((await adapter.getPullRequest(world.draft)).state).toBe('open');
    expect(capture.events).toEqual([]);
  });

  test(`${label}: listDesignated lists the designated pull request, and none of the draft, the closed or the unlabelled one`, async () => {
    const { adapter, world } = await start();
    const settled = await settle(adapter.listDesignated(world.label));
    const listed = 'rejected' in settled ? [] : settled;
    expect(['rejected' in settled ? settled : 'listed', listed.flatMap((pr) => parseIssues(PullRequest, pr))]).toEqual([
      'listed',
      [],
    ]);
    const held = numbers(listed);
    expect({
      designated: held.includes(world.designated),
      others: [world.draft, world.closed, world.unlabelled].filter((number) => held.includes(number)),
    }).toEqual({ designated: true, others: [] });
  });

  test(`${label}: listDesignated lists a pull request carrying the label in another case`, async () => {
    const { adapter, world } = await start();
    const { cwd, branch } = await world.pushable();
    await adapter.push(cwd, branch);
    const request = { base: world.base, head: branch, title: 'Cased', body: '', labels: [world.label.toUpperCase()] };
    const pr = await adapter.openPullRequest(request);
    const listed = await listedNumbers(adapter, world.label);
    expect(Array.isArray(listed) ? listed.includes(pr.number) : listed).toBe(true);
  });

  test(`${label}: getPullRequest answers its details, which parse, with the base it targets, not a fork, and a comment posted to it last`, async () => {
    const { adapter, world } = await start();
    await adapter.comment(world.designated, 'Reviewed by the suite.');
    const details = await adapter.getPullRequest(world.designated);
    expect(parseIssues(PullRequestDetails, details)).toEqual([]);
    expect({
      number: details.number,
      base: details.base,
      fork: details.fork,
      last: details.comments.at(-1)?.body,
    }).toEqual({ number: world.designated, base: world.base, fork: false, last: 'Reviewed by the suite.' });
  });

  test(`${label}: every operation on an unknown pull request rejects with not_found, naming the operation`, async () => {
    const { adapter, world, capture } = await start();
    const { missing } = world;
    const calls: [string, () => Promise<unknown>][] = [
      ['getPullRequest', () => adapter.getPullRequest(missing)],
      ['checks', () => adapter.checks(missing)],
      ['rerunChecks', () => adapter.rerunChecks(missing)],
      ['checkLog', () => adapter.checkLog(missing, 'verify')],
      ['merge', () => adapter.merge(missing, { method: 'squash', expectedHeadSha: 'a'.repeat(40) })],
      ['addLabel', () => adapter.addLabel(missing, world.label)],
      ['removeLabel', () => adapter.removeLabel(missing, world.label)],
      ['comment', () => adapter.comment(missing, 'hello')],
    ];
    const failures = [];
    for (const [, call] of calls) failures.push(portFailure(await rejection(call())));
    expect(failures).toEqual(calls.map(([op]) => ({ port: 'codeHost', op, code: 'not_found' })));
    expect(capture.events).toEqual([]);
  });

  test(`${label}: checks are read on the pull request's head sha, and emit codehost:checks`, async () => {
    const { adapter, world, capture } = await start();
    const pr = await adapter.getPullRequest(world.designated);
    const checks = await adapter.checks(world.designated);
    expect(parseIssues(Checks, checks)).toEqual([]);
    expect({ number: checks.number, headSha: checks.headSha }).toEqual({
      number: world.designated,
      headSha: pr.headSha,
    });
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

  test.skipIf(unarranged.includes('failedCheck'))(
    `${label}: rerunChecks runs a failed check again, names it, and emits codehost:checks_rerun`,
    async () => {
      const { adapter, world, capture } = await start();
      const failed = world.failedCheck;
      if (failed === undefined) throw new Error('no failedCheck in the world, and none named unarranged');
      const rerun = await adapter.rerunChecks(failed.number);
      const { headSha } = await adapter.getPullRequest(failed.number);
      expect(parseIssues(Rerun, rerun)).toEqual([]);
      expect({ number: rerun.number, headSha: rerun.headSha, rerun: rerun.rerun }).toEqual({
        number: failed.number,
        headSha,
        rerun: [failed.name],
      });
      expect(capture.events).toEqual([
        { type: 'codehost:checks_rerun', number: failed.number, headSha, checks: [failed.name] },
      ]);
      expectValidEvents(capture);
    },
  );

  test.skipIf(unarranged.includes('failedCheck'))(
    `${label}: checkLog answers the log of a check by its name, and emits nothing`,
    async () => {
      const { adapter, world, capture } = await start();
      const failed = world.failedCheck;
      if (failed === undefined) throw new Error('no failedCheck in the world, and none named unarranged');
      const answer = await adapter.checkLog(failed.number, failed.name);
      expect(parseIssues(CheckLog, answer)).toEqual([]);
      expect({ number: answer.number, name: answer.name, log: answer.log, events: capture.events }).toEqual({
        number: failed.number,
        name: failed.name,
        log: failed.log,
        events: [],
      });
    },
  );

  test.skipIf(unarranged.includes('failedCheck'))(
    `${label}: checkLog of a check the head does not have is not_found, and emits nothing`,
    async () => {
      const { adapter, world, capture } = await start();
      const failed = world.failedCheck;
      if (failed === undefined) throw new Error('no failedCheck in the world, and none named unarranged');
      const error = await rejection(adapter.checkLog(failed.number, 'no-such-check'));
      expect({ failure: portFailure(error), events: capture.events }).toEqual({
        failure: { port: 'codeHost', op: 'checkLog', code: 'not_found' },
        events: [],
      });
    },
  );

  test(`${label}: rerunChecks on a pull request whose checks have not failed reruns nothing and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const rerun = await adapter.rerunChecks(world.designated);
    expect({ rerun: rerun.rerun, events: capture.events }).toEqual({ rerun: [], events: [] });
  });

  test(`${label}: a merge the host reports reads merged, and merging again gives the same merge with no second event`, async () => {
    const { adapter, world, capture } = await start();
    const { number, headSha } = await world.mergeable();
    const request = { method: 'squash', expectedHeadSha: headSha } as const;
    const result = await adapter.merge(number, request);
    expect(parseIssues(MergeResult, result)).toEqual([]);
    expect(result.state).toBe('merged');
    expect((await adapter.getPullRequest(number)).state).toBe('merged');
    expect(merge(await adapter.merge(number, request))).toEqual(merge(result));
    expect(capture.events).toEqual([
      { type: 'codehost:merged', number, method: 'squash', sha: merge(result).sha as string },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: a merge whose expected head isn't the pull request's head is refused, naming both, it stays open, and nothing is emitted`, async () => {
    const { adapter, world, capture } = await start();
    const { number, headSha } = await world.mergeable();
    const stale = otherSha(headSha);
    const result = await adapter.merge(number, { method: 'squash', expectedHeadSha: stale });
    expect(parseIssues(MergeResult, result)).toEqual([]);
    const reason = result.state === 'merged' ? '' : result.reason;
    expect({
      state: result.state,
      names: [reason.includes(stale), reason.includes(headSha)],
      after: (await adapter.getPullRequest(number)).state,
      events: capture.events,
    }).toEqual({ state: 'refused', names: [true, true], after: 'open', events: [] });
  });

  test(`${label}: a merge by a method that isn't one, or with an expected head that is no sha, rejects as invalid, merges nothing, and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const { number, headSha } = await world.mergeable();
    const failures = [
      await rejection(adapter.merge(number, { method: 'fast-forward' as MergeMethod, expectedHeadSha: headSha })),
      await rejection(adapter.merge(number, { method: 'squash', expectedHeadSha: headSha.slice(0, 7) })),
      await rejection(adapter.merge(number, { method: 'squash', expectedHeadSha: headSha.toUpperCase() })),
      await rejection(adapter.merge(number, { method: 'squash' } as MergeRequest)),
    ].map(portFailure);
    const invalid = { port: 'codeHost', op: 'merge', code: 'invalid' };
    expect({ failures, after: (await adapter.getPullRequest(number)).state, events: capture.events }).toEqual({
      failures: [invalid, invalid, invalid, invalid],
      after: 'open',
      events: [],
    });
  });

  test.skipIf(unarranged.includes('rejectedMerge'))(
    `${label}: a merge the host rejects is a PortError of code conflict, it stays open, and nothing is emitted`,
    async () => {
      const { adapter, world, capture } = await start();
      const rejected = world.rejectedMerge;
      if (rejected === undefined) throw new Error('no rejectedMerge in the world, and none named unarranged');
      const { headSha } = await adapter.getPullRequest(rejected);
      const error = await rejection(adapter.merge(rejected, { method: 'squash', expectedHeadSha: headSha }));
      expect({
        failure: portFailure(error),
        after: (await adapter.getPullRequest(rejected)).state,
        events: capture.events,
      }).toEqual({ failure: { port: 'codeHost', op: 'merge', code: 'conflict' }, after: 'open', events: [] });
    },
  );

  test.skipIf(unarranged.includes('pendingMerge'))(
    `${label}: a pending merge reads open and emits nothing, until a later merge is reported merged`,
    async () => {
      const { adapter, world, capture } = await start();
      const pending = world.pendingMerge;
      if (pending === undefined) throw new Error('no pendingMerge in the world, and none named unarranged');
      const request = { method: 'squash', expectedHeadSha: (await adapter.getPullRequest(pending)).headSha } as const;
      const first = await adapter.merge(pending, request);
      expect(parseIssues(MergeResult, first)).toEqual([]);
      expect(first.state).toBe('pending');
      expect((await adapter.getPullRequest(pending)).state).toBe('open');
      expect(capture.events).toEqual([]);

      const later = await adapter.merge(pending, request);
      expect(later.state).toBe('merged');
      expect(capture.events).toEqual([
        { type: 'codehost:merged', number: pending, method: 'squash', sha: merge(later).sha as string },
      ]);
      expectValidEvents(capture);
    },
  );

  test(`${label}: a label added then removed is reflected each time, and only a change emits codehost:labelled`, async () => {
    const { adapter, world, capture } = await start();
    const labelsNow = async () => (await adapter.getPullRequest(world.designated)).labels.includes('needs-review');
    const added = await adapter.addLabel(world.designated, 'needs-review');
    const readAdded = await labelsNow();
    const removed = await adapter.removeLabel(world.designated, 'needs-review');
    const readRemoved = await labelsNow();
    await adapter.removeLabel(world.designated, 'needs-review');
    await adapter.addLabel(world.designated, world.label);
    expect([added, removed].flatMap((result) => parseIssues(Labelled, result))).toEqual([]);
    expect([added.labels.includes('needs-review'), removed.labels.includes('needs-review')]).toEqual([true, false]);
    expect([readAdded, readRemoved]).toEqual([true, false]);
    expect(capture.events).toEqual([
      { type: 'codehost:labelled', number: world.designated, label: 'needs-review', change: 'added' },
      { type: 'codehost:labelled', number: world.designated, label: 'needs-review', change: 'removed' },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: removing a label named . or .. rejects with invalid, sends nothing, and leaves the labels as they were`, async () => {
    const { adapter, world, capture } = await start();
    const before = (await adapter.getPullRequest(world.designated)).labels;
    const failures = [
      portFailure(await rejection(adapter.removeLabel(world.designated, '.'))),
      portFailure(await rejection(adapter.removeLabel(world.designated, '..'))),
    ];
    const after = (await adapter.getPullRequest(world.designated)).labels;
    expect({ failures, after, events: capture.events }).toEqual({
      failures: [
        { port: 'codeHost', op: 'removeLabel', code: 'invalid' },
        { port: 'codeHost', op: 'removeLabel', code: 'invalid' },
      ],
      after: before,
      events: [],
    });
  });

  test(`${label}: a comment is posted, and emits codehost:commented`, async () => {
    const { adapter, world, capture } = await start();
    const posted = await adapter.comment(world.designated, 'Checks passed.');
    expect(parseIssues(Posted, posted)).toEqual([]);
    expect(capture.events).toEqual([{ type: 'codehost:commented', number: world.designated, body: 'Checks passed.' }]);
    expectValidEvents(capture);
  });

  test(`${label}: capabilities parse, and offer the squash merge the suite uses`, async () => {
    const { adapter } = await start();
    const capabilities = adapter.capabilities();
    expect(parseIssues(CodeHostCapabilities, capabilities)).toEqual([]);
    expect(capabilities.mergeMethods.includes('squash')).toBe(true);
  });
}

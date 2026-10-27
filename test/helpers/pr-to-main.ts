// What the pr-to-main cases of the chain fixture read from an observed run, shared by test/cli/chain-pr-to-main*.test.ts.
import { expect } from 'bun:test';
import { EXIT_FAILED } from '../../src/cli/exit-codes';
import type { Observed } from './chain';

export const REVIEWERS = ['style', 'architecture', 'side-effects', 'performance', 'security', 'coverage-check'];

/** The keys the first `all:start` of each pass lists, in order. */
export const groups = (run: Observed): string[][] =>
  run.events
    .filter((event) => event.type === 'all:start')
    .map((event) => (event as unknown as { keys: string[] }).keys);

/** The keys of every call that ended, in the order they ended. */
export const ended = (run: Observed): string[] =>
  run.events.filter((event) => event.type === 'stage:end').map((event) => (event as unknown as { key: string }).key);

/** The output of call `key`, which the run must have made. */
export function outputOf<T>(run: Observed, key: string): T {
  const result = run.results[key];
  if (result === undefined) throw new Error(`the run made no call ${key}`);
  return result.output as T;
}

/** The merge's request bodies, from the world's log. */
export const merges = (run: Observed, number: number) =>
  run.requests
    .filter((request) => request.method === 'PUT' && request.path === `/repos/o/r/pulls/${number}/merge`)
    .map((request) => request.body);

/** The harness answers where `security` finds one `high` thing on every call, not only on the first. */
export const securityAlwaysHigh = (answers: Record<string, Record<string, unknown>[]>) => {
  const high = answers['security#1'];
  delete answers['security#1'];
  answers.security = high ?? [];
};

/** Every `<METHOD> <path under /repos/o/r/issues/<number>>` the world got, as the request log held it, in order. */
export const issueCalls = (run: Observed, number: number): string[] =>
  run.requests
    .filter((request) => request.path.startsWith(`/repos/o/r/issues/${number}/`) && request.method !== 'GET')
    .map((request) => `${request.method} ${request.path.slice(`/repos/o/r/issues/${number}`.length)}`);

/** The bodies of the POSTs that add labels to pull request `number`. */
export const labelBodies = (run: Observed, number: number): unknown[] =>
  run.requests
    .filter((request) => request.method === 'POST' && request.path === `/repos/o/r/issues/${number}/labels`)
    .map((request) => request.body);

/** The comments the world holds on pull request `number`. */
export const commentsOn = (run: Observed, number: number): string[] =>
  (run.pulls.find((each) => each.number === number)?.comments ?? []).map((comment) => comment.body);

/** What every give-up shares: failed, nothing merged, still open, and the lease, worktree and clone as they were. */
export function expectGivenUp(run: Observed, number: number): void {
  expect({
    code: run.code,
    status: run.end.status,
    merges: merges(run, number),
    merged: run.events.filter((event) => event.type === 'codehost:merged'),
    open: run.pulls.find((each) => each.number === number)?.state,
    leases: run.leases,
    worktrees: run.worktrees,
    after: run.after,
    issues: run.issues,
  }).toEqual({
    code: EXIT_FAILED,
    status: 'failed',
    merges: [],
    merged: [],
    open: 'open',
    leases: [],
    worktrees: [run.clone],
    after: run.before,
    issues: [],
  });
}

/** The hand-back's label swap: the removal, then an addition of only `sail-blocked`, and nothing else. */
export const SWAP = ['DELETE /labels/sail', 'POST /labels'];

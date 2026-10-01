// The shapes every port speaks (D7, D8, D13): each schema parses a valid value as itself, every provider result
// requires `raw`, and the few rules beyond shape hold.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  Attachment,
  Check,
  CheckStatus,
  Checks,
  ClaimResult,
  CodeHostCapabilities,
  Comment,
  Diff,
  HarnessCapabilities,
  HarnessResult,
  Labelled,
  Lease,
  LeaseHolder,
  LeaseResult,
  Link,
  MergeMethod,
  MergeResult,
  Moved,
  Posted,
  PullRequest,
  Pushed,
  Raw,
  Released,
  Swept,
  Ticket,
  TicketMove,
  TicketSourceCapabilities,
  TicketState,
  TicketStateType,
  Usage,
  Workspace,
  WorkspaceCapabilities,
  WorkspaceReleased,
} from '../../src/ports/types';
import { parsed, parseIssues } from '../helpers/ports';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
const SHA = 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b';
const RAW = { provider: 'fake' };

const inReview: TicketState = { type: 'started', name: 'In Review' };
const comment: Comment = { author: 'fixture-user', body: 'Upper-case the whole line, the name included.' };
const link: Link = { url: 'https://example.com/greet' };
const attachment: Attachment = { name: 'mock.png', url: 'fake://attachments/mock.png' };
const ticket: Ticket = {
  ticketKey: 'FAKE-1',
  title: 'Add a --shout flag to the greet command',
  url: 'fake://tickets/FAKE-1',
  description: 'Add a `--shout` flag to the `greet` command.',
  state: { type: 'unstarted', name: 'Todo' },
  labels: ['sail'],
  comments: [{ ...comment, createdAt: '2026-09-25T08:00:00.000Z' }],
  links: [{ ...link, title: 'The greet command' }],
  attachments: [{ ...attachment, mimeType: 'image/png' }],
  raw: RAW,
};
const claimed: ClaimResult = { claimed: true, state: { type: 'started', name: 'In Progress' }, raw: RAW };
const moved: Moved = { state: inReview, raw: RAW };
const posted: Posted = { id: 'comment-2', url: 'fake://tickets/FAKE-1#comment-2', raw: RAW };
const pullRequest: PullRequest = {
  number: 1,
  url: 'fake://codehost/fixture/pull/1',
  title: 'FAKE-1: Add a --shout flag to the greet command',
  base: 'main',
  head: 'sail/FAKE-1',
  headSha: SHA,
  draft: false,
  state: 'open',
  labels: ['sail'],
  ticketKey: 'FAKE-1',
  raw: RAW,
};
const pushed: Pushed = { branch: 'sail/FAKE-1', headSha: SHA, raw: RAW };
const labelled: Labelled = { number: 1, labels: ['sail', 'needs-review'], raw: RAW };
const check: Check = { name: 'ci', status: 'passed' };
const checks: Checks = {
  number: 1,
  headSha: SHA,
  checks: [check, { name: 'lint', status: 'skipped', url: 'fake://checks/lint' }],
  raw: RAW,
};
const merged: MergeResult = { state: 'merged', sha: 'f569e7f50659194ebd39f2f141e95091f40791da', raw: RAW };
const holder: LeaseHolder = {
  runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
  runDir: '/r/.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
  pid: 4242,
};
const lease: Lease = {
  ...holder,
  remote: 'fake://codehost/fixture',
  branch: 'sail/FAKE-1',
  takenAt: '2026-09-25T09:00:00.180Z',
};
const leased: LeaseResult = { leased: true, lease, took: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M', raw: RAW };
const released: Released = { released: true, raw: RAW };
const workspace: Workspace = {
  path: '/r/.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N/workspace',
  branch: 'sail/FAKE-1',
  baseSha: 'f569e7f50659194ebd39f2f141e95091f40791da',
  raw: RAW,
};
const diff: Diff = { patch: 'diff --git a/README.md b/README.md\n', raw: RAW };
const workspaceReleased: WorkspaceReleased = { path: workspace.path, kept: false, raw: RAW };
const swept: Swept = { paths: [workspace.path], raw: RAW };
const goldenUsage: Usage = JSON.parse(readFileSync(join(GOLDEN, '01-spec', 'call-1', 'result.json'), 'utf8')).usage;
const done: HarnessResult = {
  outcome: 'done',
  output: { summary: 'Add an optional shout flag.' },
  sessionId: 'fake-session-spec-1',
  usage: goldenUsage,
  transcript: 'assistant: Spec written.',
  raw: RAW,
};

/** One valid value per schema, by name. */
const SAMPLES: [string, z.ZodType, unknown][] = [
  ['Raw', Raw, RAW],
  ['TicketStateType', TicketStateType, 'canceled'],
  ['TicketState', TicketState, inReview],
  ['TicketMove', TicketMove, 'in-review'],
  ['Comment', Comment, comment],
  ['Link', Link, link],
  ['Attachment', Attachment, attachment],
  ['Ticket', Ticket, ticket],
  ['ClaimResult', ClaimResult, claimed],
  ['Moved', Moved, moved],
  ['Posted', Posted, posted],
  ['PullRequest', PullRequest, pullRequest],
  ['Pushed', Pushed, pushed],
  ['Labelled', Labelled, labelled],
  ['CheckStatus', CheckStatus, 'pending'],
  ['Check', Check, check],
  ['Checks', Checks, checks],
  ['MergeMethod', MergeMethod, 'squash'],
  ['MergeResult', MergeResult, merged],
  ['LeaseHolder', LeaseHolder, holder],
  ['Lease', Lease, lease],
  ['LeaseResult', LeaseResult, leased],
  ['Released', Released, released],
  ['Workspace', Workspace, workspace],
  ['Diff', Diff, diff],
  ['WorkspaceReleased', WorkspaceReleased, workspaceReleased],
  ['Swept', Swept, swept],
  ['Usage (the golden spec#1 usage)', Usage, goldenUsage],
  ['HarnessResult', HarnessResult, done],
  [
    'TicketSourceCapabilities',
    TicketSourceCapabilities,
    { comments: true, links: true, attachments: false, moves: ['in-progress', 'done'] },
  ],
  [
    'CodeHostCapabilities',
    CodeHostCapabilities,
    { checks: true, labels: true, drafts: false, mergeMethods: ['squash'] },
  ],
  [
    'HarnessCapabilities',
    HarnessCapabilities,
    { structuredOutput: true, permissions: true, usage: true, abort: true, budgets: ['turns', 'usd', 'minutes'] },
  ],
  ['WorkspaceCapabilities', WorkspaceCapabilities, { keep: true, sweep: false }],
];

/** Every provider result, whose `raw` is required. */
const RESULTS: [string, z.ZodType, { raw: unknown }][] = [
  ['Ticket', Ticket, ticket],
  ['ClaimResult', ClaimResult, claimed],
  ['Moved', Moved, moved],
  ['Posted', Posted, posted],
  ['PullRequest', PullRequest, pullRequest],
  ['Pushed', Pushed, pushed],
  ['Labelled', Labelled, labelled],
  ['Checks', Checks, checks],
  ['MergeResult', MergeResult, merged],
  ['LeaseResult', LeaseResult, leased],
  ['Released', Released, released],
  ['Workspace', Workspace, workspace],
  ['Diff', Diff, diff],
  ['WorkspaceReleased', WorkspaceReleased, workspaceReleased],
  ['Swept', Swept, swept],
  ['HarnessResult', HarnessResult, done],
];

const paths = (schema: z.ZodType, value: unknown): string[] => parseIssues(schema, value).map((issue) => issue.path);

test.each(SAMPLES)('a valid %s parses as itself', (_, schema, sample) => {
  expect(parsed(schema, sample)).toEqual(sample);
});

test.each(RESULTS)('a %s without raw fails, naming raw', (_, schema, result) => {
  const { raw: _raw, ...rest } = result;
  expect(parseIssues(schema, rest)).toEqual([{ path: 'raw', message: 'raw is required' }]);
});

test('a blocked result needs a reason and an error a message, and neither may be empty', () => {
  const session = { sessionId: 'fake-session-spec-1', usage: { costUsd: 0 }, transcript: '', raw: null };
  const results = [
    { ...session, outcome: 'blocked' },
    { ...session, outcome: 'blocked', reason: '' },
    { ...session, outcome: 'error', message: '' },
  ];
  expect(results.map((result) => paths(HarnessResult, result))).toEqual([['reason'], ['reason'], ['message']]);
});

test("TicketMove is ADR-0015's four moves, never a provider's state name", () => {
  const moves = ['unstarted', 'in-progress', 'in-review', 'done', 'In Review', 'started'];
  expect(moves.map((move) => TicketMove.safeParse(move).success)).toEqual([true, true, true, true, false, false]);
});

test('a merged result needs its sha, and a pending one its reason', () => {
  expect(paths(MergeResult, { state: 'merged', raw: null })).toEqual(['sha']);
  expect(paths(MergeResult, { state: 'pending', raw: null })).toEqual(['reason']);
});

test('Usage counts tokens in whole, non-negative numbers', () => {
  expect(paths(Usage, { costUsd: 0, inputTokens: -1 })).toEqual(['inputTokens']);
  expect(paths(Usage, { costUsd: 0, outputTokens: 1.5 })).toEqual(['outputTokens']);
  expect(paths(Usage, { costUsd: 0.01, cacheReadTokens: 0 })).toEqual([]);
});

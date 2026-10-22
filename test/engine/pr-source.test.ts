// resolveRef() and resolvePullRequest(): what a ref names, read by both adapters, and a pull request fetched and
// checked as a run's source (DECISIONS D2, D3, D5, D6), on the fake CodeHost over a seed with one pull request per check.
// The ticket marker is the security boundary: its key is kept only when the head branch is that ticket's branch, so the
// table holds the prefix confusions (FAKE-1 against FAKE-12) on purpose. Nothing either fake is asked writes its state.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeCodeHost } from '../../src/adapters/fake/code-host';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import { type ResolvePullRequestOptions, resolvePullRequest, resolveRef } from '../../src/engine/pr-source';
import type { CodeHost } from '../../src/ports/code-host';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REMOTE = 'fake://codehost/stub';
const sha = (number: number) => `${number}`.padStart(40, 'e');

/** A pull request of the seed: open, ready, labelled `sail`, from `sail/FAKE-<n>-x` with no marker, unless `fields` say. */
const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  body: '',
  base: 'main',
  head: `sail/FAKE-${number}-x`,
  headSha: sha(number),
  draft: false,
  state: 'open',
  labels: ['sail'],
  ...fields,
});

/** One pull request per check, by number. */
const SEED = [
  pull(1, { head: 'sail/FAKE-1-add-x', ticketKey: 'FAKE-1' }),
  pull(2, { head: 'sail/FAKE-1', ticketKey: 'FAKE-1' }),
  pull(3, { head: 'feature/no-marker' }),
  pull(4, { state: 'closed' }),
  pull(5, { state: 'merged' }),
  pull(6, { draft: true }),
  pull(7, { labels: [] }),
  pull(8, { head: 'patch-1', fork: true }),
  pull(9, { head: 'main' }),
  pull(10, { head: 'sail/FAKE-7-x', ticketKey: 'FAKE-5' }),
  pull(11, { head: 'sail/FAKE-12-x', ticketKey: 'FAKE-1' }),
  pull(12, { state: 'closed', labels: [] }),
  pull(13, { head: 'patch-2', fork: true, state: 'closed' }),
  pull(14, { head: 'sail/FAKE-12-x', ticketKey: 'FAKE-1', draft: true }),
  pull(15, { head: 'sail/FAKE-1-x', ticketKey: 'FAKE-1' }),
];

/** The fake CodeHost and the fake TicketSource on seeds of their own, and the state files each writes only on a change. */
function world(): { codeHost: CodeHost; ticketSource: ReturnType<typeof createFakeTicketSource>; states: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sail-pr-source-'));
  dirs.push(dir);
  const prs = join(dir, 'prs.json');
  const world = { remote: REMOTE, defaultBranch: 'main', branches: { main: 'a'.repeat(40) }, pullRequests: SEED };
  writeFileSync(prs, JSON.stringify(world));
  const tickets = join(dir, 'tickets.json');
  writeFileSync(tickets, JSON.stringify({ tickets: [] }));
  const states = [join(dir, 'state', 'prs.json'), join(dir, 'state', 'tickets.json')];
  return {
    codeHost: createFakeCodeHost({ seed: prs, state: states[0] as string }),
    ticketSource: createFakeTicketSource({ seed: tickets, state: states[1] as string }),
    states,
  };
}

const FORCE = '--force runs it anyway';
const NO_FORCE = "--force doesn't change that";
const mismatch = (number: number, key: string, head: string) =>
  `pull request #${number}'s ticket marker names ${key}, but its head branch ${head} is not ${key}'s: fix or remove the marker. ${NO_FORCE}`;

type Expected = { refused: string } | { number: number; ticketKey: string | null; forced: string[] };

test.each<[string, number, Partial<ResolvePullRequestOptions>, Expected]>([
  ['a marker on its ticket branch with a slug', 1, {}, { number: 1, ticketKey: 'FAKE-1', forced: [] }],
  ['a marker on its ticket branch alone', 2, {}, { number: 2, ticketKey: 'FAKE-1', forced: [] }],
  ['no marker', 3, {}, { number: 3, ticketKey: null, forced: [] }],
  ['a closed one', 4, {}, { refused: `pull request #4 is closed. ${FORCE}` }],
  ['a merged one', 5, {}, { refused: `pull request #5 is merged. ${FORCE}` }],
  ['a draft', 6, {}, { refused: `pull request #6 is a draft. ${FORCE}` }],
  ['an unlabelled one', 7, {}, { refused: `pull request #7 is not designated: it carries no 'sail' label. ${FORCE}` }],
  [
    'a fork',
    8,
    {},
    { refused: `pull request #8 comes from a fork: its head patch-1 is not a branch of this repository. ${NO_FORCE}` },
  ],
  [
    'a head on the default branch',
    9,
    {},
    { refused: `pull request #9's head is main, the default branch, which no run may lease. ${NO_FORCE}` },
  ],
  ['a marker naming another ticket', 10, {}, { refused: mismatch(10, 'FAKE-5', 'sail/FAKE-7-x') }],
  ["a marker whose key is a prefix of the branch's", 11, {}, { refused: mismatch(11, 'FAKE-1', 'sail/FAKE-12-x') }],
  [
    'a marker on a branch of another prefix',
    15,
    { branchPrefix: 'bot/' },
    { refused: mismatch(15, 'FAKE-1', 'sail/FAKE-1-x') },
  ],
  [
    'a head that moved since it was queued',
    1,
    { headSha: sha(99) },
    { refused: `pull request #1's head is now ${sha(1).slice(0, 7)}, not ${sha(99).slice(0, 7)}` },
  ],
  [
    'a pull request that does not exist',
    99,
    {},
    { refused: 'codeHost.getPullRequest: no pull request #99 (not_found)' },
  ],
  ['a closed one, forced', 4, { force: true }, { number: 4, ticketKey: null, forced: ['state'] }],
  ['a draft, forced', 6, { force: true }, { number: 6, ticketKey: null, forced: ['state'] }],
  ['an unlabelled one, forced', 7, { force: true }, { number: 7, ticketKey: null, forced: ['designation'] }],
  [
    'a closed, unlabelled one, forced',
    12,
    { force: true },
    { number: 12, ticketKey: null, forced: ['designation', 'state'] },
  ],
  [
    'a closed fork, forced',
    13,
    { force: true },
    { refused: `pull request #13 comes from a fork: its head patch-2 is not a branch of this repository. ${NO_FORCE}` },
  ],
  [
    'a head on the default branch, forced',
    9,
    { force: true },
    { refused: `pull request #9's head is main, the default branch, which no run may lease. ${NO_FORCE}` },
  ],
  [
    'a draft whose marker does not match, forced',
    14,
    { force: true },
    { refused: mismatch(14, 'FAKE-1', 'sail/FAKE-12-x') },
  ],
])('resolvePullRequest on %s', async (_, number, options, expected) => {
  const { codeHost, states } = world();
  const resolved = await resolvePullRequest({
    number,
    codeHost,
    label: 'sail',
    branchPrefix: 'sail/',
    defaultBranch: 'main',
    ...options,
  });
  const got: Expected =
    'refused' in resolved
      ? resolved
      : { number: resolved.pr.number, ticketKey: resolved.ticketKey ?? null, forced: resolved.forced };
  expect({ got, written: states.filter((state) => existsSync(state)) }).toEqual({ got: expected, written: [] });
});

test('resolveRef asks both adapters: one reading is the source, a ref both read is refused naming both readings, and one neither reads names both adapters', () => {
  const { codeHost, ticketSource, states } = world();
  /** A CodeHost of the repository's own that reads any ref as pull request 12. */
  const greedy: CodeHost = { ...codeHost, name: 'greedy', parseRef: () => 12 };
  expect({
    ticket: resolveRef('FAKE-1', ticketSource, codeHost),
    url: resolveRef('fake://tickets/FAKE-2', ticketSource, codeHost),
    hash: resolveRef('#3', ticketSource, codeHost),
    bare: resolveRef('3', ticketSource, codeHost),
    pull: resolveRef(`${REMOTE}/pull/3`, ticketSource, codeHost),
    neither: resolveRef('nope', ticketSource, codeHost),
    both: resolveRef('FAKE-1', ticketSource, greedy),
    written: states.filter((state) => existsSync(state)),
  }).toEqual({
    ticket: { kind: 'ticket', ticketKey: 'FAKE-1' },
    url: { kind: 'ticket', ticketKey: 'FAKE-2' },
    hash: { kind: 'pr', number: 3 },
    bare: { kind: 'pr', number: 3 },
    pull: { kind: 'pr', number: 3 },
    neither: {
      refused:
        "'nope' is neither a ticket of the fake ticket source (a ticket key, or a URL it owns) nor a pull request of the fake code host (#<number>, or its URL)",
    },
    both: {
      refused:
        "'FAKE-1' reads as ticket FAKE-1 on the fake ticket source and as pull request #12 on the greedy code host: name it as a ticket key, or as #12 or its URL",
    },
    written: [],
  });
});

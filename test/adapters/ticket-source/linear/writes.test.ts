// The writes (TASK-005): claim, update and comment. Each emits its event only when it happened, a claim of a started
// ticket writes nothing, and the team's states are read once per process.
import { expect, test } from 'bun:test';
import { createLinearTicketSource } from '../../../../src/adapters/ticket-source/linear/index';
import type { TicketMove, TicketStateType } from '../../../../src/ports/types';
import { createLinearWorld, type WorldIssue } from '../../../helpers/linear-world';
import { captureEvents, messageOf, portFailure, rejection } from '../../../helpers/ports';

const KEY = 'lin_api_SENTINEL-write-key';
const ISSUE = (identifier: string, state: string): WorldIssue => ({
  identifier,
  title: `Ticket ${identifier}`,
  state,
  labels: ['sail'],
});

/** The adapter for the ADW team over `world`, with what it emits, and `inReviewState` when one is given. */
function adapterOver(world: ReturnType<typeof createLinearWorld>, inReviewState?: string) {
  const capture = captureEvents();
  const adapter = createLinearTicketSource({
    apiKey: KEY,
    team: 'ADW',
    fetch: world.transport,
    emit: capture.emit,
    ...(inReviewState === undefined ? {} : { inReviewState }),
  });
  return { adapter, capture };
}

const writesOf = (world: ReturnType<typeof createLinearWorld>) =>
  world.requests.filter((sent) => sent.operation === 'UpdateIssue');

test.each(['Todo', 'Backlog'])(
  'a claim of a %s ticket writes once, and returns and emits the In Progress state',
  async (from) => {
    const world = createLinearWorld({ issues: [ISSUE('ADW-1', from)] });
    const { adapter, capture } = adapterOver(world);
    const claim = await adapter.claim('ADW-1');
    expect({ claimed: claim.claimed, state: claim.state }).toEqual({
      claimed: true,
      state: { type: 'started', name: 'In Progress' },
    });
    expect(writesOf(world).length).toBe(1);
    expect(world.stateOf('ADW-1')).toEqual({ type: 'started', name: 'In Progress' });
    expect(capture.events).toEqual([
      { type: 'ticket:claimed', ticketKey: 'ADW-1', state: { type: 'started', name: 'In Progress' } },
    ]);
  },
);

test.each<[string, TicketStateType]>([
  ['In Progress', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
  ['Duplicate', 'canceled'],
])('a claim of a %s ticket is not taken: it sends no write, and emits nothing', async (name, type) => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', name)] });
  const { adapter, capture } = adapterOver(world);
  const claim = await adapter.claim('ADW-1');
  expect({ claimed: claim.claimed, state: claim.state }).toEqual({ claimed: false, state: { type, name } });
  expect([writesOf(world).length, capture.events]).toEqual([0, []]);
});

test('an update to something that is not a move is invalid, and sends no request at all', async () => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo')] });
  const { adapter } = adapterOver(world);
  const error = await rejection(adapter.update('ADW-1', { state: 'closed' as TicketMove }));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'update', code: 'invalid' });
  expect(world.requests).toEqual([]);
});

test('an in-review move with no inReviewState is invalid, names the option, and sends no write', async () => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo')] });
  const { adapter, capture } = adapterOver(world);
  const error = await rejection(adapter.update('ADW-1', { state: 'in-review' }));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'update', code: 'invalid' });
  expect(messageOf(error)).toContain('inReviewState');
  expect([writesOf(world).length, capture.events]).toEqual([0, []]);
});

test('a move Linear reports as not successful is a conflict, and emits nothing', async () => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo')] });
  world.injectFailure({ status: 200, body: { data: { issueUpdate: { success: false, issue: null } } } }, 'UpdateIssue');
  const { adapter, capture } = adapterOver(world);
  const error = await rejection(adapter.update('ADW-1', { state: 'in-progress' }));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'update', code: 'conflict' });
  expect(capture.events).toEqual([]);
  expect(world.stateOf('ADW-1')).toEqual({ type: 'unstarted', name: 'Todo' });
});

test('a comment returns the id and URL of the comment the world holds, and emits ticket:commented', async () => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo')] });
  const { adapter, capture } = adapterOver(world);
  const posted = await adapter.comment('ADW-1', 'Pull request opened.');
  expect(world.comments('ADW-1')).toHaveLength(1);
  const held = world.comments('ADW-1').at(-1) as { id: string; url: string };
  expect({ id: posted.id, url: posted.url }).toEqual({ id: held.id, url: held.url });
  expect(posted.raw).toBeDefined();
  expect(capture.events).toEqual([{ type: 'ticket:commented', ticketKey: 'ADW-1', body: 'Pull request opened.' }]);
});

test('known race: two claims that both read unstarted both write', async () => {
  // Both claims read the ticket before either writes, so both write. The window is documented in DECISIONS §4, and this
  // test asserts it: a later fix must change it on purpose.
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo')] });
  const { adapter, capture } = adapterOver(world);
  const results = await Promise.all([adapter.claim('ADW-1'), adapter.claim('ADW-1')]);
  expect(results.map((result) => result.claimed)).toEqual([true, true]);
  expect(writesOf(world).length).toBe(2);
  expect(capture.events.map((event) => event.type)).toEqual(['ticket:claimed', 'ticket:claimed']);
});

test('the team states are read once per process, across claims', async () => {
  const world = createLinearWorld({ issues: [ISSUE('ADW-1', 'Todo'), ISSUE('ADW-2', 'Backlog')] });
  const { adapter } = adapterOver(world);
  const first = await adapter.claim('ADW-1');
  const second = await adapter.claim('ADW-2');
  expect([first.claimed, second.claimed]).toEqual([true, true]);
  expect(world.requests.filter((sent) => sent.operation === 'TeamWorkflowStates').length).toBe(1);
});

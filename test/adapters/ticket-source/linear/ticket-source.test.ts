// The shared TicketSource suite for linear (TASK-007), over the scripted world: on the ADW team's own states, and on a
// team whose states are renamed, with the same types. The suite file itself is not changed for linear.
import { describe } from 'bun:test';
import { createLinearTicketSource } from '../../../../src/adapters/ticket-source/linear/index';
import type { ProviderEmit } from '../../../../src/events/types';
import { ADW_STATES, createLinearWorld, type WorldIssue, type WorldState } from '../../../helpers/linear-world';
import { type MakeTicketSource, type TicketWorld, ticketSourceSuite } from '../../../ports/ticket-source.suite';

const KEY = 'lin_api_SENTINEL-suite-key';

const ISSUES: WorldIssue[] = [
  {
    identifier: 'ADW-1',
    title: 'Add a --shout flag to the greet command',
    description: 'Upper-case the greeting.',
    state: 'Todo',
    labels: ['sail'],
    comments: [{ body: 'Keep the name as typed.' }],
  },
  { identifier: 'ADW-2', title: 'Print the version', state: 'In Progress', labels: ['sail'] },
  { identifier: 'ADW-3', title: 'Document greet', state: 'Todo', labels: [] },
];

const RENAMED: WorldState[] = [
  { id: 'state-icebox', name: 'Icebox', type: 'backlog', position: 0 },
  { id: 'state-ready', name: 'Ready', type: 'unstarted', position: 1 },
  { id: 'state-doing', name: 'Doing', type: 'started', position: 2 },
  { id: 'state-review', name: 'Review', type: 'started', position: 3 },
  { id: 'state-shipped', name: 'Shipped', type: 'completed', position: 4 },
  { id: 'state-dropped', name: 'Dropped', type: 'canceled', position: 5 },
  { id: 'state-dupe', name: 'Dupe', type: 'duplicate', position: 6 },
];

const WORLD: TicketWorld = {
  label: 'sail',
  designated: 'ADW-1',
  started: 'ADW-2',
  undesignated: 'ADW-3',
  missing: 'ADW-99',
  refs: [
    ['ADW-1', 'ADW-1'],
    ['https://linear.app/sail-fixture/issue/ADW-1/add-a-shout-flag', 'ADW-1'],
  ],
};

/** A fresh scripted world per case, the adapter over it, and the case's emit. */
function makeOver(states: readonly WorldState[], issues: WorldIssue[], inReviewState: string): MakeTicketSource {
  return async (emit: ProviderEmit) => {
    const world = createLinearWorld({ states, issues });
    const adapter = createLinearTicketSource({
      apiKey: KEY,
      team: 'ADW',
      inReviewState,
      fetch: world.transport,
      emit,
    });
    return { adapter, world: WORLD };
  };
}

// The describe block carries the sticker: the suite file is shared, so its cases can't each carry one.
// biome-ignore format: TDD-PENDING TASK-007
describe
  .skip // TDD-PENDING TASK-007
  ('linear, through the shared suite', () => {
    ticketSourceSuite('linear', makeOver(ADW_STATES, ISSUES, 'In Review'));
    ticketSourceSuite('linear (renamed states)', makeOver(RENAMED, ISSUES.map(renamedIssue), 'Review'));
  });

/** The same tickets, moved onto the renamed states: the same types, under other names. */
function renamedIssue(issue: WorldIssue): WorldIssue {
  const names: Record<string, string> = { Todo: 'Ready', 'In Progress': 'Doing' };
  return { ...issue, state: names[issue.state] ?? issue.state };
}

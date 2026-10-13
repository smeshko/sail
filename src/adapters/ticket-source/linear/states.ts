// The team's workflow states, read once per process: the state each move lands on, by type (ADR-0015).
import { PortError } from '../../../ports/errors';
import type { TicketMove } from '../../../ports/types';
import type { LinearClient } from './client';
import { TEAM_WORKFLOW_STATES } from './queries';

export interface WorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
}

export interface TeamWorkflowStatesData {
  readonly teams: { readonly nodes: readonly { readonly states: { readonly nodes: readonly WorkflowState[] } }[] };
}

export interface TeamStates {
  /**
   * The id of the state `move` lands on: unstarted, the lowest-position unstarted (or backlog) state; in-progress, the
   * lowest-position started state other than `inReviewState`; in-review, the started state named `inReviewState`
   * (a PortError `invalid` when it is absent or not started); done, the lowest-position completed state. `op` names the
   * operation a refusal belongs to.
   */
  targetFor(op: string, move: TicketMove, inReviewState?: string): Promise<string>;
}

const ofType = (states: readonly WorkflowState[], type: string): WorkflowState[] =>
  states.filter((state) => state.type === type);

/** The id of the lowest-position state in `states`, or a PortError `invalid` naming `what` when there is none. */
function lowest(op: string, states: readonly WorkflowState[], what: string): string {
  const [first] = [...states].sort((a, b) => a.position - b.position);
  if (first === undefined) throw new PortError('ticketSource', op, 'invalid', `the team has no ${what} state`);
  return first.id;
}

export function createTeamStates(client: LinearClient, team: string): TeamStates {
  let loaded: Promise<readonly WorkflowState[]> | undefined;

  // Read once: the promise is kept, so concurrent and later callers share it. A failed read is forgotten, so the next
  // call asks again instead of replaying the failure for the rest of the process.
  const load = (op: string): Promise<readonly WorkflowState[]> => {
    loaded ??= client.request('TeamWorkflowStates', TEAM_WORKFLOW_STATES, { team }).then((data) => {
      const [found] = (data as TeamWorkflowStatesData).teams.nodes;
      if (found === undefined) throw new PortError('ticketSource', op, 'not_found', `no team ${team}`);
      return found.states.nodes;
    });
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };

  return {
    async targetFor(op, move, inReviewState) {
      const states = await load(op);
      switch (move) {
        case 'unstarted': {
          const unstarted = ofType(states, 'unstarted');
          return lowest(op, unstarted.length > 0 ? unstarted : ofType(states, 'backlog'), 'unstarted');
        }
        case 'in-progress':
          return lowest(
            op,
            ofType(states, 'started').filter((state) => state.name !== inReviewState),
            'in progress',
          );
        case 'in-review': {
          if (inReviewState === undefined) {
            throw new PortError('ticketSource', op, 'invalid', 'in-review needs the inReviewState option');
          }
          const named = states.find((state) => state.name === inReviewState);
          if (named === undefined || named.type !== 'started') {
            throw new PortError(
              'ticketSource',
              op,
              'invalid',
              `inReviewState ${inReviewState} is not a started state of the team`,
            );
          }
          return named.id;
        }
        case 'done':
          return lowest(op, ofType(states, 'completed'), 'done');
      }
    },
  };
}

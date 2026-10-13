// The team's workflow states, read once per process: the state each move lands on, by type (ADR-0015).
// Stub: the lookup is written in TASK-004 and TASK-005.
import type { TicketMove } from '../../../ports/types';
import type { LinearClient } from './client';

export interface TeamStates {
  /**
   * The id of the state `move` lands on: unstarted, the lowest-position unstarted (or backlog) state; in-progress, the
   * lowest-position started state other than `inReviewState`; in-review, the started state named `inReviewState`
   * (a PortError `invalid` when it is absent or not started); done, the lowest-position completed state.
   */
  targetFor(move: TicketMove, inReviewState?: string): Promise<string>;
}

export function createTeamStates(_client: LinearClient, _team: string): TeamStates {
  return { targetFor: async () => '' };
}

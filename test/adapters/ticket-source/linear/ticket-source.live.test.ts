// The opt-in live contract run (TASK-009): the shared TicketSource suite against Linear's real API and a sandbox team.
// Skipped unless SAIL_LIVE_TICKET_SOURCE=1. Then it reads only process.env, and the caller exports the variables.
//
// Before each run, the sandbox is reset by hand: SAIL_LIVE_DESIGNATED goes back to Todo with the label. The suite claims
// it (In Progress) and then moves it (In Review), so no other ticket is touched. Nothing here prints a key, a ticket's
// text or a response body: the suite's own failure messages are the only output.
import { describe, expect, test } from 'bun:test';
import { createLinearTicketSource } from '../../../../src/adapters/ticket-source/linear/index';
import { portFailure, rejection } from '../../../helpers/ports';
import { type TicketWorld, ticketSourceSuite } from '../../../ports/ticket-source.suite';

const LIVE = process.env.SAIL_LIVE_TICKET_SOURCE === '1';

/** A variable the live run needs, read when the run starts. */
function live(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

describe.skipIf(!LIVE)('linear, live', () => {
  ticketSourceSuite('linear (live)', async (emit) => {
    const designated = live('SAIL_LIVE_DESIGNATED');
    const world: TicketWorld = {
      label: live('SAIL_LIVE_LABEL'),
      designated,
      started: live('SAIL_LIVE_STARTED'),
      undesignated: live('SAIL_LIVE_UNDESIGNATED'),
      missing: live('SAIL_LIVE_MISSING'),
      refs: [[designated, designated]],
    };
    const adapter = createLinearTicketSource({
      apiKey: live('LINEAR_API_KEY'),
      team: live('SAIL_LIVE_LINEAR_TEAM'),
      inReviewState: process.env.SAIL_LIVE_IN_REVIEW_STATE ?? 'In Review',
      emit,
    });
    return { adapter, world };
  });

  test('a deliberately wrong key gets unauthorized from Linear', async () => {
    const adapter = createLinearTicketSource({
      apiKey: 'lin_api_deliberately-wrong-key',
      team: live('SAIL_LIVE_LINEAR_TEAM'),
    });
    const failure = portFailure(await rejection(adapter.get(live('SAIL_LIVE_DESIGNATED'))));
    expect(failure).toMatchObject({ port: 'ticketSource', code: 'unauthorized' });
  });
});

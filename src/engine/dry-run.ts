// A dry run: a start's preflight and nothing after it. TDD stub (TASK-002): it refuses everything.
import type { Ticket } from '../ports/types';
import type { OpenRunOptions } from './open-run';
import type { RunHeader } from './run-header';

/** What a start would freeze: its unclaimed header, the ticket as fetched, and the branch it would lease. */
export interface DryRun {
  header: RunHeader;
  ticket: Ticket;
  branch: string;
}

/** The start's preflight and a read of the branch's lease, or the start's refusal. Nothing is written. */
export async function dryRun(
  _options: Omit<OpenRunOptions, 'dispatch' | 'signal'>,
): Promise<DryRun | { refused: string }> {
  return { refused: 'TDD stub (TASK-002): dryRun() is not written yet' };
}

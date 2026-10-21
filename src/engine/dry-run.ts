// A dry run: a start's preflight and nothing after it. It runs every check `openRun()` runs before it writes, through
// the same `preflightRun()`, so a dry run refuses with the start's own words. Then it asks the Workspace port who holds
// the run's branch, a read that takes no lease, so a leased branch refuses as a start would. It writes nothing: no run
// directory, workspace, lease, claim or comment. Like a start, it claims the `.sail/` for the process.
import { PortError } from '../ports/errors';
import type { Ticket } from '../ports/types';
import { leasedBy, type OpenRunOptions, preflightRun } from './open-run';
import type { RunHeader } from './run-header';

/** What a start would freeze: its unclaimed header, the ticket as fetched, and the branch it would lease. */
export interface DryRun {
  header: RunHeader;
  ticket: Ticket;
  branch: string;
}

/** The start's preflight and a read of the branch's lease, or the start's refusal. Nothing is written. */
export async function dryRun(
  options: Omit<OpenRunOptions, 'dispatch' | 'signal'>,
): Promise<DryRun | { refused: string }> {
  const preflight = await preflightRun(options);
  if ('refused' in preflight) return preflight;
  const { header, branch, resolved } = preflight;
  const port = options.adapters.ports.workspace;
  try {
    const repository = await port.repository();
    const holder = await port.holder(repository.url, branch);
    if (holder !== undefined) return { refused: leasedBy(branch, holder) };
  } catch (error) {
    if (!(error instanceof PortError)) throw error;
    return { refused: `the workspace could not be read: ${error.message} (${error.code})` };
  }
  return { header, ticket: resolved.ticket, branch };
}

// The built-in intakes' bodies: what the engine runs, in process, for an intake `sail/intakes` exports. A body takes the
// run's source, its TicketSource, its CodeHost and its workspace, writes its files into the call directory, and returns the input, unvalidated.
import type { Source } from '../../engine/run-dir';
import type { CodeHost } from '../../ports/code-host';
import type { TicketSource } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import type { Intake } from '../../sdk/intake';
import { pr, ticket } from '../../sdk/intakes';
import { prIntake } from './pr/index';
import { ticketIntake } from './ticket/index';

/** What a built-in intake's body is given. */
export interface IntakeContext {
  /** What the run started from: the run header's `source`. */
  readonly source: Source;
  readonly ticketSource: TicketSource;
  /** The run's CodeHost. Every run has one: only a caller that runs a ticket intake alone leaves it out. */
  readonly codeHost?: CodeHost;
  /** The run's workspace: the port, and the absolute path of the run's worktree. Left out as `codeHost` is. */
  readonly workspace?: { readonly port: WorkspacePort; readonly path: string };
  /** The prefix a ticket's branch is named with, which a pull request's ticket marker is checked against. */
  readonly branchPrefix?: string;
  /** The absolute call directory, where the body leaves its files. */
  readonly out: string;
  readonly signal?: AbortSignal;
}

/** A built-in intake's body. A failed port call leaves it as a PortError, and anything else it throws is a bug in sail. */
export type IntakeBody = (context: IntakeContext) => Promise<unknown>;

/** Each built-in intake, as `sail/intakes` exports it, to its body. */
export const BUILTIN_INTAKES: ReadonlyMap<Intake, IntakeBody> = new Map<Intake, IntakeBody>([
  [ticket, ticketIntake],
  [pr, prIntake],
]);

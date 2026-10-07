// The built-in intakes' bodies: what the engine runs, in process, for an intake `sail/intakes` exports. A body takes the
// run's source and its TicketSource, writes its files into the call directory, and returns the input, unvalidated.
import type { Source } from '../../engine/run-dir';
import type { TicketSource } from '../../ports/ticket-source';
import type { Intake } from '../../sdk/intake';
import { ticket } from '../../sdk/intakes';
import { ticketIntake } from './ticket/index';

/** What a built-in intake's body is given. */
export interface IntakeContext {
  /** What the run started from: the run header's `source`. */
  readonly source: Source;
  readonly ticketSource: TicketSource;
  /** The absolute call directory, where the body leaves its files. */
  readonly out: string;
  readonly signal?: AbortSignal;
}

/** A built-in intake's body. A failed port call leaves it as a PortError, and anything else it throws is a bug in sail. */
export type IntakeBody = (context: IntakeContext) => Promise<unknown>;

/** Each built-in intake, as `sail/intakes` exports it, to its body. */
export const BUILTIN_INTAKES: ReadonlyMap<Intake, IntakeBody> = new Map<Intake, IntakeBody>([[ticket, ticketIntake]]);

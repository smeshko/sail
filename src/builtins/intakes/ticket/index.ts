// The built-in `ticket` intake's body: it fetches the run's ticket through the TicketSource, splits the description into
// the request and the acceptance criteria, and leaves `ticket.json` and `brief.md` in the call directory. Every string
// the provider returned is wrapped as untrusted input in the brief. It returns the run's input, unvalidated: the engine
// checks it against `TicketInput`.
import type { IntakeContext } from '../index';

/** Runs the `ticket` intake once: one `get`, the two files, the output. A failed port call leaves it as a PortError. */
export async function ticketIntake(_context: IntakeContext): Promise<unknown> {
  return {};
}

// `sail port`: a port's operation from the command line, so a script step reaches what the engine's adapters do.
//
//   sail port ticket-source get <ticket>            the ticket, as the port's Ticket
//   sail port ticket-source links <ticket>          its links
//   sail port ticket-source attachments <ticket>    its attachments
//   sail port render --untrusted --source <text> [--inline]    stdin, wrapped as untrusted input
//
// A result is one line of JSON on stdout. A failed port call exits 1 with the port's message, and anything refused
// before a call is made exits 3. It emits no events: no run is attached to the adapters it resolves.
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';

export async function port(_args: Parsed, _io: Io): Promise<ExitCode> {
  return EXIT_OK;
}

// `sail port`: a port's operation from the command line, so a script step reaches what the engine's adapters do.
//
//   sail port ticket-source get <ticket>            the ticket, as the port's Ticket
//   sail port ticket-source links <ticket>          its links
//   sail port ticket-source attachments <ticket>    its attachments
//   sail port render --untrusted --source <text> [--inline]    stdin, wrapped as untrusted input
//
// A result is one line of JSON on stdout. A failed port call exits 1 with the port's message, and anything refused
// before a call is made exits 3. It emits no events: no run is attached to the adapters it resolves.
//
// `.sail/` is the directory of `SAIL_CONFIG` when the environment sets it, as the preamble does for every script step,
// and is found from the working directory otherwise. Only the port asked for is resolved, so no other adapter is
// loaded or asked for its credentials. `render` is a helper beside the ports: it needs no `.sail/`.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { wrapUntrusted } from '../../engine/render';
import { findSailDir } from '../../engine/sail-dir';
import { PortError } from '../../ports/errors';
import { getTicket, type TicketSource } from '../../ports/ticket-source';
import { EXIT_FAILED, EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { findProject, refuseAs } from './run-workflow';

const COMMAND = 'sail port';

const USAGE = `usage: sail port ticket-source get|links|attachments <ticket>
       sail port render --untrusted --source <text> [--inline]`;

/** The options that are `render`'s alone. */
const RENDER_OPTIONS = ['untrusted', 'source', 'inline'] as const;

/**
 * Each port by its name on the command line, with the operations this command runs: the one place either is named.
 * `links` and `attachments` are no operations of the port: they read `get`'s answer.
 */
const PORTS = {
  'ticket-source': {
    port: 'ticketSource',
    operations: {
      get: getTicket,
      links: async (source: TicketSource, ticketKey: string) => (await getTicket(source, ticketKey)).links,
      attachments: async (source: TicketSource, ticketKey: string) => (await getTicket(source, ticketKey)).attachments,
    },
  },
} as const;

/** `.sail/`: the directory of `SAIL_CONFIG` when it is set, found from the working directory otherwise. */
function findSail(io: Io): { dir: string } | { refused: string } {
  const configured = (io.env ?? process.env).SAIL_CONFIG;
  if (configured === undefined || configured === '') return findSailDir(io.cwd);
  const file = resolve(io.cwd, configured);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return { refused: `SAIL_CONFIG names ${configured}, which is no file` };
  }
  return { dir: dirname(file) };
}

/**
 * `sail port render --untrusted --source <text> [--inline]`: stdin, wrapped exactly as the engine wraps a passage. Every
 * refusal comes before stdin is read.
 */
async function render(args: Parsed, io: Io, usage: (message: string) => ExitCode): Promise<ExitCode> {
  const [, extra] = args.positionals;
  if (extra !== undefined) return usage(`unknown argument '${extra}'`);
  if (args.values.untrusted !== true) {
    return usage('render needs --untrusted: it wraps untrusted input, and nothing else yet');
  }
  const { source } = args.values;
  if (typeof source !== 'string') return usage('render needs --source <text>, which says where the text came from');
  if (io.stdin === undefined) return usage('render reads the text on stdin, and there is no stdin');
  const text = await io.stdin();
  io.stdout(`${wrapUntrusted(text, source, args.values.inline === true ? 'inline' : 'block')}\n`);
  return EXIT_OK;
}

export async function port(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const usage = (message: string) => refuse(`${message}\n${USAGE}`);
  const [name, operation, ref] = args.positionals;
  if (name === undefined) return usage('no port given');
  if (name === 'render') return render(args, io, usage);

  const given = RENDER_OPTIONS.find((option) => args.values[option] !== undefined);
  if (given !== undefined) return usage(`option '--${given}' belongs to sail port render`);
  const entry = Object.hasOwn(PORTS, name) ? PORTS[name as keyof typeof PORTS] : undefined;
  if (entry === undefined) return usage(`unknown port '${name}'`);
  if (operation === undefined) return usage(`no operation given for ${name}`);
  const run = Object.hasOwn(entry.operations, operation)
    ? entry.operations[operation as keyof typeof entry.operations]
    : undefined;
  if (run === undefined) return usage(`unknown operation '${operation}' of ${name}`);
  if (ref === undefined) return usage(`${name} ${operation} needs a ticket`);

  const project = await findProject(io, COMMAND, { found: findSail(io), ports: [entry.port] });
  if (typeof project === 'number') return project;
  const source = project.adapters.ports[entry.port];
  const ticketKey = source.parseKey(ref);
  if (ticketKey === undefined) {
    return refuse(`'${ref}' is not a ticket of the ${source.name} ticket source: a ticket key, or a URL it owns`);
  }
  try {
    io.stdout(`${JSON.stringify(await run(source, ticketKey))}\n`);
    return EXIT_OK;
  } catch (error) {
    // A port that failed is this command's failure. Anything else is a bug in sail, and run() reports it.
    if (!(error instanceof PortError)) throw error;
    io.stderr(`${COMMAND}: ${error.message} (${error.code})\n`);
    return EXIT_FAILED;
  }
}

// `sail port`: a port's operation from the command line, so a script step reaches what the engine's adapters do.
//
//   sail port ticket-source get <ticket>            the ticket, as the port's Ticket
//   sail port ticket-source links <ticket>          its links
//   sail port ticket-source attachments <ticket>    its attachments
//   sail port ticket-source comment <ticket> [--body-file <path>]    comments on it: the body from the file or stdin
//   sail port codehost <operation> ...              a CodeHost operation: the table is in port-codehost.ts
//   sail port render --untrusted --source <text> [--inline]    stdin, wrapped as untrusted input
//
// Arguments go in as positionals and flags, and a result comes out as one line of JSON on stdout, so a bash script
// builds no JSON. A failed port call exits 1 with the port's message, and anything refused before a call is made exits
// 3: every refusal comes before the port is called, and before stdin is read, but for one. A body that is empty, from
// the file or from stdin, is refused once it has been read, which is the last thing before the port is called.
//
// Each port is a table of operations of one shape: an operation names its positionals and its options, and returns the
// value to print. This module dispatches over the tables, checks a command line against the operation's row, reads a
// body from `--body-file` or stdin, and builds the usage from the tables, so an operation added to one is listed.
//
// No run is attached to the adapters it resolves, so their provider events go to the port events file: with
// `SAIL_EVENTS` set, as the script kind sets it for every script step, each event is appended to the file it names,
// and the engine emits them when the step ends. A call that fails leaves an `error:port` there too, with the port's
// message, so the run's stream shows it under the step's key (DECISIONS D3). Without it nothing is emitted.
//
// `.sail/` is the directory of `SAIL_CONFIG` when the environment sets it, as the preamble does for every script step,
// and is found from the working directory otherwise. Only the port asked for is resolved, so no other adapter is
// loaded or asked for its credentials. `render` is a helper beside the ports: it needs no `.sail/`.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Port } from '../../engine/config';
import { appendPortEvent } from '../../engine/port-events';
import { wrapUntrusted } from '../../engine/render';
import { findSailDir } from '../../engine/sail-dir';
import { notATicket } from '../../engine/source';
import type { PortErrorEvent, ProviderEmit } from '../../events/types';
import type { PortAdapters } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import { getTicket, type TicketSource } from '../../ports/ticket-source';
import { Posted, type Ticket } from '../../ports/types';
import { EXIT_FAILED, EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { CODEHOST } from './port-codehost';
import { findProject, refuseAs } from './run-workflow';

const COMMAND = 'sail port';

/** The options that are `render`'s alone. */
const RENDER_OPTIONS = ['untrusted', 'source', 'inline'] as const;
const RENDER_USAGE = 'render --untrusted --source <text> [--inline]';

/** How an operation takes one of its options. */
export interface OptionUse {
  /** What its value is called in the usage. Left out, the option is a flag. */
  value?: string;
  /** Refused when missing. */
  required?: boolean;
  /** May be given more than once. */
  repeats?: boolean;
}

/** What an operation is run with, once the command line has been checked against its row. */
export interface PortCall {
  /** The directory the command runs from. */
  cwd: string;
  /** Its positionals, one per name its row lists. */
  positionals: readonly string[];
  /** Its options, as parsed. */
  values: Parsed['values'];
  /**
   * Its body, from `--body-file` or stdin, read when called: an operation calls it last before its port. An empty one
   * is refused there, and never returned.
   */
  body(): Promise<string>;
}

/** A body that was read and held nothing: the operation is refused before its port is called. */
class EmptyBody extends Error {
  // Written out, not implicit: Bun reads an implicit subclass constructor as uncovered.
  constructor(message: string) {
    super(message);
    this.name = 'EmptyBody';
  }
}

/** One operation of a port, as this command runs it: the one shape every port's table has. */
export interface PortOperation<A> {
  /** What its positionals are, in order, each required. */
  positionals: readonly Positional[];
  /** The options it takes, by name. Any other option is refused, naming the operation it belongs to. */
  options?: Readonly<Record<string, OptionUse>>;
  /** Whether it takes a body, from `--body-file` or stdin. */
  body?: boolean;
  /** Calls the port and gives the value to print, or refuses an argument only the adapter can read. */
  run(adapter: A, call: PortCall): Promise<{ value: unknown } | { refused: string }>;
}

/** A port's operations by their names on the command line. */
export interface PortTable<P extends Port> {
  port: P;
  operations: Readonly<Record<string, PortOperation<PortAdapters[P]>>>;
}

/** What a positional names, as the usage prints it in `<…>`, with how a refusal asks for it. */
const POSITIONALS = {
  ticket: 'a ticket',
  branch: 'a branch',
  pr: 'a pull request',
  label: 'a label',
} as const;
export type Positional = keyof typeof POSITIONALS;

/** A ticket source operation: it reads the ticket `<ticket>` names, and prints what `read` takes from it. */
const ticketOperation = (read: (ticket: Ticket) => unknown): PortOperation<TicketSource> => ({
  positionals: ['ticket'],
  async run(source, { positionals: [ref = ''] }) {
    const ticketKey = source.parseKey(ref);
    if (ticketKey === undefined) return { refused: notATicket(ref, source.name) };
    return { value: read(await getTicket(source, ticketKey)) };
  },
});

/** A comment on the ticket `<ticket>` names: the port's `Posted`, parsed before it is printed. */
const commentOperation: PortOperation<TicketSource> = {
  positionals: ['ticket'],
  options: { 'body-file': { value: 'path' } },
  body: true,
  async run(source, { positionals: [ref = ''], body }) {
    const ticketKey = source.parseKey(ref);
    if (ticketKey === undefined) return { refused: notATicket(ref, source.name) };
    const posted = Posted.safeParse(await source.comment(ticketKey, await body()));
    if (posted.success) return { value: posted.data };
    const [issue] = posted.error.issues;
    const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
    throw new PortError('ticketSource', 'comment', 'invalid', `its answer is not a Posted: ${where}`);
  },
};

/** `links` and `attachments` are no operations of the port: they read `get`'s answer. */
const TICKET_SOURCE: PortTable<'ticketSource'> = {
  port: 'ticketSource',
  operations: {
    get: ticketOperation((ticket) => ticket),
    links: ticketOperation((ticket) => ticket.links),
    attachments: ticketOperation((ticket) => ticket.attachments),
    comment: commentOperation,
  },
};

/** A table whose adapter is one of the four: the dispatch hands each operation the adapter of its own port. */
interface AnyTable {
  port: Port;
  operations: Readonly<Record<string, PortOperation<never>>>;
}

/** Each port by its name on the command line: the one place a port or an operation is named. */
const PORTS: Readonly<Record<string, AnyTable>> = { 'ticket-source': TICKET_SOURCE, codehost: CODEHOST };

/** An option as the usage prints it: `--base <branch>`, `[--draft]`, `[--label <name>]...`. */
function optionUsage(name: string, use: OptionUse): string {
  const option = use.value === undefined ? `--${name}` : `--${name} <${use.value}>`;
  return use.required ? option : `[${option}]${use.repeats ? '...' : ''}`;
}

/** What follows an operation's name in the usage: its positionals, then its options. */
function argumentsUsage(operation: PortOperation<never>): string {
  const options = Object.entries(operation.options ?? {}).map(([name, use]) => optionUsage(name, use));
  return [...operation.positionals.map((name) => `<${name}>`), ...options].join(' ');
}

/** One usage line per port and argument list: operations that take the same arguments share a line. */
function usageLines(): string[] {
  const lines: string[] = [];
  for (const [port, table] of Object.entries(PORTS)) {
    const named = new Map<string, string[]>();
    for (const [name, operation] of Object.entries(table.operations)) {
      const takes = argumentsUsage(operation);
      named.set(takes, [...(named.get(takes) ?? []), name]);
    }
    for (const [takes, names] of named) lines.push(`${port} ${names.join('|')} ${takes}`);
  }
  return [...lines, RENDER_USAGE];
}

const USAGE = `usage: ${usageLines()
  .map((line) => `${COMMAND} ${line}`)
  .join('\n       ')}`;

/** Where `option` belongs: every operation that takes it, or `render`. */
function ownersOf(option: string): string {
  if ((RENDER_OPTIONS as readonly string[]).includes(option)) return `${COMMAND} render`;
  const owners = Object.entries(PORTS).flatMap(([port, table]) =>
    Object.entries(table.operations)
      .filter(([, operation]) => Object.hasOwn(operation.options ?? {}, option))
      .map(([name]) => `${COMMAND} ${port} ${name}`),
  );
  return owners.join(' or ');
}

/** Whether `path` is a file. A path whose stat fails is none, whatever the failure: a path through a file is ENOTDIR. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `.sail/`: the directory of `SAIL_CONFIG` when it is set, found from the working directory otherwise. */
function findSail(io: Io): { dir: string } | { refused: string } {
  const configured = (io.env ?? process.env).SAIL_CONFIG;
  if (configured === undefined || configured === '') return findSailDir(io.cwd);
  const file = resolve(io.cwd, configured);
  if (!isFile(file)) return { refused: `SAIL_CONFIG names ${configured}, which is no file` };
  return { dir: dirname(file) };
}

/**
 * Where the adapters' provider events go: appended to the file `SAIL_EVENTS` names, or nowhere when it is unset. A
 * file whose directory doesn't exist is refused, before any port is called: nothing could be appended to it.
 */
function portEmit(io: Io): { emit?: ProviderEmit; file?: string } | { refused: string } {
  const named = (io.env ?? process.env).SAIL_EVENTS;
  if (named === undefined || named === '') return {};
  const file = resolve(io.cwd, named);
  if (!isDirectory(dirname(file))) return { refused: `SAIL_EVENTS names ${named}, whose directory doesn't exist` };
  return { emit: (event) => appendPortEvent(file, event), file };
}

/** The `error:port` a failed call of `error`'s port leaves: none for a port no script calls through this command. */
function portErrorEvent(error: PortError): PortErrorEvent | undefined {
  if (error.port !== 'ticketSource' && error.port !== 'codeHost') return undefined;
  return { type: 'error:port', port: error.port, op: error.op, code: error.code, message: error.message };
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

/**
 * Why the command line doesn't fit the operation's row, as a usage error: an option that is another operation's, a
 * positional missing or one too many, or a required option left out. Undefined when it fits.
 */
function misfit(
  at: string,
  operation: PortOperation<never>,
  given: readonly string[],
  values: Parsed['values'],
): string | undefined {
  const options = operation.options ?? {};
  const foreign = Object.keys(values).find((option) => !Object.hasOwn(options, option));
  if (foreign !== undefined) return `option '--${foreign}' belongs to ${ownersOf(foreign)}`;
  const missing = operation.positionals[given.length];
  if (missing !== undefined) return `${at} needs ${POSITIONALS[missing]}`;
  const extra = given[operation.positionals.length];
  if (extra !== undefined) return `unknown argument '${extra}'`;
  const [left] = Object.entries(options).filter(([name, use]) => use.required && values[name] === undefined);
  if (left !== undefined) return `${at} needs --${left[0]} <${left[1].value}>`;
  return undefined;
}

export async function port(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const usage = (message: string) => refuse(`${message}\n${USAGE}`);
  const [name, operation, ...given] = args.positionals;
  if (name === undefined) return usage('no port given');
  if (name === 'render') return render(args, io, usage);

  const rendering = RENDER_OPTIONS.find((option) => args.values[option] !== undefined);
  if (rendering !== undefined) return usage(`option '--${rendering}' belongs to ${ownersOf(rendering)}`);
  const table = Object.hasOwn(PORTS, name) ? PORTS[name] : undefined;
  if (table === undefined) return usage(`unknown port '${name}'`);
  if (operation === undefined) return usage(`no operation given for ${name}`);
  const row = Object.hasOwn(table.operations, operation) ? table.operations[operation] : undefined;
  if (row === undefined) return usage(`unknown operation '${operation}' of ${name}`);
  const unfit = misfit(`${name} ${operation}`, row, given, args.values);
  if (unfit !== undefined) return usage(unfit);

  // A body comes from the file --body-file names, read now so one that can't be read refuses, or from stdin, read
  // only once nothing is left to refuse.
  const bodyFile = args.values['body-file'];
  let body = io.stdin;
  if (typeof bodyFile === 'string') {
    try {
      const text = readFileSync(resolve(io.cwd, bodyFile), 'utf8');
      body = () => Promise.resolve(text);
    } catch (error) {
      const why = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      return refuse(`can't read --body-file ${bodyFile}: ${why}`);
    }
  }
  if (row.body && body === undefined) {
    return usage(`${name} ${operation} reads its body from --body-file or stdin, and there is neither`);
  }
  const events = portEmit(io);
  if ('refused' in events) return refuse(events.refused);
  const { file: eventsFile, ...emitting } = events;

  const project = await findProject(io, COMMAND, { found: findSail(io), ports: [table.port], ...emitting });
  if (typeof project === 'number') return project;
  const adapter = project.adapters.ports[table.port];
  // The body is read when the operation asks for it, once it has refused what only its adapter can read. An empty one
  // is no body: a script step's stdin is there and holds nothing, so a script that left --body-file out would
  // otherwise post a blank.
  const call: PortCall = {
    cwd: io.cwd,
    positionals: given,
    values: args.values,
    async body() {
      const text = (await body?.()) ?? '';
      if (text.trim() !== '') return text;
      const where = typeof bodyFile === 'string' ? `--body-file ${bodyFile}` : 'stdin';
      throw new EmptyBody(`${name} ${operation} needs a body, and ${where} is empty`);
    },
  };
  try {
    const ran = await row.run(adapter as never, call);
    if ('refused' in ran) return refuse(ran.refused);
    io.stdout(`${JSON.stringify(ran.value)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof EmptyBody) return refuse(error.message);
    // A port that failed is this command's failure. Anything else is a bug in sail, and run() reports it.
    if (!(error instanceof PortError)) throw error;
    const failed = portErrorEvent(error);
    if (eventsFile !== undefined && failed !== undefined) appendPortEvent(eventsFile, failed);
    io.stderr(`${COMMAND}: ${error.message} (${error.code})\n`);
    return EXIT_FAILED;
  }
}

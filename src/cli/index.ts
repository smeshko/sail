import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import type { Tty } from '../events/consumers/screen';
import { check } from './commands/check';
import { port } from './commands/port';
import { resume } from './commands/resume';
import { runWorkflowCommand } from './commands/run-workflow';
import { runs } from './commands/runs';
import { show } from './commands/show';
import { stageRun } from './commands/stage-run';
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from './exit-codes';

export interface Io {
  /** The directory the command runs from. */
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Calls `handler` on Ctrl+C or SIGTERM instead of exiting, until the returned function unregisters it. */
  onInterrupt?(handler: () => void): () => void;
  /** Present when stdout is an interactive terminal: colour and the live line. */
  tty?: Tty;
  /** The environment the command runs in. Falls back to `process.env` when left out. */
  env?: Readonly<Record<string, string | undefined>>;
  /** All of stdin, as text. Present when the command may read it. */
  stdin?: () => Promise<string>;
}

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail <ticket> [--workflow <name>] [--force] [--until <stage>] [-q|-v|-vv]
                                                             Start a run from a ticket: its key, or its URL
  sail check [--list]                                        Type-check .sail/ and list its workflows and stages
  sail resume <run> [-q|-v|-vv]                              Resume a suspended or crashed run
  sail runs                                                  List the runs in .sail-runs/
  sail show <run> [--events|--follow|--rebuild] [-q|-v|-vv]  Show a run's calls, loops, routes and totals
  sail stage run <stage-dir> [--bind name=value]...          Run one stage in isolation
  sail port ticket-source get|links|attachments <ticket>     Print a ticket, its links or its attachments as JSON
  sail port render --untrusted --source <text> [--inline]    Wrap stdin as untrusted input
  sail --version                                             Print the version
  sail --help                                                Print this help

Starting a run from a ticket:
  --force          Runs a ticket that is not designated, or not unstarted, and records which check it overrode
  --until <stage>  Stops the run after that stage's first call, suspended: sail resume takes it to its end

Output of a run and a resume:
  -q, --quiet    Only the run's start, its errors and the final block
  -v, --verbose  Adds contract details, routes and every script's output tail; -vv prints every event
`;

interface OptionSpec {
  type: 'boolean' | 'string';
  multiple?: boolean;
  short?: string;
}

/** What a command takes: its options by name, and the most positionals it accepts. */
export interface CommandSpec {
  options: Readonly<Record<string, OptionSpec>>;
  positionals: number;
  command: Command;
}

/**
 * A command's arguments, parsed against its spec. A `multiple` option is a list, in the order given, and a `multiple`
 * boolean the number of times it was given.
 */
export interface Parsed {
  values: Record<string, boolean | number | string | string[]>;
  positionals: string[];
}

/** A command gets the arguments after its name, already parsed against its spec. */
export type Command = (args: Parsed, io: Io) => ExitCode | Promise<ExitCode>;

/**
 * Parses a command's arguments against its spec. `parseArgs` runs lenient and hands back tokens, so every refusal is
 * sail's own words rather than Bun's.
 */
export function parseCommandArgs(
  args: readonly string[],
  spec: Pick<CommandSpec, 'options' | 'positionals'>,
): Parsed | { refused: string } {
  const { tokens } = parseArgs({
    args: [...args],
    options: spec.options,
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  const parsed: Parsed = { values: {}, positionals: [] };
  for (const token of tokens) {
    if (token.kind === 'option-terminator') continue;
    if (token.kind === 'positional') {
      if (parsed.positionals.length === spec.positionals) return { refused: `unknown argument '${token.value}'` };
      parsed.positionals.push(token.value);
      continue;
    }
    const option = Object.hasOwn(spec.options, token.name) ? spec.options[token.name] : undefined;
    if (option === undefined) return { refused: `unknown argument '${token.rawName}'` };
    if (option.type === 'boolean') {
      if (token.value !== undefined) return { refused: `option '--${token.name}' takes no value` };
      // A `multiple` boolean counts: `-vv` is 2.
      const previous = parsed.values[token.name];
      parsed.values[token.name] = option.multiple ? (typeof previous === 'number' ? previous : 0) + 1 : true;
      continue;
    }
    if (token.value === undefined) return { refused: `option '--${token.name}' needs a value` };
    const previous = parsed.values[token.name];
    parsed.values[token.name] = option.multiple
      ? [...(Array.isArray(previous) ? previous : []), token.value]
      : token.value;
  }
  return parsed;
}

const help: Command = (_, io) => {
  io.stdout(USAGE);
  return EXIT_OK;
};

const version: Command = (_, io) => {
  io.stdout(`${pkg.version}\n`);
  return EXIT_OK;
};

const bare = (command: Command): CommandSpec => ({ options: {}, positionals: 0, command });

/** How much of a run `sail <ticket>`, `sail resume` and `sail show --events` print: `-q`, or `-v` given once or twice. */
const VERBOSITY_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
};

/** Each command, with what it takes. Anything else after its name is refused. */
const commands = new Map<string, CommandSpec>([
  ['check', { options: { list: { type: 'boolean' } }, positionals: 0, command: check }],
  ['resume', { options: VERBOSITY_OPTIONS, positionals: 1, command: resume }],
  ['runs', bare(runs)],
  [
    'show',
    {
      options: {
        events: { type: 'boolean' },
        follow: { type: 'boolean' },
        rebuild: { type: 'boolean' },
        ...VERBOSITY_OPTIONS,
      },
      positionals: 1,
      command: show,
    },
  ],
  ['stage', { options: { bind: { type: 'string', multiple: true } }, positionals: 2, command: stageRun }],
  [
    'port',
    {
      options: { untrusted: { type: 'boolean' }, source: { type: 'string' }, inline: { type: 'boolean' } },
      positionals: 3,
      command: port,
    },
  ],
  ['--help', bare(help)],
  ['-h', bare(help)],
  ['--version', bare(version)],
]);

/** `sail <ticket>`: what starts a run. The ticket is its one positional, so it is parsed with the options after it. */
const TICKET: CommandSpec = {
  options: {
    workflow: { type: 'string' },
    force: { type: 'boolean' },
    until: { type: 'string' },
    ...VERBOSITY_OPTIONS,
  },
  positionals: 1,
  command: runWorkflowCommand,
};

const refuse = (io: Io, message: string): ExitCode => {
  io.stderr(`sail: ${message}\nRun 'sail --help' for usage.\n`);
  return EXIT_REFUSED;
};

/**
 * Runs the command the first argument names. A first argument that names none and doesn't read as an option is the
 * ticket a run starts from, so a mistyped command is refused as one the ticket source doesn't know.
 */
export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [first, ...rest] = argv;
  const named = first === undefined ? bare(help) : commands.get(first);
  if (named === undefined && first?.startsWith('-')) return refuse(io, `unknown argument '${first}'`);
  const entry = named ?? TICKET;
  const args = parseCommandArgs(named === undefined ? argv : rest, entry);
  if ('refused' in args) return refuse(io, args.refused);
  try {
    return await entry.command(args, io);
  } catch (error) {
    // Anything a command throws is a bug in sail, never a refusal: report it and exit 4, not an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack !== undefined ? `${error.stack}\n` : '';
    io.stderr(`sail: internal error: ${message}\n${stack}`);
    return EXIT_INTERNAL;
  }
}

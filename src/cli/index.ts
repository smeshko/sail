import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import type { Tty } from '../events/consumers/screen';
import { check } from './commands/check';
import { resume } from './commands/resume';
import { runWorkflowCommand } from './commands/run-workflow';
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
}

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail check [--list]                                        Type-check .sail/ and list its workflows and stages
  sail run [--workflow <name>] [--input <json>] [-q|-v|-vv]  Run a workflow in this repository
  sail resume <run> [--input <json>] [-q|-v|-vv]             Resume a suspended or crashed run
  sail stage run <stage-dir> [--bind name=value]...          Run one script stage in isolation
  sail --version                                             Print the version
  sail --help                                                Print this help

Output of run and resume:
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

/** How much of a run `sail run` and `sail resume` print: `-q`, or `-v` given once or twice. */
const VERBOSITY_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
};

/** Each command, with what it takes. Anything else after its name is refused. */
const commands = new Map<string, CommandSpec>([
  ['check', { options: { list: { type: 'boolean' } }, positionals: 0, command: check }],
  [
    'run',
    {
      options: { workflow: { type: 'string' }, input: { type: 'string' }, ...VERBOSITY_OPTIONS },
      positionals: 0,
      command: runWorkflowCommand,
    },
  ],
  ['resume', { options: { input: { type: 'string' }, ...VERBOSITY_OPTIONS }, positionals: 1, command: resume }],
  ['stage', { options: { bind: { type: 'string', multiple: true } }, positionals: 2, command: stageRun }],
  ['--help', bare(help)],
  ['-h', bare(help)],
  ['--version', bare(version)],
]);

const refuse = (io: Io, message: string): ExitCode => {
  io.stderr(`sail: ${message}\nRun 'sail --help' for usage.\n`);
  return EXIT_REFUSED;
};

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [first, ...rest] = argv;
  const entry = first === undefined ? bare(help) : commands.get(first);
  if (entry === undefined) return refuse(io, `unknown argument '${first}'`);
  const args = parseCommandArgs(rest, entry);
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

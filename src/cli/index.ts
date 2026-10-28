import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import type { KeepAwake } from '../engine/keep-awake';
import type { Tty } from '../events/consumers/screen';
import { check } from './commands/check';
import { dashboard } from './commands/dashboard';
import { fromRun } from './commands/from-run';
import { init } from './commands/init';
import { port } from './commands/port';
import { queue } from './commands/queue';
import { resume } from './commands/resume';
import { runWorkflowCommand } from './commands/run-workflow';
import { runs } from './commands/runs';
import { show } from './commands/show';
import { stageRun } from './commands/stage-run';
import { stop } from './commands/stop';
import { unwatch, watch } from './commands/watch';
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
  /** The `tsc` the type-check runs. Falls back to TypeScript's own. */
  tsc?: string;
  /** What holds the machine awake while a run, or a stage run alone, is going. Falls back to `systemKeepAwake(io.env)`. */
  keepAwake?: KeepAwake;
}

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail <ticket> [--workflow <name>] [--force] [--until <stage>] [-q|-v|-vv]
                                                             Start a run from a ticket: its key, or its URL
  sail '#<pr>' [--workflow <name>] [--force] [-q|-v|-vv]     Start a run from a pull request: #12, 12, or its URL
  sail init                                                  Write .sail/ here: a config and the editor's setup, no workflow
  sail check [--list]                                        Type-check .sail/ and list its workflows and stages
  sail resume <run> [-q|-v|-vv]                              Resume a suspended or crashed run
  sail stop <run>                                            Stop a run: at its next call boundary while it runs, at once when it is suspended
  sail run --from-run <run> --stage <stage> [--continue]     Rerun one stage on another run's earlier calls: a seeded run
  sail runs                                                  List the runs in .sail-runs/
  sail show <run> [--events|--follow|--rebuild] [-q|-v|-vv]  Show a run's calls, loops, routes and totals
  sail stage run <stage-dir> [--bind name=value]...          Run one stage in isolation
  sail dashboard [--port <n>]                                Serve every repository's runs and queues on localhost
  sail watch <workflow>...                                   Watch these workflows: start this repository's watcher, or add them to it
  sail unwatch <workflow>...                                 Stop watching them. The watcher exits when it watches none
  sail queue ls|poll <workflow>                              List a watched workflow's queue, or have its watcher poll it now
  sail queue add <workflow> <ticket> [--force]               Queue a ticket through the watcher: --force skips its checks
  sail queue requeue|drop <workflow> <item>                  Queue a parked item again, or drop it, through the watcher
  sail queue move <workflow> <item> --before|--after <item>  Move a queued item through the watcher
  sail port ticket-source get|links|attachments <ticket>     Print a ticket, its links or its attachments as JSON
  sail port ticket-source list [--state <unstarted|started|completed|canceled>] [--label <name>]
                                                             List the team's tickets by state and label, as JSON
  sail port ticket-source comment <ticket> [--body-file <path>]
                                                             Comment on a ticket, the body from the file or stdin
  sail port ticket-source update <ticket> --state <unstarted|in-progress|in-review|done|canceled>
                                                             Move a ticket to that state
  sail port ticket-source create --title <text> [--label <name>]... [--body-file <path>]
                                                             File a new ticket, the description from the file or stdin
  sail port ticket-source add-label|remove-label <ticket> <label>
                                                             Add the team's label to a ticket, or remove it
  sail port ticket-source relate <ticket> --kind <related|blocks|duplicate> --to <ticket>
                                                             Relate a ticket to another; a duplicate is closed
  sail port ticket-source edit <ticket> [--title <text>] [--body-file <path>]
                                                             Set a ticket's description from the file or stdin, and its title
  sail port ticket-source attach <ticket> --file <path> [--title <text>] [--content-type <type>]
                                                             Upload a file and attach it to a ticket
  sail port codehost <operation> [arguments]                 Run a code host operation: sail port codehost lists them
  sail port render --untrusted --source <text> [--inline]    Wrap stdin as untrusted input
  sail --version                                             Print the version
  sail --help                                                Print this help

Starting a run from a ticket:
  --force          Runs a ticket that is not designated, or not in a pick-up state, and records which check it overrode; a pull request that is unlabelled, closed or a draft
  --until <stage>  Stops the run after that stage's first call, suspended: sail resume takes it to its end
  --dry-run        Runs every check a start runs and prints the roster it would freeze; writes nothing
  --record <dir>   Writes each agent session to <dir> as a recording; sail resume takes it too

Resuming a run:
  --raise-budget <usd>       Adds that many dollars to the run's budget, for a run suspended over it
  --raise-minutes <minutes>  Adds that many minutes to the run's budget

A seeded run:
  --continue  Runs the rest of the workflow after the stage, not just the stage

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
  ['dashboard', { options: { port: { type: 'string' } }, positionals: 0, command: dashboard }],
  ['init', bare(init)],
  [
    'resume',
    {
      options: {
        ...VERBOSITY_OPTIONS,
        record: { type: 'string' },
        'raise-budget': { type: 'string' },
        'raise-minutes': { type: 'string' },
      },
      positionals: 1,
      command: resume,
    },
  ],
  [
    'run',
    {
      options: {
        'from-run': { type: 'string' },
        stage: { type: 'string' },
        continue: { type: 'boolean' },
        ...VERBOSITY_OPTIONS,
      },
      positionals: 0,
      command: fromRun,
    },
  ],
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
      options: {
        untrusted: { type: 'boolean' },
        source: { type: 'string' },
        inline: { type: 'boolean' },
        base: { type: 'string' },
        head: { type: 'string' },
        title: { type: 'string' },
        'body-file': { type: 'string' },
        draft: { type: 'boolean' },
        ticket: { type: 'string' },
        label: { type: 'string', multiple: true },
        method: { type: 'string' },
        'expected-head-sha': { type: 'string' },
        state: { type: 'string' },
        file: { type: 'string' },
        'content-type': { type: 'string' },
        kind: { type: 'string' },
        to: { type: 'string' },
      },
      positionals: 4,
      command: port,
    },
  ],
  ['watch', { options: {}, positionals: Number.POSITIVE_INFINITY, command: watch }],
  ['unwatch', { options: {}, positionals: Number.POSITIVE_INFINITY, command: unwatch }],
  [
    'queue',
    {
      options: { force: { type: 'boolean' }, before: { type: 'string' }, after: { type: 'string' } },
      positionals: 3,
      command: queue,
    },
  ],
  ['stop', { options: {}, positionals: 1, command: stop }],
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
    'dry-run': { type: 'boolean' },
    record: { type: 'string' },
    // The watcher's: the run id it minted for the run it dispatches. Not in USAGE.
    dispatch: { type: 'string' },
    // The watcher's too: the head sha the pull request it dispatches was queued at. Not in USAGE.
    'head-sha': { type: 'string' },
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

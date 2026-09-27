import pkg from '../../package.json' with { type: 'json' };
import { check } from './commands/check';
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from './exit-codes';

export interface Io {
  /** The directory the command runs from. */
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail check [--list]   Type-check .sail/ and list its workflows and stages
  sail --version        Print the version
  sail --help           Print this help
`;

/** A command gets the arguments after its name, already checked against the flags it takes. */
type Command = (args: readonly string[], io: Io) => ExitCode | Promise<ExitCode>;

const help: Command = (_, io) => {
  io.stdout(USAGE);
  return EXIT_OK;
};

const version: Command = (_, io) => {
  io.stdout(`${pkg.version}\n`);
  return EXIT_OK;
};

/** Each command, with the flags it takes. Any other argument after its name is refused. */
const commands = new Map<string, { flags: readonly string[]; command: Command }>([
  ['check', { flags: ['--list'], command: check }],
  ['--help', { flags: [], command: help }],
  ['-h', { flags: [], command: help }],
  ['--version', { flags: [], command: version }],
]);

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [first, ...args] = argv;
  const entry = first === undefined ? { flags: [], command: help } : commands.get(first);
  const unknown = entry === undefined ? first : args.find((arg) => !entry.flags.includes(arg));
  if (entry === undefined || unknown !== undefined) {
    io.stderr(`sail: unknown argument '${unknown}'\nRun 'sail --help' for usage.\n`);
    return EXIT_REFUSED;
  }
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

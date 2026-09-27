import pkg from '../../package.json' with { type: 'json' };
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from './exit-codes';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail --version   Print the version
  sail --help      Print this help
`;

type Command = (io: Io) => ExitCode | Promise<ExitCode>;

const help: Command = (io) => {
  io.stdout(USAGE);
  return EXIT_OK;
};

const commands = new Map<string, Command>([
  ['--help', help],
  ['-h', help],
  [
    '--version',
    (io) => {
      io.stdout(`${pkg.version}\n`);
      return EXIT_OK;
    },
  ],
]);

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [first, ...rest] = argv;
  const command = first === undefined ? help : commands.get(first);
  const unknown = command === undefined ? first : rest[0];
  if (command === undefined || unknown !== undefined) {
    io.stderr(`sail: unknown argument '${unknown}'\nRun 'sail --help' for usage.\n`);
    return EXIT_REFUSED;
  }
  try {
    return await command(io);
  } catch (error) {
    // Anything a command throws is a bug in sail, never a refusal: report it and exit 4, not an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack !== undefined ? `${error.stack}\n` : '';
    io.stderr(`sail: internal error: ${message}\n${stack}`);
    return EXIT_INTERNAL;
  }
}

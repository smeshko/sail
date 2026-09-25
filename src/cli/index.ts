import pkg from '../../package.json' with { type: 'json' };

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Refused before the run started. Exit 2 means a run is suspended, so usage errors never use it. */
const EXIT_REFUSED = 3;

const USAGE = `sail: a software factory. A ticket goes in and a pull request comes out.

Usage:
  sail --version   Print the version
  sail --help      Print this help
`;

type Command = (io: Io) => number;

const help: Command = (io) => {
  io.stdout(USAGE);
  return 0;
};

const commands = new Map<string, Command>([
  ['--help', help],
  ['-h', help],
  [
    '--version',
    (io) => {
      io.stdout(`${pkg.version}\n`);
      return 0;
    },
  ],
]);

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) return help(io);
  const command = commands.get(first);
  const unknown = command === undefined ? first : rest[0];
  if (command === undefined || unknown !== undefined) {
    io.stderr(`sail: unknown argument '${unknown}'\nRun 'sail --help' for usage.\n`);
    return EXIT_REFUSED;
  }
  return command(io);
}

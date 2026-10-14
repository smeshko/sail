// `sail dashboard [--port N]`. A stub until ADW-120's sixth task: it serves nothing and returns at once.
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';

export const DEFAULT_PORT = 3400;

export async function dashboard(_args: Parsed, _io: Io): Promise<ExitCode> {
  return EXIT_OK;
}

// `sail stop <run>`. Stub: every stop is refused.
import { EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';

export async function stop(_args: Parsed, _io: Io): Promise<ExitCode> {
  return EXIT_REFUSED;
}

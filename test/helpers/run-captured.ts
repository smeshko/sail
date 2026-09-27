// runCaptured(): runs `sail <argv>` in process from `cwd`, capturing what it prints.
import type { ExitCode } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';

export interface Captured {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

export async function runCaptured(argv: readonly string[], cwd: string = process.cwd()): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

#!/usr/bin/env bun
import { run } from './index';
import { quietOnClosedPipe } from './output';
import { detectTty } from './tty';

const tty = detectTty(process.stdout, process.env);

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: quietOnClosedPipe(process.stdout),
  stderr: quietOnClosedPipe(process.stderr),
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  },
  env: process.env,
  stdin: () => Bun.stdin.text(),
  ...(tty === undefined ? {} : { tty }),
});

// Workflow code may still hold timers or I/O handles open after the command ends.
await Promise.all(
  [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))),
);
process.exit(code);

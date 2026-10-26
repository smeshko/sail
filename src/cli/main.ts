#!/usr/bin/env bun
import { run } from './index';
import { quietOnClosedPipe } from './output';
import { detectTty } from './tty';

const tty = detectTty(process.stdout, process.env);

process.exitCode = await run(process.argv.slice(2), {
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
